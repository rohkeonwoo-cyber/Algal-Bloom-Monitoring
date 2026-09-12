"""관측 수위로 침수범위를 계산한다 (창녕함안보~합천창녕보, dfe 74~117 km).

방법 — 지형 기반 근사이며 수리모형이 아니다.
  1) 해발표고 = 관측수위 + gdt (10b_영점표고검증.py 에서 확인:
     담수역별 관심수위 EL 이 단조 증가, DEM 수면과 평균 +0.71 m 차이)
  2) 담수역(보~보) 안에서 관측소들의 EL 을 종단거리에 대해 선형보간 → 수면종단(WSE profile).
     보에서 수면이 단계적으로 꺾이므로 담수역 경계를 넘어 보간하지 않는다.
  3) 모든 화소에 '가장 가까운 하도 화소의 WSE' 를 부여하고 DEM 보다 높으면 침수로 본다.
  4) 하도와 연결되지 않은 고립 저지대는 제외한다(분지에 물이 고이는 가짜 침수 방지).

한계 (반드시 함께 표기)
  - Copernicus DEM GLO-30 은 **DSM** 이라 수목·건물 높이가 표고에 포함된다 →
    식생 우거진 홍수터의 표고를 과대평가해 침수를 과소추정한다.
  - 30 m 해상도로는 제방·도로 같은 선형 구조물을 해상하지 못한다.
  - 수리 계산(부정류·통수능·조도)이 없다. 수면을 종단으로만 늘린 정적 근사다.
  - 따라서 결과는 "어느 지역이 낮아서 취약한가" 수준의 참고이며,
    특정 지점의 침수 여부를 판정하는 데 쓸 수 없다.

검증: JRC Global Surface Water(GSW) 로 대조한다. 현재 수위 시나리오의 침수역이
      상시수면(occurrence 높음)과 얼마나 겹치는지, 큰 시나리오가 계절수면
      (seasonality 높음)을 얼마나 포함하는지 본다.

실행: .venv/bin/python 10_flood/10c_침수계산.py
"""
import csv
import json
import pathlib

import geopandas as gpd
import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.features import rasterize
from rasterio.warp import Resampling, reproject
from scipy import ndimage

BASE = pathlib.Path(__file__).resolve().parent
MORPH = BASE.parent
WORK = BASE / "work"
DATA = pathlib.Path("/home/gw/Algal-Bloom-Monitoring/data")

S_LO, S_HI = 74.0, 117.0
MAX_DIST_M = 15000          # 하도에서 이보다 먼 곳은 판단 대상에서 제외
GAUGE_MAX_DIST_KM = 2.0     # 본류 관측소로 인정할 중심선 거리

SCENARIOS = [               # (키, 표시명, 관측소 필드)
    ("now", "현재 수위", "latest_wl"),
    ("att", "관심수위", "attwl"),
    ("wrn", "주의수위", "wrnwl"),
    ("alm", "경계수위", "almwl"),
    ("srs", "심각수위", "srswl"),
]


