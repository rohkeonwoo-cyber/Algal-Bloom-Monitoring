"""
한강홍수통제소(HRFCO) Open API에서 낙동강 유역 실시간 수문자료를 받아
대시보드가 읽을 JSON으로 저장한다.

사용법:
  HRFCO_KEY="발급받은키" python scripts/fetch_hrfco.py

API 문서: https://www.hrfco.go.kr/web/openapiPage/reference.do
  URL 형식: https://api.hrfco.go.kr/{key}/{종류}/list/{시간단위}/{관측소코드}/{시작}/{끝}.json
  종류: waterlevel(수위) / rainfall(강수량) / dam / bo / fldfct(홍수예보발령, 발령시에만 존재)
  관측소 목록: https://api.hrfco.go.kr/{key}/{종류}/info.json
    -> WLOBSCD/RFOBSCD 등 관측소코드, OBSNM 명칭, LON/LAT 위경도,
       (수위만) ATTWL 관심 / WRNWL 주의 / ALMWL 경계 / SRSWL 심각 수위 기준값 포함

출력: data/hrfco_waterlevel.json, data/hrfco_rainfall.json, data/hrfco_fldfct.json
"""
import os
import sys
import json
import time
import urllib.request
from datetime import datetime, timezone, timedelta

KEY = os.environ.get("HRFCO_KEY")
if not KEY:
    sys.exit("환경변수 HRFCO_KEY 가 없습니다. https://www.hrfco.go.kr 에서 오픈API 인증키를 발급받아 "
              "HRFCO_KEY=\"키\" python scripts/fetch_hrfco.py 형태로 실행하세요.")

BASE = "https://api.hrfco.go.kr"
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
os.makedirs(OUT_DIR, exist_ok=True)

# 연구구간(하구둑~영강합류부, 동서로 확장한 촬영범위)과 동일한 위경도 박스
# 07k_넓은범위_재계산.py 의 bbox(EPSG:5186 293610~400570 / 278760~439530)를 위경도로 미리 환산해둠
LON_MIN, LON_MAX = 128.14, 129.10
LAT_MIN, LAT_MAX = 35.05, 36.60

# HRFCO 제약: "1분에 1000번 이상 3번 호출 시 인증키 차단". 관측소 수백 개를 돌 수 있으니
# 분당 600회(초당 10회) 이하로 여유를 두고 호출한다.
SLEEP = 0.1


def api_get(path):
    url = f"{BASE}/{KEY}/{path}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def dms_to_deg(v):
    """HRFCO 위경도는 '128-33-04'(도-분-초) 형식으로 오므로 십진도로 변환한다.
    (문서에는 LON/LAT 라고만 적혀 있으나 실제 응답은 소문자 키 + DMS 문자열)"""
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    try:
        if "-" in s:
            parts = [p for p in s.split("-") if p != ""]
            deg = float(parts[0])
            minute = float(parts[1]) if len(parts) > 1 else 0.0
            sec = float(parts[2]) if len(parts) > 2 else 0.0
            return deg + minute / 60 + sec / 3600
        return float(s)
    except (ValueError, IndexError):
        return None


def in_basin(lon, lat):
    lo, la = dms_to_deg(lon), dms_to_deg(lat)
    if lo is None or la is None:
        return False
    return LON_MIN <= lo <= LON_MAX and LAT_MIN <= la <= LAT_MAX


def fetch_waterlevel():
    info = api_get("waterlevel/info.json")["content"]
    stations = [s for s in info if in_basin(s.get("lon"), s.get("lat"))]
    print(f"수위 관측소: 전국 {len(info)}개 중 낙동강 유역 {len(stations)}개")

    rows = []
    for s in stations:
        code = s["wlobscd"]
        try:
            obs = api_get(f"waterlevel/list/1H/{code}/{_recent_range()}.json").get("content", [])
        except Exception as e:
            print(f"  {code}({s.get('obsnm')}) 조회 실패: {e}")
            continue
        obs = _sort_by_time(obs)   # API가 최신순으로 주므로 순서에 의존하지 않고 명시 정렬
        latest = obs[-1] if obs else None
        wl = _f(latest.get("wl")) if latest else None
        att, wrn, alm, srs = (_f(s.get("attwl")), _f(s.get("wrnwl")),
                               _f(s.get("almwl")), _f(s.get("srswl")))
        level, judgeable = risk_level(wl, att, wrn, alm, srs)
        t0, series = _hourly_series(obs, "wl")
        gdt = _f(s.get("gdt"))
        rows.append({
            "code": code, "name": s.get("obsnm"), "addr": s.get("addr"),
            "lon": dms_to_deg(s.get("lon")), "lat": dms_to_deg(s.get("lat")),
            # 공식 기준수위: 관심/주의/경계/심각 + 계획홍수위
            "attwl": att, "wrnwl": wrn, "almwl": alm, "srswl": srs,
            "pfh": _f(s.get("pfh")),
            # gdt = 수위표 영점표고. 관측수위·기준수위 모두 수위표 기준이므로
            # 해발표고(EL.m) = 값 + gdt. 침수범위 계산에 반드시 필요하다.
            "gdt": gdt,
            "is_forecast_point": s.get("fstnyn") == "Y",
            "latest_time": latest.get("ymdhm") if latest else None,
            "latest_wl": wl,
            "latest_fw": _f(latest.get("fw")) if latest else None,
            "risk_level": level,          # 정상/관심/주의/경계/심각 (기준수위 없으면 null)
            "risk_judgeable": judgeable,  # 기준수위가 유효해 판정 가능한 지점인지
            # 최근 30시간 정시 시계열 — API가 이미 주는 자료라 추가 호출이 없다.
            "series_t0": t0, "series": series,
            "delta_24h": _delta(series, 24),
        })
        time.sleep(SLEEP)
    n_judge = sum(1 for r in rows if r["risk_judgeable"])
    print(f"  위험등급 판정 가능: {n_judge}개 / 수집 {len(rows)}개")
    _save("hrfco_waterlevel.json", rows)


