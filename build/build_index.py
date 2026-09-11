"""대시보드 index.html 빌드.

template.html 의 자리표시자를 실제 데이터로 치환해 단일 HTML 파일을 만든다.
위성 배경은 용량이 커서(약 3.9MB base64) 외부 요청 없이 data URI 로 심어 넣는다 —
GitHub Pages 에서 추가 파일 요청 없이 한 번에 뜨게 하는 것이 목적.

  python3 build/build_index.py            # index.html 갱신
  python3 build/build_index.py --out /tmp/preview.html

치환 대상:
  __DATA_JSON__        07k 시계열 지도데이터(구간좌표·프레임·보·도시·인셋)
  __ANALYSIS_JSON__    분석 패널 데이터(취약구간·pool순위·JJA 상대위치)
  __SAT_BG_DATAURI__   Sentinel-2 TCI 모자이크 배경
"""
import argparse
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent          # .../dashboard/build
DASH = HERE.parent                                      # .../dashboard
MORPH = DASH.parent.parent                              # .../morphology

TEMPLATE = HERE / "template.html"
DATA_JSON = MORPH / "07_stats" / "07k_시계열지도데이터_확장bbox.json"
ANALYSIS_JSON = DASH / "analysis_panel_data.json"
SAT_B64 = HERE / "sat_bg_png_b64.txt"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(DASH / "index.html"))
    ap.add_argument("--no-sat", action="store_true",
                    help="위성배경 없이 빌드(미리보기용, 용량 3.9MB 절약)")
    args = ap.parse_args()

    missing = [p for p in (TEMPLATE, DATA_JSON, ANALYSIS_JSON) if not p.exists()]
    if not args.no_sat and not SAT_B64.exists():
        missing.append(SAT_B64)
    if missing:
        for p in missing:
            print(f"없음: {p}", file=sys.stderr)
        sys.exit(1)

    html = TEMPLATE.read_text(encoding="utf-8")
    for ph, path in (("__DATA_JSON__", DATA_JSON), ("__ANALYSIS_JSON__", ANALYSIS_JSON)):
        if ph not in html:
            sys.exit(f"템플릿에 자리표시자 {ph} 가 없습니다.")
        html = html.replace(ph, path.read_text(encoding="utf-8").strip())

    if args.no_sat:
        # 템플릿은 `"__SAT_BG_DATAURI__" || null` 로 읽으므로 빈 문자열이면 배경을 건너뛴다
        html = html.replace("__SAT_BG_DATAURI__", "")
    else:
        b64 = SAT_B64.read_text(encoding="utf-8").strip()
        html = html.replace("__SAT_BG_DATAURI__", f"data:image/png;base64,{b64}")

    out = pathlib.Path(args.out)
    out.write_text(html, encoding="utf-8")
    print(f"생성: {out} ({out.stat().st_size/1024/1024:.2f} MB)")


if __name__ == "__main__":
    main()
