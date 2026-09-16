"""수질자동측정망 시간자료 — 전국 77개 지점의 최근 Chl-a·수온 등.

사용법: python scripts/fetch_auto.py [--refresh-points]

**왜 이 경로인가** — 공공데이터포털의 "수질자동측정망(실시간)" API 는 이름과 달리
실시간이 아니다. 일평균 1행이고 2026-09-16 기준 최신 자료가 2026-07-23 이었다(약 55일 지연).
확정자료만 주기 때문이다. 시간 단위 자료는 물환경정보시스템의 미확정자료 쪽에만 있다.

  공식 API (data.go.kr 15081073)  일평균 · 지연 55일 · 키 필요
  여기서 쓰는 경로                 시간별 · 지연 1~2시간 · 키 불필요

**공식 문서화된 API 가 아니다.** 조류경보 지점 좌표(fetch_algae_points.py)와 같은 성격으로,
물환경정보시스템 웹페이지가 내부적으로 부르는 주소다. 사이트가 바뀌면 끊길 수 있으므로
실패해도 수집 전체가 죽지 않게 하고, 직전 결과를 유지한다.

**커버리지** — 77개 지점 중 Chl-a 를 보고하는 곳은 일부다(2026-09 기준 약 48곳).
낙동강 수계는 31곳이 있고 봉화·내성천처럼 Chl-a 를 재지 않는 지점도 있다.

**요청량** — 한 요청에 지점 5개까지만 안정적이다(16개 이상이면 오류 HTML 이 온다).
77개면 정시마다 16회, 하루 약 384회.
"""
import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

KST = timezone(timedelta(hours=9))
BASE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(BASE, "..", "data")
POINTS_CSV = os.path.join(OUT_DIR, "auto_points.csv")
OUT_JSON = os.path.join(OUT_DIR, "auto_latest.json")

FEATURE_URL = "https://water.nier.go.kr/web/autoSimpleMeasure/getAutoFeature"
HOURLY_URL = "https://water.nier.go.kr/web/autoMeasure/noConfirm/toastList"
# 기본 User-Agent 로 보내면 거부당한다(조류경보 좌표 엔드포인트와 같은 동작).
HEADERS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) nakdong-dashboard/1.0"}

BATCH = 5          # 실측: 5개는 100% 성공, 16개 이상은 항상 실패
RETRY = 3
BASIN = {"S01": "한강", "S02": "낙동강", "S03": "금강", "S04": "영산강·섬진강"}

# 쓸 항목만 고른다. VOCs 15종은 거의 ND 라 버린다.
ITEMS = {"chla": "IEM_CHLA", "temp": "IEM_WTRTP", "ph": "IEM_PH", "do": "IEM_DOC",
         "ec": "IEM_EC", "turbidity": "IEM_TUR", "toc": "IEM_TOC",
         "tn": "IEM_TN", "tp": "IEM_TP"}


def num(v):
    """'운전정지'·'장비점검'·'미조사항목' 같은 문자열이 값 자리에 온다."""
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


def fetch_points():
    """지점 목록과 좌표. 값(ITEM_VAL)도 오지만 여기서는 좌표만 쓴다."""
    r = requests.post(FEATURE_URL, data={"flag": "C"}, headers=HEADERS, timeout=40)
    r.raise_for_status()
    d = r.json()
    rows = d if isinstance(d, list) else d.get("list", [])
    out = [{"code": x["WQAMN_CODE"], "name": x["WQAMN_NM"],
            "basin": BASIN.get(x["WQAMN_CODE"][:3], "기타"),
            "lat": x["LA"], "lon": x["LO"]} for x in rows]
    bad = [p for p in out if not (33 <= p["lat"] <= 39 and 124 <= p["lon"] <= 132)]
    if bad:
        sys.exit(f"좌표가 국내 범위를 벗어난 지점 {len(bad)}개 — 응답 형식이 바뀌었을 수 있습니다.")
    return out


def load_points(refresh=False):
    if refresh or not os.path.exists(POINTS_CSV):
        pts = fetch_points()
        with open(POINTS_CSV, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=["code", "name", "basin", "lat", "lon"])
            w.writeheader()
            w.writerows(pts)
        print(f"지점 좌표 {len(pts)}개 갱신: {POINTS_CSV}")
        return pts
    with open(POINTS_CSV, encoding="utf-8-sig") as f:
        return [{**r, "lat": float(r["lat"]), "lon": float(r["lon"])}
                for r in csv.DictReader(f)]


