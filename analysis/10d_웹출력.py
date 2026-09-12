"""3D 뷰용 자료를 웹에서 읽을 수 있는 형태로 내보낸다.

내보내는 것 (dashboard/flood/)
  terrain.png    표고 (R=상위/G=하위 바이트로 담은 16비트, 단위 dm, 오프셋은 meta 에)
  depth_*.png    시나리오별 침수심 (같은 방식, 단위 cm, 0 = 침수 아님)
  texture.jpg    Sentinel-2 TCI 위성영상 (지형 표면에 입힐 텍스처)
  dist.png       본류 하도로부터의 거리 (같은 방식, 단위 m)
  meta.json      격자 크기·좌표범위·스케일·시나리오 요약

왜 PNG 인가: PNG 는 무손실이고 침수심처럼 대부분이 0 인 격자에서 압축이 잘 든다.
float 배열을 그대로 보내는 것보다 훨씬 작다. 단, 브라우저 canvas 가 8비트로만
읽으므로 16비트 값은 R/G 두 채널에 나눠 담는다(save_u16 참조).

실행: .venv/bin/python 10_flood/10d_웹출력.py
"""
import json
import math
import pathlib
import warnings

import numpy as np
import planetary_computer
import pystac_client
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.warp import Resampling, reproject

BASE = pathlib.Path(__file__).resolve().parent
WORK = BASE / "work"
OUT = BASE.parent / "09_manuscript" / "dashboard" / "flood"
OUT.mkdir(parents=True, exist_ok=True)

# 전 구간(93×181 km)을 30 m 로 세우면 정점 2,000만개(700 MB)로 브라우저가 못 버틴다.
# 계산은 30 m 로 하고 화면 격자만 90 m 로 솎는다(정점 220만개, 시범 구간 때와 비슷).
DOWN = 3
# 전 구간은 폭이 93 km 라 10 m/화소면 9,300 화소가 필요하고 용량이 20 MB 를 넘는다.
# 넓게 볼 때의 배경만 담당하면 되고(확대하면 브이월드 항공영상이 덮는다) 3,300 으로 둔다.
TEX_MAX = 2600
MAX_DIST_VIEW = 15000   # 10c 의 판단 반경과 같게 (뷰어 슬라이더 상한)


