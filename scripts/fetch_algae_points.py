"""조류경보제 지점의 위경도 — 한 번 받아 data/algae_points.csv 로 고정해 둔다.

사용법: python scripts/fetch_algae_points.py      (인증키 불필요)

**왜 따로 받는가** — 조류경보제 조회 API(data.go.kr 15126738)는 지점명과 주소만 주고
위경도를 주지 않는다. 서비스에 오퍼레이션이 `algaePreMeasure` 하나뿐이라 좌표를 얻을
다른 경로가 없다. 국가 수질측정망 측정소 정보에도 조류경보제 지점(G 계열 코드)은 없다.

**출처** — 물환경정보시스템(water.nier.go.kr)의 조류경보제 자료조회 페이지가 "지점선택"
팝업에서 호출하는 내부 엔드포인트. **공식 문서화된 OpenAPI 가 아니다.** 인증키·쿠키 없이
동작하지만 사이트 개편 시 사라질 수 있으므로, 매시 호출하지 말고 **받아서 CSV 로 고정**해
두고 쓴다. 지점 좌표는 거의 변하지 않는다.

**조인 키** — 응답의 SWMN_CODE 가 조회 API 의 SWMN_CODE 와 같은 체계라 1:1 로 붙는다.
이름 대조가 필요 없다(`강정·고령` 대 `강정고령` 같은 표기 차이에 영향받지 않는다).

**좌표 형식** — 도/분/초가 분리되어 오므로 십진도로 바꾼다.
"""
import csv
import pathlib
import sys

import requests

URL = "https://water.nier.go.kr/web/algaePreMeasure/toastList"
OUT = pathlib.Path(__file__).resolve().parent.parent / "data" / "algae_points.csv"

# 구분코드 — water.nier.go.kr/web/codeUtil/codeListAjax (pType=0, ATTR_1=2234) 에서 확인
GUBUN = [("S", "상수원구간"), ("C", "친수활동구간"),
         ("B", "조류관찰지점"), ("D", "농어촌저수지")]

# requests 기본 User-Agent 로 보내면 400 이 돌아온다(curl 로는 200). 서버가 UA 를 보고
# 거르는 것으로 보여 일반 브라우저/도구 UA 를 명시한다.
HEADERS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) nakdong-dashboard/1.0"}


def dms(deg, minute, sec):
    return round(deg + minute / 60 + sec / 3600, 6)


def main():
    rows = []
    for code, label in GUBUN:
        r = requests.post(URL, data={"ATTR_1": code, "ATTR_2": 1, "ATTR_3": "", "querySn": 52},
                          headers=HEADERS, timeout=40)
        r.raise_for_status()
        items = r.json().get("list", []) or []
        print(f"  {code} {label:10s} {len(items)}개")
        for it in items:
            rows.append({
                "GUBUN": code, "GUBUN_NM": label,
                "SWMN_CODE": it["SWMN_CODE"], "SWMN_NM": it["SWMN_NM"],
                "LAT": dms(it["LA_DEGR"], it["LA_MIN"], it["LA_SECND"]),
                "LON": dms(it["LO_DEGR"], it["LO_MIN"], it["LO_SECND"]),
                "ADRES": it.get("ADRES"), "INSTT": it.get("EXAMIN_INSTT_NM"),
            })
    if not rows:
        sys.exit("지점을 하나도 받지 못했습니다 — 엔드포인트가 바뀌었을 수 있습니다.")

    lats = [r["LAT"] for r in rows]
    lons = [r["LON"] for r in rows]
    if not (33 <= min(lats) and max(lats) <= 39 and 124 <= min(lons) and max(lons) <= 132):
        sys.exit(f"좌표가 국내 범위를 벗어납니다: 위도 {min(lats)}~{max(lats)}, "
                 f"경도 {min(lons)}~{max(lons)}")

    with open(OUT, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"지점 {len(rows)}개 저장: {OUT}")
    print(f"  위도 {min(lats):.3f}~{max(lats):.3f}  경도 {min(lons):.3f}~{max(lons):.3f}")


if __name__ == "__main__":
    main()