def fetch_hourly(codes, day):
    """지점 몇 곳의 하루치 시간자료. 실패하면 오류 HTML 이 오므로 형태로 판별한다."""
    ymd, iso = day.strftime("%Y%m%d"), day.strftime("%Y-%m-%d")
    body = [("pMENU_NO", "574"), ("page", "1"), ("querySn", "61"), ("queryTp", "autoMe"),
            ("confirmNum", "1"), ("ATTR_2", ymd), ("ATTR_3", ymd),
            ("pStartDay", iso), ("pEndDay", iso), ("pageSize", "10")]
    body += [("station_code", c) for c in codes]
    for attempt in range(RETRY):
        try:
            r = requests.post(HOURLY_URL, data=body, headers=HEADERS, timeout=60)
            if r.status_code == 200 and r.text.lstrip().startswith("{"):
                return r.json().get("list", []) or []
        except requests.RequestException as e:
            print(f"  요청 실패({attempt + 1}/{RETRY}): {type(e).__name__}", file=sys.stderr)
        time.sleep(3)
    print(f"  포기: {','.join(codes)}", file=sys.stderr)
    return []


def latest_by_station(rows):
    """지점별로 '값이 있는 가장 최근 시각'을 고른다. 항목마다 결측 시각이 다를 수 있어
    항목별로 각각 최신값을 취한다 — Chl-a 만 비어 있고 수온은 들어온 시각이 있다."""
    best = {}
    for x in sorted(rows, key=lambda r: r.get("MESURE_DT") or ""):
        code = x.get("WQAMN_CODE")
        if not code:
            continue
        cur = best.setdefault(code, {"time": None, "grade": None})
        got = False
        for key, field in ITEMS.items():
            v = num(x.get(field))
            if v is not None:
                cur[key] = v
                cur[f"{key}_time"] = x.get("MESURE_DT")
                got = True
        if got:
            cur["time"] = x.get("MESURE_DT")
            cur["grade"] = x.get("WQI_GRADE")
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh-points", action="store_true",
                    help="지점 좌표표를 다시 받는다(평소에는 캐시를 쓴다)")
    args = ap.parse_args()

    pts = load_points(args.refresh_points)
    codes = [p["code"] for p in pts]
    now = datetime.now(KST)

    rows = []
    for i in range(0, len(codes), BATCH):
        rows += fetch_hourly(codes[i:i + BATCH], now)
    # 자정 직후에는 당일 자료가 아직 비어 있을 수 있다 → 전날을 한 번 더 본다.
    if not any(num(x.get("IEM_CHLA")) is not None for x in rows):
        print("당일 자료가 비어 있어 전날을 조회합니다.")
        y = now - timedelta(days=1)
        for i in range(0, len(codes), BATCH):
            rows += fetch_hourly(codes[i:i + BATCH], y)

    best = latest_by_station(rows)
    out = []
    for p in pts:
        b = best.get(p["code"], {})
        out.append({**{k: p[k] for k in ("code", "name", "basin", "lat", "lon")},
                    "time": b.get("time"), "grade": b.get("grade"),
                    **{k: b.get(k) for k in ITEMS}})
    out.sort(key=lambda r: (r["basin"], r["name"]))

    n_chla = sum(1 for r in out if r["chla"] is not None)
    times = sorted({r["time"] for r in out if r["time"]})
    print(f"지점 {len(out)}개 · Chl-a 보고 {n_chla}개 · 최신 시각 {times[-1] if times else '없음'}")
    for basin in ("낙동강", "한강", "금강", "영산강·섬진강"):
        g = [r for r in out if r["basin"] == basin and r["chla"] is not None]
        if g:
            top = max(g, key=lambda r: r["chla"])
            print(f"  {basin:9s} {len(g):2d}곳  최고 {top['name']} {top['chla']:.1f} mg/m³")

    if n_chla == 0:
        print("경고: Chl-a 를 받은 지점이 없습니다 — 직전 결과를 유지합니다.", file=sys.stderr)
        sys.exit(1)

    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump({
            "updated_at": now.isoformat(),
            "source": "물환경정보시스템 수질자동측정망 미확정자료(시간별)",
            "note": ("공식 문서화된 OpenAPI 가 아니라 웹페이지 내부 조회 경로다. "
                     "지연 1~2시간. 77개 지점 중 Chl-a 를 보고하는 곳만 값이 있다."),
            "rows": out,
        }, f, ensure_ascii=False, separators=(",", ":"))
    print("저장:", OUT_JSON)


if __name__ == "__main__":
    main()