def fetch_rainfall():
    info = api_get("rainfall/info.json")["content"]
    stations = [s for s in info if in_basin(s.get("lon"), s.get("lat"))]
    print(f"강수 관측소: 전국 {len(info)}개 중 낙동강 유역 {len(stations)}개")

    rows = []
    for s in stations:
        code = s.get("rfobscd")
        try:
            obs = api_get(f"rainfall/list/1H/{code}/{_recent_range()}.json").get("content", [])
        except Exception as e:
            print(f"  {code}({s.get('obsnm')}) 조회 실패: {e}")
            continue
        recent = _sort_by_time(obs)[-24:] if obs else []
        sum24h = sum(_f(o.get("rf")) or 0 for o in recent)
        t0, series = _hourly_series(obs, "rf")
        rows.append({
            "code": code, "name": s.get("obsnm"), "addr": s.get("addr"),
            "lon": dms_to_deg(s.get("lon")), "lat": dms_to_deg(s.get("lat")),
            "latest_time": recent[-1].get("ymdhm") if recent else None,
            "latest_1h_mm": _f(recent[-1].get("rf")) if recent else None,
            "sum_24h_mm": round(sum24h, 1),
            "series_t0": t0, "series": series,   # 시간강수량(mm/h), 추가 호출 없음
        })
        time.sleep(SLEEP)
    _save("hrfco_rainfall.json", rows)


def fetch_fldfct():
    try:
        content = api_get("fldfct/list.json").get("content", [])
    except Exception as e:
        print("홍수예보발령 조회 실패(발령 없을 때 빈 응답일 수 있음):", e)
        content = []
    rows = [c for c in content
            if "낙동" in (c.get("rvrnm") or "") or "낙동" in (c.get("obsnm") or "")]
    print(f"홍수예보발령: 전체 {len(content)}건 중 낙동강 권역 {len(rows)}건")
    _save("hrfco_fldfct.json", rows)


def _sort_by_time(obs):
    """ymdhm 오름차순 정렬 — 마지막 원소가 항상 최신이 되도록."""
    return sorted(obs, key=lambda o: str(o.get("ymdhm") or ""))


def _hourly_series(obs, field, hours=30):
    """정시 격자에 맞춘 시계열 배열을 만든다.

    1H 자료의 ymdhm 은 12자리가 아니라 **10자리(YYYYMMDDHH)** 로 온다.
    관측이 빠진 시각은 None 으로 채워, 배열 인덱스가 곧 시각이 되게 한다
    (그래야 프런트에서 t0 하나만 알고 x축을 그릴 수 있다).
    반환: (t0, [값 또는 None, ...])  — 관측이 없으면 (None, [])
    """
    if not obs:
        return None, []
    now = datetime.now(timezone(timedelta(hours=9))).replace(minute=0, second=0, microsecond=0)
    grid = [(now - timedelta(hours=h)).strftime("%Y%m%d%H") for h in range(hours, -1, -1)]
    by_hour = {str(o.get("ymdhm") or "")[:10]: _f(o.get(field)) for o in obs}
    return grid[0], [by_hour.get(g) for g in grid]


def _delta(series, hours):
    """series 의 마지막 관측값과 hours 시간 전 관측값의 차이(없으면 None).
    수위가 '오르는 중인지'는 절대 수위보다 위험 판단에 중요하다."""
    vals = [(i, v) for i, v in enumerate(series) if v is not None]
    if len(vals) < 2:
        return None
    last_i, last_v = vals[-1]
    target = last_i - hours
    past = [(i, v) for i, v in vals if i <= target]
    if not past:
        past = [vals[0]]
    return round(last_v - past[-1][1], 3)


def _f(v):
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


def risk_level(wl, attwl, wrnwl, almwl, srswl):
    """현재 수위를 기관이 공표한 기준수위와 비교만 한다(위험도를 자체 계산하지 않음).
    댐 관측소 등은 기준수위가 0.0 placeholder로 오므로 유효값(>0)만 인정한다.
    반환: (등급, 판정가능여부)"""
    thr = [(srswl, "심각"), (almwl, "경계"), (wrnwl, "주의"), (attwl, "관심")]
    valid = [(t, name) for t, name in thr if t is not None and t > 0]
    if wl is None or not valid:
        return None, False
    for t, name in valid:  # 높은 등급부터 비교
        if wl >= t:
            return name, True
    return "정상", True


def _recent_range():
    now = datetime.now(timezone(timedelta(hours=9)))
    start = now - timedelta(hours=30)
    return f"{start.strftime('%Y%m%d%H%M')}/{now.strftime('%Y%m%d%H%M')}"


def _save(name, rows):
    out = {
        "updated_at": datetime.now(timezone(timedelta(hours=9))).isoformat(),
        "source": "한강홍수통제소(HRFCO) Open API",
        "n": len(rows),
        "rows": rows,
    }
    path = os.path.join(OUT_DIR, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"저장: {path} ({len(rows)}행)")


if __name__ == "__main__":
    fetch_waterlevel()
    fetch_rainfall()
    fetch_fldfct()
