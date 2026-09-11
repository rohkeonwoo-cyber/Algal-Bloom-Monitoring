"""3D 뷰용 자료를 웹에서 읽을 수 있는 형태로 내보낸다.

내보내는 것 (dashboard/flood/)
  terrain.png    표고 (R=상위/G=하위 바이트로 담은 16비트, 단위 dm, 오프셋은 meta 에)
  depth_*.png    시나리오별 침수심 (같은 방식, 단위 cm, 0 = 침수 아님)
  texture.jpg    Sentinel-2 TCI 위성영상 (지형 표면에 입힐 텍스처)
  meta.json      격자 크기·좌표범위·스케일·시나리오 요약

왜 PNG 인가: PNG 는 무손실이고 침수심처럼 대부분이 0 인 격자에서 압축이 잘 든다.
float 배열을 그대로 보내는 것보다 훨씬 작다. 단, 브라우저 canvas 가 8비트로만
읽으므로 16비트 값은 R/G 두 채널에 나눠 담는다(save_u16 참조).

실행: .venv/bin/python 10_flood/10d_웹출력.py
"""
import json
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

DOWN = 3            # 격자 축소 배율 (1512x1627 -> 504x542, 정점 27만개)
TEX_MAX = 2048      # 위성 텍스처 한 변 최대 화소


def main():
    grids = np.load(WORK / "10c_침수격자.npz")
    res = json.loads((WORK / "10c_결과.json").read_text(encoding="utf-8"))
    with rasterio.open(WORK / "dem_5186_30m.tif") as src:
        tf, crs, H, W = src.transform, src.crs, src.height, src.width
        bounds = src.bounds

    dem = grids["dem"]
    # 축소: 표고는 평균, 침수심은 최대(얇은 침수대가 사라지지 않게)
    dem_s = block_reduce(dem, DOWN, np.nanmean)
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
        d = block_reduce(grids[f"depth_{key}"], DOWN, np.nanmax)
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
        "bounds_5186": [bounds.left, bounds.bottom, bounds.right, bounds.top],
        "bounds_4326": [lon0, lat0, lon1, lat1],
        "extent_m": [bounds.right - bounds.left, bounds.top - bounds.bottom],
        "elev_range_m": [round(float(np.nanmin(dem_s)), 1), round(float(np.nanmax(dem_s)), 1)],
        "texture": tex,
        "reach": res["reach"],
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
    items.sort(key=lambda it: it.properties.get("eo:cloud_cover", 100))
    print(f"위성 후보 {len(items)}장, 최저운량 {items[0].properties.get('eo:cloud_cover'):.1f}%")

    tw = min(TEX_MAX, W)
    th = int(round(tw * H / W))
    tf_out = rasterio.transform.from_bounds(bounds.left, bounds.bottom,
                                            bounds.right, bounds.top, tw, th)
    acc = np.zeros((3, th, tw), dtype="float32")
    cnt = np.zeros((th, tw), dtype="float32")
    used = []
    for it in items[:6]:
        try:
            with rasterio.open(it.assets["visual"].href) as src:
                # 원본 전체를 네트워크로 끌어오지 않도록 축소해서 읽는다
                sw = min(2400, src.width)
                sh = int(round(sw * src.height / src.width))
                arr = src.read(out_shape=(3, sh, sw), resampling=Resampling.average)
                stf = src.transform * src.transform.scale(src.width / sw, src.height / sh)
                buf = np.zeros((3, th, tw), dtype="uint8")
                reproject(arr, buf, src_transform=stf, src_crs=src.crs,
                          dst_transform=tf_out, dst_crs=crs, resampling=Resampling.bilinear)
        except Exception as e:
            print(f"  {it.id}: 읽기 실패 {type(e).__name__}")
            continue
        m = buf.sum(axis=0) > 0
        acc[:, m] += buf[:, m]
        cnt[m] += 1
        used.append({"id": it.id, "date": it.properties["datetime"][:10],
                     "cloud": round(it.properties.get("eo:cloud_cover", -1), 1)})
        print(f"  {it.id[:34]} {it.properties['datetime'][:10]} 누적 {100*(cnt>0).mean():.1f}%")
        if (cnt > 0).mean() > 0.995:
            break
    if not used:
        return None
    img = np.where(cnt > 0, acc / np.maximum(cnt, 1), 0).astype("uint8")
    Image.fromarray(np.transpose(img, (1, 2, 0))).save(OUT / "texture.jpg", quality=86)
    return {"file": "texture.jpg", "size": [tw, th], "scenes": used,
            "coverage_pct": round(float(100 * (cnt > 0).mean()), 1)}


if __name__ == "__main__":
    main()