def main():
    grids = np.load(WORK / "10c_침수격자.npz")
    res = json.loads((WORK / "10c_결과.json").read_text(encoding="utf-8"))
    with rasterio.open(WORK / "dem_5186_30m.tif") as src:
        tf, crs, H, W = src.transform, src.crs, src.height, src.width
        bounds = src.bounds

    dem = grids["dem"]
    # 축소: 표고는 평균, 침수심은 최대(얇은 침수대가 사라지지 않게)
    dem_s = dem if DOWN == 1 else block_reduce(dem, DOWN, np.nanmean)
    h, w = dem_s.shape
    print(f"격자 {W}x{H} -> {w}x{h} (1/{DOWN}), 정점 {w*h:,}개")

    dmin = float(np.nanmin(dem_s))
    # 표고는 cm 로 담으면 16비트를 넘는다(기복 1051 m). 데시미터(10 cm) 로 담는다 —
    # 90 m 격자의 지형 표현에는 10 cm 정밀도로 충분하다.
    dem_dm = np.nan_to_num((dem_s - dmin) * 10, nan=0).round()
    assert dem_dm.max() < 65535, f"표고 범위가 16비트를 넘음: {dem_dm.max()}"
    save_u16(dem_dm, OUT / "terrain.png")

    scen_meta = []
    for s in res["scenarios"]:
        key = s["key"]
        dd = grids[f"depth_{key}"]
        d = dd if DOWN == 1 else block_reduce(dd, DOWN, np.nanmax)
        d_cm = np.nan_to_num(d * 100, nan=0).round()
        d_cm = np.clip(d_cm, 0, 65534)
        p = OUT / f"depth_{key}.png"
        save_u16(d_cm, p)
        scen_meta.append({**{k: v for k, v in s.items() if k != "monotonic_adjustments"},
                          "file": p.name,
                          "adjusted_gauges": len(s.get("monotonic_adjustments", [])),
                          "max_depth_m": round(float(d.max()), 2)})
        print(f"  {s['label']:<10} {p.name:<16} {p.stat().st_size/1024:7.0f} KB  "
              f"최대수심 {d.max():.1f} m  면적 {s['area_km2']} km²")

    # 본류로부터의 거리 — 뷰어에서 "지류 몇 km 까지 볼지" 를 직접 자르게 한다.
    # 최근접 하도 수면을 그대로 적용한 탓에 지류 골짜기 침수가 과대표시되는데,
    # 모형으로 임의 감쇠시키는 대신 범위를 드러내고 사용자가 제한하도록 한다.
    dist_s = grids["dist"] if DOWN == 1 else block_reduce(grids["dist"], DOWN, np.nanmin)
    dist_m = np.nan_to_num(np.clip(dist_s, 0, 65534), nan=65534).round()
    save_u16(dist_m, OUT / "dist.png")
    print(f"  본류거리   dist.png       {(OUT/'dist.png').stat().st_size/1024:7.0f} KB  "
          f"최대 {dist_s.max()/1000:.1f} km")

    # 텍스처는 내려받는 데 오래 걸리고 자주 바뀌지 않는다. 이미 있으면 그대로 쓴다.
    import sys as _sys
    if "--keep-texture" in _sys.argv and (OUT / "texture.jpg").exists():
        prev = json.loads((OUT / "meta.json").read_text(encoding="utf-8")) \
            if (OUT / "meta.json").exists() else {}
        tex = prev.get("texture")
        print("텍스처 재사용(--keep-texture)")
    else:
        tex = fetch_texture(bounds, crs, W, H)
    to4326 = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    lon0, lat0 = to4326.transform(bounds.left, bounds.bottom)
    lon1, lat1 = to4326.transform(bounds.right, bounds.top)

    meta = {
        "grid": {"w": w, "h": h, "down": DOWN},
        "res_m": res["res_m"] * DOWN,
        "elev_offset_m": round(dmin, 3),
        "encoding": "rgb16",         # 값 = R*256 + G
        "elev_scale": 0.1,           # 값 * scale + offset = 표고(m)
        "depth_scale": 0.01,         # 값 * scale = 수심(m)
        "dist_file": "dist.png", "dist_scale": 1.0,   # 값 = 본류로부터 거리(m)
        "dist_max_m": MAX_DIST_VIEW,
        "bounds_5186": [bounds.left, bounds.bottom, bounds.right, bounds.top],
        "bounds_4326": [lon0, lat0, lon1, lat1],
        "extent_m": [bounds.right - bounds.left, bounds.top - bounds.bottom],
        "elev_range_m": [round(float(np.nanmin(dem_s)), 1), round(float(np.nanmax(dem_s)), 1)],
        "texture": tex,
        "reach": res["reach"],
        "channel": res.get("channel"),
        "gauges": res["gauges"],
        "scenarios": scen_meta,
        "monotonic_adjustments": {s["key"]: s.get("monotonic_adjustments", [])
                                  for s in res["scenarios"]},
    }
    (OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1),
                                   encoding="utf-8")
    total = sum(p.stat().st_size for p in OUT.iterdir())
    print(f"\n저장: {OUT}  (총 {total/1024/1024:.1f} MB)")
    for p in sorted(OUT.iterdir()):
        print(f"  {p.name:<18}{p.stat().st_size/1024:8.0f} KB")


def window_for(src, bounds, crs):
    """대상 범위(EPSG:5186)를 원본 영상 좌표계의 읽기 창으로 바꾼다."""
    from rasterio.warp import transform_bounds
    from rasterio.windows import from_bounds as win_from_bounds
    try:
        b = transform_bounds(crs, src.crs, bounds.left, bounds.bottom,
                             bounds.right, bounds.top, densify_pts=21)
        # **장면 실제 범위로 잘라야 한다.** bbox 를 그대로 창으로 쓰면 bbox 의 일부만
        # 덮는 장면에서도 bbox 전체 크기(12,000²)의 배열을 읽게 되어, 전 구간 1차
        # 시도에서 18분이 지나도 끝나지 않았다.
        from rasterio.windows import Window
        w = win_from_bounds(*b, transform=src.transform)
        col0 = max(0, int(math.floor(w.col_off)))
        row0 = max(0, int(math.floor(w.row_off)))
        col1 = min(src.width, int(math.ceil(w.col_off + w.width)))
        row1 = min(src.height, int(math.ceil(w.row_off + w.height)))
        if col1 <= col0 or row1 <= row0:
            return None
        return Window(col0, row0, col1 - col0, row1 - row0)
    except Exception:
        return None


