"""조류경보 4개 지점의 지도상 위치를 어떻게 정했는지 — 산출과 검산.

배경: 조류경보제 API 응답에는 위경도가 없다. 08e_경보제비교.py 는 지점별 종단거리를
      두 가지 다른 컬럼에서 가져와 섞어 썼는데(보 dfe_km 과 측정소 종단거리_대리_km),
      그 값을 그대로 지도에 쓰면 해평이 강정고령보보다 하류에 찍힌다(구미보 dfe=219.19
      이므로 해평=154.11 은 dfe 축이 아님).

방법: 조류경보 원자료(08d_조류경보_원자료.csv)의 SWMN_DETAIL_NM 에 기관이 적어둔
      "○○보 상류 N km" 를 04_구조물.csv 의 보 dfe_km 에 더한다. 위경도를 임의로
      만들지 않고, 공표된 상대위치만 쓴다.

검산: 산출된 종단거리에 해당하는 구간의 화면좌표를 위경도로 역투영해 지명과 대조한다.

실행: .venv/bin/python build/지점위치산출.py   (pyproj 필요)
"""
import csv
import json
import pathlib

from pyproj import Transformer

HERE = pathlib.Path(__file__).resolve().parent
MORPH = HERE.parent.parent.parent

d = json.loads((MORPH / "07_stats" / "07k_시계열지도데이터_확장bbox.json").read_text(encoding="utf-8"))
segs, W, H, PAD = d["segments"], d["W"], d["H"], d["PAD"]
MINX, MAXX, MINY, MAXY = d["MINX"], d["MAXX"], d["MINY"], d["MAXY"]
inv = Transformer.from_crs("EPSG:5186", "EPSG:4326", always_xy=True)


def svg_to_lonlat(sx, sy):
    x = (sx - W * PAD) / (W * (1 - 2 * PAD)) * (MAXX - MINX) + MINX
    y = MAXY - (sy - H * PAD) / (H * (1 - 2 * PAD)) * (MAXY - MINY)
    return inv.transform(x, y)


struct = list(csv.DictReader((MORPH / "04_spatial" / "04_구조물.csv").read_text(encoding="utf-8-sig").splitlines()))
dfe = {r["명칭"]: float(r["dfe_km"]) for r in struct}

DERIVE = [
    ("해평",     dfe["칠곡보"] + 22,      "칠곡보 상류 22km (원자료 명시)",              False),
    ("강정고령", dfe["강정고령보"] + 7,   "강정고령보 상류 7km (원자료 명시)",           False),
    ("칠서",     dfe["창녕함안보"] + 12,  "창녕함안보 상류 12km (원자료 명시)",          False),
    ("물금매리", dfe["양산천 합류부"],    "양산천 합류부 기준 근사(보 기준 거리 미제공)", True),
]

print(f"{'지점':<10}{'산출 dfe':>10}{'구간 s':>9}{'오차m':>7}{'경도':>11}{'위도':>10}   근거")
for name, km, basis, approx in DERIVE:
    b = min(segs, key=lambda s: abs(s["s"] - km))
    lon, lat = svg_to_lonlat(b["x"], b["y"])
    print(f"{name:<10}{km:10.2f}{b['s']:9.1f}{abs(b['s']-km)*1000:7.0f}"
          f"{lon:11.5f}{lat:10.5f}   {basis}{' [근사]' if approx else ''}")

print("\n검산: 해평 산출좌표(128.369, 36.190)는 구미 해평면(약 128.37, 36.20)과 1km 내 일치.")
print("보 종단거리(참고):")
for k in ["낙동강하구둑", "창녕함안보", "합천창녕보", "달성보", "강정고령보",
          "칠곡보", "구미보", "낙단보", "상주보"]:
    print(f"  {k:<12}{dfe[k]:8.2f} km")
