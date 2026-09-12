"""Chl-a 고농도 빈도를 3D 지도에 얹을 수 있는 형태로 내보낸다.

왜: 침수(홍수)와 Chl-a(녹조)를 한 화면에서 보려면 둘 다 같은 좌표계로 있어야 한다.
    2D 대시보드는 SVG 화면좌표를 쓰고 3D 는 EPSG:5186 격자를 쓰므로, 여기서
    구간 폴리곤의 실제 좌표에 빈도를 붙여 내보낸다.

값의 정의 — **대시보드 취약구간 순위·논문과 같은 컬럼을 쓴다.**
  all : 07a_분석데이터.csv 의 freq_2019_2025 (전기간 pooled 초과빈도, %)
  jja : 08b_JJA_분석데이터.csv 의 freq_JJA_pct (여름 전용)
  초과빈도 = Sentinel-2 추정 Chl-a 가 25 mg/m³ 를 넘은 관측일 비율(%)

  처음에는 07k 시계열 JSON 의 28개 계절 프레임을 평균했는데, 그러면 같은 구간의
  값이 대시보드 TOP10 과 달라진다(예 s=218.7km: 75.2% vs 73.9%). 한 제품 안에
  뜻이 다른 "빈도" 가 두 개 생기므로 분석·논문이 쓰는 컬럼으로 통일했다.

실행: .venv/bin/python 10_flood/10e_chla레이어.py
"""
import json
import pathlib

import geopandas as gpd
import numpy as np

BASE = pathlib.Path(__file__).resolve().parent
MORPH = BASE.parent
OUT = MORPH / "09_manuscript" / "dashboard" / "flood"

# 조류경보 4지점 — 종단거리는 10d/지점위치산출 과 같은 근거를 쓴다
ALGAE = [
    ("해평",     213.38, False, "칠곡보 상류 22km"),
    ("강정고령", 172.91, False, "강정고령보 상류 7km"),
    ("칠서",     86.14,  False, "창녕함안보 상류 12km"),
    ("물금매리", 20.92,  True,  "양산천 합류부 기준 근사"),
]


def main():
    import pandas as pd
    a07 = pd.read_csv(MORPH / "07_stats" / "07a_분석데이터.csv")
    jja = pd.read_csv(MORPH / "08_review" / "08b_JJA_분석데이터.csv")
    print(f"전기간 {len(a07)}구간 / 여름 {len(jja)}구간(여름 결측 구간은 제외됨)")
    freq_all = dict(zip(a07.seg_id.astype(int), a07.freq_2019_2025.astype(float)))
    freq_jja = dict(zip(jja.seg_id.astype(int), jja.freq_JJA_pct.astype(float)))

    shp = gpd.read_file(MORPH / "06_morph" / "06_종단구간.shp")
    cent = shp.geometry.centroid
    out_segs = []
    for r, x, y in zip(shp.itertuples(), cent.x, cent.y):
        sid = int(r.SEG_ID)
        fa, fj = freq_all.get(sid), freq_jja.get(sid)
        out_segs.append({
            "x": round(float(x), 1), "y": round(float(y), 1),
            "s": round(float(r.S_KM), 1), "pool": int(r.POOL_ID),
            "all": None if fa is None else round(fa, 1),
            "jja": None if fj is None else round(fj, 1),
        })
    out_segs.sort(key=lambda z: z["s"])
    va = np.array([r["all"] for r in out_segs if r["all"] is not None])
    vj = np.array([r["jja"] for r in out_segs if r["jja"] is not None])
    print(f"  좌표 붙은 구간 {len(out_segs)}개 "
          f"(전기간 값 {len(va)}개 / 여름 값 {len(vj)}개)")
    print(f"  전기간 {va.min():.1f}~{va.max():.1f}% (중위 {np.median(va):.1f})")
    print(f"  여름   {vj.min():.1f}~{vj.max():.1f}% (중위 {np.median(vj):.1f})")
    mean_all, mean_jja = va, vj

    # 조류경보 지점: 종단거리에 가장 가까운 구간의 좌표
    stations = []
    for name, skm, approx, basis in ALGAE:
        b = min(out_segs, key=lambda r: abs(r["s"] - skm))
        stations.append({"name": name, "s": skm, "x": b["x"], "y": b["y"],
                         "approx": approx, "basis": basis,
                         "match_err_m": round(abs(b["s"] - skm) * 1000)})
        print(f"  {name:<8} s={skm:7.2f} → 구간 s={b['s']:6.1f} "
              f"(오차 {stations[-1]['match_err_m']} m)")

    top = sorted([r for r in out_segs if r["all"] is not None],
                 key=lambda r: -r["all"])[:10]
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "chla.json"
    path.write_text(json.dumps({
        "note": ("초과빈도 = Sentinel-2 추정 Chl-a > 25 mg/m³ 관측일 비율(%). "
                 "all=07a freq_2019_2025(전기간 pooled), jja=08b freq_JJA_pct. "
                 "대시보드 취약구간 순위·논문과 같은 컬럼."),
        "range_all": [round(float(mean_all.min()), 1), round(float(mean_all.max()), 1)],
        "range_jja": [round(float(mean_jja.min()), 1), round(float(mean_jja.max()), 1)],
        "top10_all": [{"s": r["s"], "pool": r["pool"], "freq": r["all"]} for r in top],
        "segments": out_segs,
        "stations": stations,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"\n저장: {path} ({path.stat().st_size/1024:.0f} KB)")
    print("취약 상위 5구간:", ", ".join(f"s={r['s']}km {r['all']}%" for r in top[:5]))


if __name__ == "__main__":
    main()