def block_reduce(a, k, fn):
    """k배 축소. 가장자리는 잘라낸다(배수로 안 떨어지는 부분)."""
    H, W = a.shape
    h, w = H // k, W // k
    b = a[:h * k, :w * k].reshape(h, k, w, k)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)   # 전부 NaN 인 블록
        return fn(fn(b, axis=3), axis=1)


def save_u16(arr, path):
    """16비트 값을 8비트 RGB 로 쪼개 저장한다 (R=상위바이트, G=하위바이트).

    브라우저 canvas 는 16비트 그레이스케일 PNG 를 8비트로 깎아서 읽어버리기 때문에
    (getImageData 가 8비트 RGBA 만 준다) 그대로 쓰면 하위 바이트가 날아간다.
    두 채널로 나눠 담으면 무손실로 복원된다: v = R*256 + G
    """
    v = arr.astype(np.uint32)
    rgb = np.zeros(v.shape + (3,), dtype=np.uint8)
    rgb[..., 0] = (v >> 8) & 0xFF
    rgb[..., 1] = v & 0xFF
    Image.fromarray(rgb, mode="RGB").save(path, optimize=True)


def fetch_texture(bounds, crs, W, H):
    """구간을 덮는 저운량 Sentinel-2 TCI 를 받아 지형 텍스처로 저장한다."""
    to4326 = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    corners = [to4326.transform(x, y) for x in (bounds.left, bounds.right)
               for y in (bounds.bottom, bounds.top)]
    lons = [c[0] for c in corners]; lats = [c[1] for c in corners]
    bbox = [min(lons), min(lats), max(lons), max(lats)]
    cat = pystac_client.Client.open("https://planetarycomputer.microsoft.com/api/stac/v1",
                                    modifier=planetary_computer.sign_inplace)
    items = list(cat.search(collections=["sentinel-2-l2a"], bbox=bbox,
                            datetime="2024-01-01/2025-12-31",
                            query={"eo:cloud_cover": {"lt": 5}}).items())
    if not items:
        print("위성 텍스처: 조건에 맞는 장면 없음 — 텍스처 없이 진행")
        return None
    # 전 구간은 여러 MGRS 타일에 걸친다. 운량만으로 고르면 한 타일의 장면 여러 개를
    # 집어와 다른 지역이 비어 버리므로, 타일별로 가장 맑은 장면을 하나씩 고른다.
    # **타일만으로 묶으면 안 된다.** Sentinel-2 granule 은 궤도 경계에서 타일의 절반만
    # 채워 오는 경우가 있어, 타일별 최맑음 1장만 쓰면 반쪽이 빈다(전 구간 1차 시도에서
    # 커버리지 83.9% 에 멈춘 원인 — 상·하단 1/4 이 각각 28% 씩 비었다).
    # 타일 × 상대궤도 조합으로 묶으면 서로 반대쪽을 메운다.
    best = {}
    for it in items:
        tile = it.properties.get("s2:mgrs_tile") or it.id.split("_")[-2]
        orbit = it.properties.get("sat:relative_orbit") or it.id.split("_")[-3]
        k = (tile, orbit)
        cc = it.properties.get("eo:cloud_cover", 100)
        if k not in best or cc < best[k].properties.get("eo:cloud_cover", 100):
            best[k] = it
    first = sorted(best.values(), key=lambda it: it.properties.get("eo:cloud_cover", 100))
    print(f"타일×궤도 {len(first)}개: "
          + ", ".join(f"{(it.properties.get('s2:mgrs_tile') or '?')}"
                      f"/R{it.properties.get('sat:relative_orbit', '?')}"
                      f"({it.properties.get('eo:cloud_cover', -1):.1f}%)" for it in first))
    # 타일별 1장만으로는 다 덮이지 않는다(궤도 경계에서 장면이 타일을 꽉 채우지 않음 —
    # 1차 시도에서 6장으로 83.8% 에 멈췄다). 먼저 타일별 최맑음으로 넓게 깔고,
    # 남은 장면을 운량 순으로 계속 덧대 빈 곳을 메운다.
    chosen = {it.id for it in first}
    rest = sorted((it for it in items if it.id not in chosen),
                  key=lambda it: it.properties.get("eo:cloud_cover", 100))
    items = first + rest
    print(f"  보조 장면 {len(rest)}개 대기 (빈 곳이 남으면 순서대로 덧댄다)")

    tw = min(TEX_MAX, round((bounds.right - bounds.left) / 10))   # 10 m/화소 상한
    th = int(round(tw * H / W))
    tf_out = rasterio.transform.from_bounds(bounds.left, bounds.bottom,
                                            bounds.right, bounds.top, tw, th)
    print(f"텍스처 목표 {tw}x{th} ({(bounds.right-bounds.left)/tw:.1f} m/화소)")
    acc = np.zeros((3, th, tw), dtype="float32")
    cnt = np.zeros((3, th, tw), dtype="float32")[0]
    used = []
    for it in items[:20]:
        try:
            with rasterio.open(it.assets["visual"].href) as src:
                # 타일 전체(10980²)를 끌어오지 않고, 필요한 구역만 창으로 읽는다.
                # 예전처럼 전체를 축소해 읽으면 4608 화소 텍스처에 쓸 해상도가 안 나온다.
                win = window_for(src, bounds, crs)
                if win is None:
                    continue
                sh = int(win.height); sw = int(win.width)
                if sw < 1 or sh < 1:
                    continue
                cap = 3000                                # 과도한 전송 방지
                if max(sw, sh) > cap:
                    k = cap / max(sw, sh)
                    sw, sh = max(1, int(sw * k)), max(1, int(sh * k))
                arr = src.read(out_shape=(3, sh, sw), window=win,
                               resampling=Resampling.average, boundless=True, fill_value=0)
                wtf = src.window_transform(win)
                stf = wtf * wtf.scale(win.width / sw, win.height / sh)
                buf = np.zeros((3, th, tw), dtype="uint8")
                reproject(arr, buf, src_transform=stf, src_crs=src.crs,
                          dst_transform=tf_out, dst_crs=crs, resampling=Resampling.bilinear)
        except Exception as e:
            print(f"  {it.id}: 읽기 실패 {type(e).__name__}: {str(e)[:60]}")
            continue
        m = buf.sum(axis=0) > 0
        acc[:, m] += buf[:, m]
        cnt[m] += 1
        used.append({"id": it.id, "date": it.properties["datetime"][:10],
                     "cloud": round(it.properties.get("eo:cloud_cover", -1), 1)})
        print(f"  {it.id[:34]} {it.properties['datetime'][:10]} 누적 {100*(cnt>0).mean():.1f}%")
        # 남쪽 해역은 ESA 가 순수 해양 타일을 생산하지 않아 영상이 없다.
        # 육지가 다 덮이면 84% 선에서 더 늘지 않으므로 여기서 멈춘다.
        if (cnt > 0).mean() > 0.97:
            break
    if (cnt > 0).mean() <= 0.995:
        print(f"  경고: 최종 커버리지 {100*(cnt>0).mean():.1f}% — 빈 곳이 남았다")
    if not used:
        return None
    # 영상이 없는 곳(= 해역)은 검정으로 두면 구멍처럼 보인다. 바다색으로 채운다.
    SEA = np.array([92, 115, 131], dtype="float32")
    img = np.where(cnt > 0, acc / np.maximum(cnt, 1),
                   SEA[:, None, None]).astype("uint8")
    # 품질 80 + 기본 크로마 서브샘플링(4:2:0)은 식생처럼 잔무늬가 많은 면에서
    # 눈에 띄게 뭉갠다. 지형 텍스처는 확대해서 보는 용도이므로 서브샘플링을 끄고
    # 품질을 올린다(용량 증가는 감수).
    Image.fromarray(np.transpose(img, (1, 2, 0))).save(OUT / "texture.jpg",
                                                       quality=90, subsampling=0,
                                                       optimize=True)
    return {"file": "texture.jpg", "size": [tw, th], "scenes": used,
            "coverage_pct": round(float(100 * (cnt > 0).mean()), 1)}


if __name__ == "__main__":
    main()
