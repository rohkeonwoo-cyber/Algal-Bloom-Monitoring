"""조류경보 4개 지점의 지도상 위치 — 공식 좌표 기반 산출과 검산.

**2026-09-16 변경: 역산 대신 공식 좌표를 쓴다.**

이전 방법(폐기): 조류경보 원자료의 SWMN_DETAIL_NM 에 기관이 적어둔 "○○보 상류 N km" 를
04_구조물.csv 의 보 종단거리(dfe_km)에 더해 위치를 역산했다. 위경도를 구할 데가 없어
공표된 상대위치만 쓴 것이었는데, **실제 좌표와 대조해 보니 2.8~8.0 km 어긋났다.**

현재 방법: 물환경정보시스템이 공개하는 지점 좌표표(dashboard 저장소의 data/algae_points.csv,
scripts/fetch_algae_points.py 로 수집)를 SWMN_CODE 로 조인해 쓴다. EPSG:5186 으로 투영한 뒤
가장 가까운 종단구간의 s(km) 를 지점의 종단거리로 삼는다.

검산 두 가지:
  1. 본류 중심선까지의 거리 — 실제 강 위의 지점이면 작아야 한다.
  2. 역투영 지명 대조 — 좌표를 위경도로 되돌려 주소와 맞는지 본다.

실행: .venv/bin/python build/지점위치산출.py   (pyproj 필요)
"""
import csv
import json
import pathlib

from pyproj import Transformer

HERE = pathlib.Path(__file__).resolve().parent
MORPH = HERE.parent.parent.parent
# 좌표표는 dashboard 저장소에 있다. 작업 중이면 워크트리 쪽에만 있을 수 있으므로 둘 다 본다.
POINT_CANDIDATES = [
    pathlib.Path("/home/gw/Algal-Bloom-Monitoring/data/algae_points.csv"),
    pathlib.Path("/home/gw/nakdong-work/data/algae_points.csv"),
]

# 조류경보제 지점코드 (data.go.kr 15126738 의 SWMN_CODE 와 같은 체계)
STATIONS = [("해평", "2011G26"), ("강정고령", "2011G56"),
            ("칠서", "2020G33"), ("물금매리", "2022G05")]

# 옛 역산값 — 얼마나 틀렸는지 보여주기 위해 남겨 둔다
OLD_S = {"해평": 213.38, "강정고령": 172.91, "칠서": 86.14, "물금매리": 20.92}

d = json.loads((MORPH / "07_stats" / "07k_시계열지도데이터_확장bbox.json").read_text(encoding="utf-8"))
W, H, PAD = d["W"], d["H"], d["PAD"]
MINX, MAXX, MINY, MAXY = d["MINX"], d["MAXX"], d["MINY"], d["MAXY"]
fwd = Transformer.from_crs("EPSG:4326", "EPSG:5186", always_xy=True)


def svg_to_tm(sx, sy):
    """07k 의 구간 좌표는 EPSG:5186 이 아니라 **화면좌표**다. 투영좌표로 되돌린다.

    (처음에 이걸 놓쳐 중심선까지의 거리가 500 km 로 나왔다. 검산이 그래서 있다.)
    """
    x = (sx - W * PAD) / (W * (1 - 2 * PAD)) * (MAXX - MINX) + MINX
    y = MAXY - (sy - H * PAD) / (H * (1 - 2 * PAD)) * (MAXY - MINY)
    return x, y


segs = [{"s": g["s"], "x": svg_to_tm(g["x"], g["y"])[0], "y": svg_to_tm(g["x"], g["y"])[1]}
        for g in d["segments"]]


def main():
    found = next((p for p in POINT_CANDIDATES if p.exists()), None)
    if found is None:
        raise SystemExit("좌표표가 없습니다. 찾아본 곳:\n  "
                         + "\n  ".join(str(p) for p in POINT_CANDIDATES)
                         + "\n먼저 dashboard 저장소에서 scripts/fetch_algae_points.py 를 실행하세요.")
    print(f"좌표표: {found}\n")
    with open(found, encoding="utf-8-sig") as f:
        pts = {r["SWMN_CODE"]: r for r in csv.DictReader(f)}

    print(f"{'지점':10s}{'공식 좌표':>22s}{'s(km)':>9s}{'옛 s':>9s}{'차이':>9s}"
          f"{'중심선까지':>11s}  주소")
    out = []
    for name, code in STATIONS:
        p = pts[code]
        lat, lon = float(p["LAT"]), float(p["LON"])
        X, Y = fwd.transform(lon, lat)
        best = min(segs, key=lambda s: (s["x"] - X) ** 2 + (s["y"] - Y) ** 2)
        dist = ((best["x"] - X) ** 2 + (best["y"] - Y) ** 2) ** 0.5
        ds = abs(best["s"] - OLD_S[name])
        print(f"{name:10s}{lat:10.5f},{lon:10.5f}{best['s']:9.1f}{OLD_S[name]:9.2f}"
              f"{ds:8.1f}km{dist:10.0f} m  {p['ADRES']}")
        out.append({"name": name, "code": code, "s": round(best["s"], 1),
                    "lat": lat, "lon": lon, "basis": p["ADRES"],
                    "centerline_m": round(dist)})

    far = [r for r in out if r["centerline_m"] > 1000]
    if far:
        print("\n경고: 본류 중심선에서 1 km 넘게 떨어진 지점이 있습니다 —", 
              ", ".join(r["name"] for r in far))

    print("\ntemplate.html 에 넣을 형태:")
    for r in out:
        print(f'  {{name:"{r["name"]}", s:{r["s"]}, approx:false, '
              f'basis:"{r["basis"]} (공식좌표)"}},')
    return out


if __name__ == "__main__":
    main()
