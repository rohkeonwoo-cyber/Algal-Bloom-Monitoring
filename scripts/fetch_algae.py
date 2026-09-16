"""조류경보제 최신 관측값 — **전국 68개 지점**.

사용법: DATA_GO_KR_KEY="키" python scripts/fetch_algae.py
(08_review/08d_경보제비교.py 의 수집 로직을 재사용. 전체 이력 대신 "최근 1건"만 뽑는다.)

**전국을 받는 이유** — 이 API 는 ptNoList 를 주지 않으면 전국을 그대로 돌려준다.
지점 4곳을 하드코딩하던 것을 풀었을 뿐이므로 확장 비용이 사실상 없다(ADR-007).
2026년 기준 고유 지점 68개 · 수역 40개(하천 16개 보 포함, 호소 24개).

**지점명 정규화** — API 는 `강정·고령`, `물금·매리` 처럼 가운뎃점을 넣어 주는데
기존 대시보드는 `강정고령`, `물금매리` 로 찾는다. 정규화하지 않으면 화면에서
지점이 사라지므로 `station` 에는 가운뎃점을 뺀 이름을 넣는다(원본은 station_raw 로 보존).

**조회 기간** — 올해 전체(1~3월이면 작년까지)를 한 번에 받는다. 지점 목록과 최신값을
한 번의 조회로 같이 얻기 위해서다. 최근 몇 달만 받으면 겨울철에 관측이 없는 지점이
목록에서 통째로 빠진다.

**등급 판정** — `level` 은 **최근 2회 연속 채수가 모두 기준을 넘을 때** 그 단계로 본다.
조류경보 발령 기준에 맞춘 것이다. 최근 1건만 보는 값은 `level_latest` 로 함께 내보낸다
(한 번 튄 값과 실제 상승을 구분해 보기 위한 참고값).

다만 이것도 **추정이다.** 발령 주체는 유역환경청이고, 공식 발령 상태는 게시판이 더 빠르다.
화면에는 "경보 발령"이 아니라 "세포수 기준 판정"임이 드러나야 한다.

**좌표** — data/algae_points.csv(scripts/fetch_algae_points.py 로 받은 고정 표)를
SWMN_CODE 로 조인해 붙인다. 조회 API 자체에는 위경도가 없다.
"""
import os
import sys
import json
import requests
from datetime import datetime, timezone, timedelta

KEY = os.environ.get("DATA_GO_KR_KEY")
if not KEY:
    sys.exit("환경변수 DATA_GO_KR_KEY 가 없습니다.")

URL = "https://apis.data.go.kr/1480523/nieragainstalgae/algaePreMeasure"
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
os.makedirs(OUT_DIR, exist_ok=True)

KST = timezone(timedelta(hours=9))
ALL_MONTHS = ",".join(f"{m:02d}" for m in range(1, 13))
PAGE_ROWS = 999
MAX_PAGES = 12          # 안전장치. 한 해 기록이 약 2,600건이므로 3페이지면 충분하다.


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


def level_consecutive(cells):
    """유해남조류 세포수 최근 2건으로 판정. 둘 다 같은 기준을 넘어야 그 단계로 본다.

    조류경보 발령이 2회 연속 초과 조건이라 이를 따른다. 한 번 튄 값으로 단계가 오르내리는
    것을 막는 효과도 있다.

    cells: 오래된 것 → 최신 순. 1건뿐이면 그 값으로 판정한다(판정 근거가 약하므로
    호출부에서 basis 로 몇 건을 썼는지 같이 내보낸다).
    """
    vals = [c for c in cells if c is not None][-2:]
    if not vals:
        return None, 0
    if len(vals) == 1:
        return level_of(vals[0]), 1
    for thr, name in ((1_000_000, "대발생"), (10_000, "경계"), (1_000, "관심")):
        if all(v >= thr for v in vals):
            return name, 2
    return "정상", 2


def load_points():
    """고정해 둔 지점 좌표표. 없으면 좌표 없이 진행한다(수집 자체는 막지 않는다)."""
    path = os.path.join(os.path.dirname(__file__), "..", "data", "algae_points.csv")
    if not os.path.exists(path):
        print("경고: data/algae_points.csv 없음 — 좌표 없이 진행합니다.", file=sys.stderr)
        return {}
    import csv
    with open(path, encoding="utf-8-sig") as f:
        return {r["SWMN_CODE"]: (float(r["LAT"]), float(r["LON"])) for r in csv.DictReader(f)}


