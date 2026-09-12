"""낙동강 본류 전 구간(하구둑~영강합류부)의 DEM 을 Planetary Computer 에서 받아
EPSG:5186 30m 격자로 만든다.

Copernicus DEM GLO-30 (TanDEM-X 기반 DSM, 수직기준 EGM2008 지오이드).
DSM 이므로 수목·건물 높이가 포함된다 — 침수범위 근사의 주요 오차원이며 명시해야 한다.
"""
import pathlib

import numpy as np
import geopandas as gpd
import planetary_computer
import pystac_client
import rasterio
from rasterio.warp import calculate_default_transform, reproject, Resampling
from rasterio.merge import merge
from pyproj import Transformer

BASE = pathlib.Path(__file__).resolve().parent
WORK = BASE / "work"
WORK.mkdir(exist_ok=True)

# 전 구간(하구둑~영강합류부). 처음에는 창녕함안보~합천창녕보 43 km 로 시범 제작했으나,
# Chl-a 는 268 km 전체이고 조류경보 4지점도 흩어져 있어 한 화면에 같이 보려면 전 구간이 필요하다.
S_LO, S_HI = 0.0, 268.0
BUF_M = 10000                   # 홍수터를 담기 위한 좌우 여유
RES = 30.0

seg = gpd.read_file(BASE.parent / "06_morph" / "06_종단구간.shp")
sel = seg[(seg["S_KM"] >= S_LO) & (seg["S_KM"] <= S_HI)]
print(f"대상 구간: dfe {S_LO}~{S_HI} km, {len(sel)}개 구간")

minx, miny, maxx, maxy = sel.total_bounds
minx, miny, maxx, maxy = minx - BUF_M, miny - BUF_M, maxx + BUF_M, maxy + BUF_M
print(f"EPSG:5186 bbox: {minx:.0f},{miny:.0f} ~ {maxx:.0f},{maxy:.0f}"
      f"  ({(maxx-minx)/1000:.1f} x {(maxy-miny)/1000:.1f} km)")

to4326 = Transformer.from_crs("EPSG:5186", "EPSG:4326", always_xy=True)
corners = [to4326.transform(x, y) for x in (minx, maxx) for y in (miny, maxy)]
lons = [c[0] for c in corners]; lats = [c[1] for c in corners]
bbox4326 = [min(lons), min(lats), max(lons), max(lats)]
print("EPSG:4326 bbox:", [round(v, 4) for v in bbox4326])

cat = pystac_client.Client.open("https://planetarycomputer.microsoft.com/api/stac/v1",
                                modifier=planetary_computer.sign_inplace)
items = list(cat.search(collections=["cop-dem-glo-30"], bbox=bbox4326).items())
print(f"DEM 타일 {len(items)}개")

srcs = []
for it in items:
    href = (it.assets.get("data") or list(it.assets.values())[0]).href
    srcs.append(rasterio.open(href))
mosaic, mosaic_tf = merge(srcs, bounds=tuple(bbox4326))
print("모자이크(4326):", mosaic.shape)
src_crs = srcs[0].crs
nodata = srcs[0].nodata
for s in srcs:
    s.close()

dst_tf, dst_w, dst_h = calculate_default_transform(
    src_crs, "EPSG:5186", mosaic.shape[2], mosaic.shape[1],
    *rasterio.transform.array_bounds(mosaic.shape[1], mosaic.shape[2], mosaic_tf),
    resolution=RES)
dem = np.full((dst_h, dst_w), np.nan, dtype="float32")
reproject(mosaic[0], dem, src_transform=mosaic_tf, src_crs=src_crs,
          dst_transform=dst_tf, dst_crs="EPSG:5186",
          src_nodata=nodata, dst_nodata=np.nan, resampling=Resampling.bilinear)
print(f"재투영(5186 {RES}m): {dem.shape}, 표고 {np.nanmin(dem):.1f}~{np.nanmax(dem):.1f} m")

out = WORK / "dem_5186_30m.tif"
with rasterio.open(out, "w", driver="GTiff", height=dst_h, width=dst_w, count=1,
                   dtype="float32", crs="EPSG:5186", transform=dst_tf,
                   nodata=np.nan, compress="deflate") as dst:
    dst.write(dem, 1)
print("저장:", out, f"({out.stat().st_size/1024/1024:.1f} MB)")
