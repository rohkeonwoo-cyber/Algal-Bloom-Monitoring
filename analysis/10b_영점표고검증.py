"""HRFCO 수위가 '수위표 기준'이고 해발표고 = 수위 + gdt 인지 검증한다.

왜 중요한가: 침수범위를 그리려면 수면의 **절대 표고**가 필요하다. 관측값이 수위표
기준이면 DEM(해발표고)과 직접 비교할 수 없다. gdt(영점표고)를 더하면 해발표고가
되는지 두 가지 독립 근거로 확인한다.

근거 1 (내부 정합): 같은 담수역(보와 보 사이)의 관측소들은 수면이 거의 같은
        표고여야 한다 → attwl+gdt 가 지점마다 흩어지지 않고 한 값으로 모이는지.
근거 2 (외부 대조): DEM 에서 각 관측소 최근접 수면 화소의 표고와 비교.
        Copernicus DEM 은 DSM 이고 수직기준이 EGM2008 이므로 수 m 오차는 정상 —
        수위표 기준(임의 영점)이라면 수십 m 씩 어긋날 것이므로 구별은 가능하다.
"""
import json
import pathlib

import numpy as np
import geopandas as gpd
import rasterio
from pyproj import Transformer
from scipy import ndimage

BASE = pathlib.Path(__file__).resolve().parent
MORPH = BASE.parent
S_LO, S_HI = 74.0, 117.0

W = json.loads(pathlib.Path("/home/gw/Algal-Bloom-Monitoring/data/hrfco_waterlevel.json")
               .read_text(encoding="utf-8"))
rows = [r for r in W["rows"] if r.get("gdt") is not None and r["risk_judgeable"]]
print(f"gdt 보유 + 판정가능 관측소: {len(rows)}개 / 전체 {W['n']}개")

# ---- 근거 1: 담수역별 attwl+gdt 수렴 ----
seg = gpd.read_file(MORPH / "06_morph" / "06_종단구간.shp")
cx, cy = seg.geometry.centroid.x.values, seg.geometry.centroid.y.values
skm = seg["S_KM"].values.astype(float)
to5186 = Transformer.from_crs("EPSG:4326", "EPSG:5186", always_xy=True)

import csv
struct = list(csv.DictReader((MORPH / "04_spatial" / "04_구조물.csv")
                             .read_text(encoding="utf-8-sig").splitlines()))
weir_km = sorted(float(r["dfe_km"]) for r in struct if r["종류"] in ("보", "하구둑"))
weir_km += [999.0]

def pool_of(s):
    for i in range(len(weir_km) - 1):
        if weir_km[i] <= s < weir_km[i + 1]:
            return i
    return None

recs = []
for r in rows:
    x, y = to5186.transform(r["lon"], r["lat"])
    d = np.hypot(cx - x, cy - y)
    i = int(d.argmin())
    recs.append(dict(name=r["name"], x=x, y=y, dist_km=d[i] / 1000, s=skm[i],
                     pool=pool_of(skm[i]), gdt=r["gdt"], attwl=r["attwl"],
                     wl=r["latest_wl"],
                     el_att=r["attwl"] + r["gdt"] if r["attwl"] else None,
                     el_now=r["latest_wl"] + r["gdt"] if r["latest_wl"] is not None else None))

near = [q for q in recs if q["dist_km"] <= 2.0 and q["el_att"] is not None]
print(f"\n근거 1 — 본류 2km 이내 {len(near)}개소, 담수역별 '관심수위 해발표고(attwl+gdt)' 분포")
print(f"{'담수역(보 하류단 km)':<22}{'n':>3}{'평균EL':>9}{'표준편차':>9}{'범위':>16}")
import collections
by = collections.defaultdict(list)
for q in near:
    by[q["pool"]].append(q)
for p in sorted(by):
    v = [q["el_att"] for q in by[p]]
    lo = weir_km[p]
    print(f"{f'{lo:.0f}~{weir_km[p+1]:.0f}':<22}{len(v):>3}{np.mean(v):9.2f}{np.std(v):9.2f}"
          f"{f'{min(v):.2f}~{max(v):.2f}':>16}")

# ---- 근거 2: DEM 수면 화소 표고와 대조 (대상 구간만) ----
with rasterio.open(BASE / "work" / "dem_5186_30m.tif") as src:
    dem = src.read(1)
    tf = src.transform
water = gpd.read_file(MORPH / "04_spatial" / "04_수면폴리곤.shp")
from rasterio.features import rasterize
wmask = rasterize([(g, 1) for g in water.geometry], out_shape=dem.shape,
                  transform=tf, fill=0, dtype="uint8").astype(bool)
print(f"\nDEM 내 수면 화소: {wmask.sum():,}개")
# 각 화소에서 가장 가까운 수면 화소의 인덱스
_, (iy, ix) = ndimage.distance_transform_edt(~wmask, return_indices=True)

print(f"\n근거 2 — 대상 구간(dfe {S_LO}~{S_HI}) 관측소: 현재수면 해발표고 vs DEM 최근접 수면화소")
print(f"{'관측소':<22}{'gdt':>8}{'현재wl':>8}{'wl+gdt':>9}{'DEM수면':>9}{'차이':>8}")
sel = [q for q in near if S_LO <= q["s"] <= S_HI and q["el_now"] is not None]
diffs = []
for q in sorted(sel, key=lambda z: -z["s"]):
    col, row = ~tf * (q["x"], q["y"])
    col, row = int(col), int(row)
    if not (0 <= row < dem.shape[0] and 0 <= col < dem.shape[1]):
        print(f"{q['name']:<22}  DEM 범위 밖")
        continue
    dem_w = float(dem[iy[row, col], ix[row, col]])
    diffs.append(q["el_now"] - dem_w)
    print(f"{q['name']:<22}{q['gdt']:8.3f}{q['wl']:8.2f}{q['el_now']:9.2f}{dem_w:9.2f}"
          f"{q['el_now']-dem_w:8.2f}")
if diffs:
    print(f"\n  차이: 평균 {np.mean(diffs):+.2f} m, 중위 {np.median(diffs):+.2f} m, "
          f"표준편차 {np.std(diffs):.2f} m, 범위 {min(diffs):+.2f}~{max(diffs):+.2f} m")
    print("  (수위표 임의영점이라면 수십 m 급으로 어긋나야 한다 — 수 m 이내면 해발표고로 판단)")