def norm_name(s):
    """`강정·고령` → `강정고령`. 기존 대시보드가 찾는 이름 형태로 맞춘다."""
    return (s or "").replace("·", "").replace(" ", "").strip()


def fetch_year(year):
    """한 해 기록 전체를 페이징으로 받는다."""
    rows, page = [], 1
    while page <= MAX_PAGES:
        r = requests.get(URL, params={
            "serviceKey": KEY, "pageNo": page, "numOfRows": PAGE_ROWS,
            "resultType": "json", "wmyrList": str(year), "wmodList": ALL_MONTHS,
        }, timeout=60)
        r.raise_for_status()
        body = r.json().get("algaePreMeasure", {})
        items = body.get("item", []) or []
        rows.extend(items)
        if len(items) < PAGE_ROWS:
            break
        page += 1
    return rows


def collect():
    now = datetime.now(KST)
    years = [now.year] if now.month > 3 else [now.year, now.year - 1]
    raw = []
    for y in years:
        got = fetch_year(y)
        print(f"{y}년 기록 {len(got)}건")
        raw.extend(got)

    by_station = {}
    for it in raw:
        by_station.setdefault(it["SWMN_CODE"], []).append(it)

    points = load_points()
    out = []
    for code, items in by_station.items():
        items.sort(key=lambda x: x["CHCK_DE"])
        newest = items[-1]
        # 가장 최근 채수일이라도 세포수가 아직 '분석중'일 수 있다 →
        # 등급 판정은 수치가 나온 최근 기록으로 하고, 분석중 여부는 따로 표시한다.
        analyzed = [it for it in items if num(it.get("IEM_BGALAGE_CELL_CO")) is not None]
        base = analyzed[-1] if analyzed else newest
        cell = num(base.get("IEM_BGALAGE_CELL_CO"))
        lv2, basis_n = level_consecutive([num(it.get("IEM_BGALAGE_CELL_CO")) for it in analyzed])
        lat, lon = points.get(code, (None, None))
        out.append({
            "code": code,
            "lat": lat, "lon": lon,
            "station": norm_name(base.get("SWMN_DETAIL_NM")),
            "station_raw": base.get("SWMN_DETAIL_NM"),
            "water": base.get("SWMN_NM"),               # 수역 (낙동강, 대청호 …)
            "kind": base.get("RIVER_LKMH_SE"),          # 하천 / 호소
            "addr": base.get("DETAIL_ADRES"),
            "date": base["CHCK_DE"],                    # 등급 판정에 쓴 기록의 채수일
            "chla": num(base.get("IEM_CHLA")),
            "cell_count": cell,
            "temp": num(base.get("IEM_WTRTP")),
            "level": lv2,                               # 화면이 쓰는 값 (2회 연속 기준)
            "level_latest": level_of(cell),             # 참고: 최근 1건만 본 값
            "level_basis_n": basis_n,                   # 판정에 쓴 채수 건수 (1이면 근거 약함)
            "pending": newest["CHCK_DE"] != base["CHCK_DE"],   # 더 최근 채수분이 분석중인지
            "pending_date": newest["CHCK_DE"] if newest["CHCK_DE"] != base["CHCK_DE"] else None,
        })
    out.sort(key=lambda r: (r["water"] or "", r["station"] or ""))
    return out


if __name__ == "__main__":
    rows = collect()
    waters = {r["water"] for r in rows}
    tally = {}
    for r in rows:
        tally[r["level"] or "관측없음"] = tally.get(r["level"] or "관측없음", 0) + 1
    no_xy = [r for r in rows if r["lat"] is None]
    print(f"지점 {len(rows)}개 · 수역 {len(waters)}개 · 좌표 없는 지점 {len(no_xy)}개")
    print("  단계별:", ", ".join(f"{k} {v}" for k, v in sorted(tally.items())))
    for r in rows:
        if r["level"] in ("관심", "경계", "대발생"):
            print(f"  [{r['level']}] {r['water']} {r['station']} "
                  f"{r['cell_count']:,.0f} cells/mL ({r['date']})")

    out = {
        "updated_at": datetime.now(KST).isoformat(),
        "source": "data.go.kr 15126738 (국립환경과학원_조류경보제 조회서비스)",
        "note": ("level 은 최근 2회 연속 채수가 모두 기준을 넘을 때 그 단계로 본 값"
                 "(조류경보 발령 기준). level_latest 는 최근 1건만 본 참고값. "
                 "공식 발령 상태는 유역환경청 발표가 기준이다."),
        "rows": rows,
    }
    path = os.path.join(OUT_DIR, "algae_latest.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("저장:", path)
