"""
조류경보제 최신 관측값(실시간 카드용) — 08_review/08d_경보제비교.py 의 수집 로직을 재사용,
전체 이력 대신 "최근 1건"만 뽑아 가볍게 저장한다.

사용법: DATA_GO_KR_KEY="키" python scripts/fetch_algae.py
(이 키는 이전에 이미 발급받은 것과 동일 — 08_review/08d_조류경보_원자료.csv 수집 때 쓴 키)
"""
import os
import sys
import json
import requests
from datetime import datetime, timezone, timedelta

KEY = os.environ.get("DATA_GO_KR_KEY")
if not KEY:
    sys.exit("환경변수 DATA_GO_KR_KEY 가 없습니다.")

STATIONS = {"강정고령": "2011G56", "칠서": "2020G33", "물금매리": "2022G05", "해평": "2011G26"}
URL = "https://apis.data.go.kr/1480523/nieragainstalgae/algaePreMeasure"
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
os.makedirs(OUT_DIR, exist_ok=True)


def num(v):
    """실측값이 아직 안 나온 기록은 '분석중' 같은 문자열로 오므로 안전하게 걸러낸다."""
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


def level_of(cell_count):
    if cell_count is None:
        return None
    if cell_count >= 1_000_000:
        return "대발생"
    if cell_count >= 10_000:
        return "경계"
    if cell_count >= 1_000:
        return "관심"
    return "정상"


def latest_for(name, pt_no):
    now = datetime.now(timezone(timedelta(hours=9)))
    years = ",".join(str(y) for y in range(now.year - 1, now.year + 1))
    params = {
        "serviceKey": KEY, "pageNo": 1, "numOfRows": 999, "resultType": "json",
        "ptNoList": pt_no, "wmyrList": years,
        "wmodList": ",".join(f"{m:02d}" for m in range(1, 13)),
    }
    r = requests.get(URL, params=params, timeout=30)
    r.raise_for_status()
    items = r.json().get("algaePreMeasure", {}).get("item", [])
    if not items:
        return {"station": name, "date": None, "chla": None, "cell_count": None,
                "level": None, "pending": False}
    items.sort(key=lambda x: x["CHCK_DE"])

    newest = items[-1]
    # 가장 최근 채수일이라도 세포수가 아직 '분석중'일 수 있다 →
    # 등급 판정은 수치가 나온 최근 기록으로 하고, 분석중 여부는 따로 표시한다.
    analyzed = [it for it in items if num(it.get("IEM_BGALAGE_CELL_CO")) is not None]
    base = analyzed[-1] if analyzed else newest
    cell = num(base.get("IEM_BGALAGE_CELL_CO"))
    return {
        "station": name,
        "date": base["CHCK_DE"],                    # 등급 판정에 쓴 기록의 채수일
        "chla": num(base.get("IEM_CHLA")),
        "cell_count": cell,
        "level": level_of(cell),
        "pending": newest["CHCK_DE"] != base["CHCK_DE"],   # 더 최근 채수분이 분석중인지
        "pending_date": newest["CHCK_DE"] if newest["CHCK_DE"] != base["CHCK_DE"] else None,
    }


if __name__ == "__main__":
    rows = [latest_for(name, pt) for name, pt in STATIONS.items()]
    for r in rows:
        print(" ", r)
    out = {
        "updated_at": datetime.now(timezone(timedelta(hours=9))).isoformat(),
        "source": "data.go.kr 15126738 (국립환경과학원_조류경보제 조회서비스)",
        "rows": rows,
    }
    path = os.path.join(OUT_DIR, "algae_latest.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("저장:", path)