def main():
    with rasterio.open(WORK / "dem_5186_30m.tif") as src:
        dem = src.read(1)
        tf, crs, H, W = src.transform, src.crs, src.height, src.width
    px = tf.a
    print(f"DEM {W}x{H}, 해상도 {px:.1f} m, 표고 {np.nanmin(dem):.1f}~{np.nanmax(dem):.1f} m")

    # ---- 하도 격자: 종단구간 폴리곤을 S_KM / POOL_ID 로 굽는다 ----
    seg = gpd.read_file(MORPH / "06_morph" / "06_종단구간.shp")
    seg = seg[(seg["S_KM"] >= S_LO) & (seg["S_KM"] <= S_HI)].copy()
    s_grid = rasterize([(g, v) for g, v in zip(seg.geometry, seg["S_KM"])],
                       out_shape=(H, W), transform=tf, fill=np.nan, dtype="float32")
    pool_grid = rasterize([(g, int(v)) for g, v in zip(seg.geometry, seg["POOL_ID"])],
                          out_shape=(H, W), transform=tf, fill=-1, dtype="int32")
    channel = np.isfinite(s_grid)
    print(f"하도 화소 {channel.sum():,}개 ({channel.sum()*px*px/1e6:.1f} km²), "
          f"담수역 {sorted(set(pool_grid[channel].tolist()))}")

    # ---- 관측소: 해발표고 시나리오별 수면 ----
    W_json = json.loads((DATA / "hrfco_waterlevel.json").read_text(encoding="utf-8"))
    cx = seg.geometry.centroid.x.values
    cy = seg.geometry.centroid.y.values
    skm = seg["S_KM"].values.astype(float)
    pid = seg["POOL_ID"].values.astype(int)
    to5186 = Transformer.from_crs("EPSG:4326", "EPSG:5186", always_xy=True)

    gauges = []
    for r in W_json["rows"]:
        if r.get("gdt") is None or r["lon"] is None:
            continue
        x, y = to5186.transform(r["lon"], r["lat"])
        d = np.hypot(cx - x, cy - y)
        i = int(d.argmin())
        if d[i] / 1000 > GAUGE_MAX_DIST_KM:
            continue
        g = {"name": r["name"], "s": float(skm[i]), "pool": int(pid[i]),
             "dist_km": round(d[i] / 1000, 2), "gdt": r["gdt"],
             # 뷰어에서 "이 지점으로 가기" 를 하려면 화면좌표를 알아야 한다
             "x": round(float(x), 1), "y": round(float(y), 1)}
        for key, _, field in SCENARIOS:
            v = r.get(field)
            g[key] = round(v + r["gdt"], 3) if v is not None and (field == "latest_wl" or v > 0) else None
        gauges.append(g)
    gauges.sort(key=lambda g: g["s"])
    print(f"\n대상 구간 본류 관측소 {len(gauges)}개 (해발표고 EL.m)")
    print(f"{'관측소':<22}{'s_km':>7}{'pool':>5}" + "".join(f"{n:>10}" for _, n, _ in SCENARIOS))
    for g in gauges:
        print(f"{g['name']:<22}{g['s']:7.1f}{g['pool']:5d}"
              + "".join(f"{(g[k] if g[k] is not None else float('nan')):10.2f}" for k, _, _ in SCENARIOS))

    # ---- 가장 가까운 하도 화소 (거리변환) ----
    dist, (iy, ix) = ndimage.distance_transform_edt(~channel, sampling=(px, px),
                                                    return_indices=True)
    near_s = s_grid[iy, ix]
    near_pool = pool_grid[iy, ix]
    inrange = dist <= MAX_DIST_M
    print(f"\n판단 대상 화소: {inrange.sum():,}개 (하도 {MAX_DIST_M/1000:.0f} km 이내)")

    # ---- 시나리오별 수면종단 → 침수 ----
    gsw = load_gsw(WORK, tf, crs, H, W)
    results, exports = [], {}
    for key, label, _ in SCENARIOS:
        adj = []
        wse = wse_field(gauges, key, near_s, near_pool, inrange, adjust_log=adj)
        if wse is None:
            print(f"\n[{label}] 보간 가능한 관측소가 없어 건너뜀")
            continue
        flood_raw = inrange & np.isfinite(dem) & np.isfinite(wse) & (dem < wse)
        flood = keep_connected(flood_raw, channel)
        depth = np.where(flood, wse - dem, 0.0).astype("float32")
        area = flood.sum() * px * px / 1e6
        off = flood & ~channel
        rec = {
            "key": key, "label": label,
            "area_km2": round(float(area), 2),
            "offchannel_km2": round(float(off.sum() * px * px / 1e6), 2),
            "depth_mean_m": round(float(depth[flood].mean()), 2) if flood.any() else None,
            "depth_p95_m": round(float(np.percentile(depth[flood], 95)), 2) if flood.any() else None,
            "wse_range": [round(float(np.nanmin(wse[channel])), 2),
                          round(float(np.nanmax(wse[channel])), 2)],
            "dropped_isolated_km2": round(float((flood_raw.sum() - flood.sum()) * px * px / 1e6), 2),
            "monotonic_adjustments": adj,
        }
        if gsw is not None:
            rec.update(gsw_check(flood, gsw, channel))
        results.append(rec)
        exports[key] = depth
        print(f"\n[{label}] 수면 EL {rec['wse_range'][0]}~{rec['wse_range'][1]} m")
        print(f"  침수면적 {rec['area_km2']} km² (하도 외 {rec['offchannel_km2']} km²) · "
              f"수심 평균 {rec['depth_mean_m']} m / 95백분위 {rec['depth_p95_m']} m")
        print(f"  하도 비연결 고립부 제외 {rec['dropped_isolated_km2']} km²")
        if adj:
            print("  단조 제약으로 조정된 지점: " + ", ".join(
                f"{a['gauge']} {a['raw_el']}→{a['fitted_el']}({a['adjust_m']:+.2f})" for a in adj))
        if gsw is not None:
            print(f"  GSW 대조: 상시수면 재현율 {rec['gsw_permanent_recall']}% · "
                  f"침수역 중 GSW 수면흔적 있는 비율 {rec['gsw_any_precision']}%")

    (WORK / "10c_결과.json").write_text(
        json.dumps({"reach": {"s_lo": S_LO, "s_hi": S_HI}, "res_m": px,
                    "gauges": gauges, "scenarios": results},
                   ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n저장:", WORK / "10c_결과.json")

    np.savez_compressed(WORK / "10c_침수격자.npz", dem=dem,
                        channel=channel, dist=dist.astype("float32"),
                        **{f"depth_{k}": v for k, v in exports.items()})
    print("저장:", WORK / "10c_침수격자.npz",
          f"({(WORK / '10c_침수격자.npz').stat().st_size/1024/1024:.1f} MB)")


def isotonic_nondecreasing(y):
    """PAVA(pool-adjacent-violators) — 최소제곱 의미의 비감소 단조적합.

    수면은 상류로 갈수록 높아야 하는데, 기관이 지점별로 정한 기준수위는 서로
    정합되지 않아 종단이 역전되는 구간이 있다(예: 적포교 관심 EL 5.50 <
    하류 유어교 10.46). 역전을 그대로 두면 수면이 하류로 솟는 비물리적 형상이 된다.
    누적최대(running max)는 값을 한쪽으로만 밀어 침수를 체계적으로 과대추정하므로,
    조정량이 최소가 되는 등위회귀를 쓴다. 조정량은 호출부에서 기록한다.
    """
    vals = [float(v) for v in y]
    blocks = [[v, 1] for v in vals]          # [평균, 개수]
    i = 0
    while i < len(blocks) - 1:
        if blocks[i][0] > blocks[i + 1][0] + 1e-12:
            v0, n0 = blocks[i]
            v1, n1 = blocks[i + 1]
            blocks[i] = [(v0 * n0 + v1 * n1) / (n0 + n1), n0 + n1]
            del blocks[i + 1]
            if i > 0:
                i -= 1
        else:
            i += 1
    out = []
    for v, n in blocks:
        out.extend([v] * n)
    return np.array(out)


def wse_field(gauges, key, near_s, near_pool, inrange, adjust_log=None):
    """담수역 안에서만 종단 선형보간한 수면표고 격자 (단조 제약 적용)."""
    out = np.full(near_s.shape, np.nan, dtype="float32")
    any_ok = False
    for pool in sorted({g["pool"] for g in gauges}):
        pts = [(g["s"], g[key], g["name"]) for g in gauges
               if g["pool"] == pool and g[key] is not None]
        if not pts:
            continue
        pts.sort()
        xs = np.array([p[0] for p in pts])
        ys_raw = np.array([p[1] for p in pts])
        ys = isotonic_nondecreasing(ys_raw)
        if adjust_log is not None:
            for (s, raw, name), fit in zip(pts, ys):
                if abs(fit - raw) > 0.01:
                    adjust_log.append({"gauge": name, "s": s, "pool": pool,
                                       "raw_el": round(float(raw), 2),
                                       "fitted_el": round(float(fit), 2),
                                       "adjust_m": round(float(fit - raw), 2)})
        m = inrange & (near_pool == pool)
        if not m.any():
            continue
        # 양끝은 마지막 관측값으로 평평하게 연장(np.interp 기본 동작)
        out[m] = np.interp(near_s[m], xs, ys)
        any_ok = True
    return out if any_ok else None


def keep_connected(flood, channel):
    """하도와 이어진 침수역만 남긴다 — 고립 분지가 물로 채워지는 것을 막는다."""
    lab, n = ndimage.label(flood, structure=np.ones((3, 3), dtype=bool))
    if n == 0:
        return flood
    touch = np.unique(lab[channel & flood])
    touch = touch[touch > 0]
    return np.isin(lab, touch)


def load_gsw(work, tf, crs, H, W):
    """JRC Global Surface Water 를 DEM 격자에 맞춰 읽는다 (occurrence·seasonality)."""
    src_dir = work.parent.parent / "04_spatial" / "work"
    out = {}
    for name, fn in (("occurrence", "gsw_occurrence_5186.tif"),
                     ("seasonality", "gsw_seasonality_5186.tif")):
        p = src_dir / fn
        if not p.exists():
            print(f"GSW 없음: {p}")
            return None
        with rasterio.open(p) as s:
            arr = np.zeros((H, W), dtype="float32")
            reproject(s.read(1), arr, src_transform=s.transform, src_crs=s.crs,
                      dst_transform=tf, dst_crs=crs, src_nodata=s.nodata,
                      dst_nodata=0, resampling=Resampling.average)
            out[name] = arr
    print(f"GSW 적재: occurrence 최대 {out['occurrence'].max():.0f}, "
          f"seasonality 최대 {out['seasonality'].max():.0f}")
    return out


def gsw_check(flood, gsw, channel):
    """상시수면(occurrence>=90)을 얼마나 재현하는지, 침수역에 수면흔적이 있는지."""
    perm = gsw["occurrence"] >= 90
    anyw = gsw["occurrence"] >= 5
    recall = 100 * (flood & perm).sum() / max(perm.sum(), 1)
    prec = 100 * (flood & anyw).sum() / max(flood.sum(), 1)
    return {"gsw_permanent_recall": round(float(recall), 1),
            "gsw_any_precision": round(float(prec), 1)}


if __name__ == "__main__":
    main()
