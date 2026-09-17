"""3D 뷰어 두 페이지(침수·녹조)를 부품에서 조립한다.

왜 빌드인가 — 두 화면은 지형·카메라·조작·브이월드 타일 코드를 공유한다. 파일을 그냥
나누면 되지 않는 이유는 이 코드가 하나의 IIFE 안에 있어서다(전역을 더럽히지 않으려고
그렇게 짰다). 그래서 부품으로 나눠 두고 빌드할 때 한 덩어리로 합친다.
index.html 을 template.html 에서 만드는 방식(build_index.py)과 같은 결이다.

부품 (build/viewer/)
  base.head.html   <head> 공통
  base.css         공통 스타일
  core.js          지형·물·카메라·조작·브이월드 타일·지점 판독  ← 두 페이지 공통
  flood.body.html  침수 페이지 본문        flood.js  침수 UI
  chla.body.html   녹조 페이지 본문        chla.js   녹조 리본 + chla.page.js 녹조 UI

출력
  flood/index.html   침수 시나리오
  chla/index.html    녹조 분포

실행: python3 build/build_viewer.py      (저장소 루트에서)

**원본은 이 저장소의 build/viewer/ 다.** flood/index.html, chla/index.html 은 빌드 결과물이므로
직접 고치지 말 것 — 다음 빌드에서 덮어써진다.
"""
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
V = HERE / "viewer"
DASH = HERE.parent          # 저장소 루트 — flood/ chla/ 에 바로 쓴다

PAGES = {
    "flood": {"title": "낙동강 침수 시나리오 3D", "body": "flood.body.html",
              "js": ["core.js", "buildings.js", "live.js", "controls.js", "flood.js"], "out": DASH / "flood" / "index.html"},
    "chla": {"title": "낙동강 녹조 분포 3D", "body": "chla.body.html",
             "js": ["core.js", "buildings.js", "controls.js", "chla.js", "chla.page.js"],
             "out": DASH / "chla" / "index.html"},
}


def build(name, cfg):
    head = (V / "base.head.html").read_text(encoding="utf-8")
    head = head.replace("낙동강 침수 시나리오 3D", cfg["title"])
    css = (V / "base.css").read_text(encoding="utf-8")
    body = (V / cfg["body"]).read_text(encoding="utf-8")
    body = body.replace("__CONTROLS__", (V / "controls.body.html").read_text(encoding="utf-8"))
    js = "\n".join((V / f).read_text(encoding="utf-8") for f in cfg["js"])

    html = f"""{head}<style>
{css}</style>
{body}
<script src="{'../flood/vworld-key.js' if name != 'flood' else 'vworld-key.js'}" onerror="window.VWORLD_KEY=null"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script>
(function(){{
"use strict";
{js}
boot();
}})();
</script>
"""
    cfg["out"].parent.mkdir(parents=True, exist_ok=True)
    cfg["out"].write_text(html, encoding="utf-8")
    print(f"  {name:6s} → {cfg['out'].relative_to(DASH)}  {len(html)/1024:.1f} KB")


if __name__ == "__main__":
    print("3D 뷰어 조립")
    for n, c in PAGES.items():
        if not (V / c["body"]).exists():
            print(f"  {n:6s} 건너뜀 (부품 없음: {c['body']})")
            continue
        build(n, c)
