# AGENTS.md — 낙동강 녹조·침수 모니터

이 저장소에서 작업하는 에이전트(Codex 등)와 사람을 위한 안내다.
**작업 전에 "어디를 고치나"와 "알려진 함정"을 먼저 읽을 것.** 대부분의 사고가 거기서 났다.

- 배포 주소: https://rohkeonwoo-cyber.github.io/Algal-Bloom-Monitoring/
- 배포 방식: `main` 에 푸시하면 GitHub Pages 가 그대로 서빙한다(빌드 단계 없음)
- 설계 판단의 근거: `docs/adr/` (001~011)

## 무엇이 있나

| 경로 | 화면 | 성격 |
|---|---|---|
| `index.html` | 낙동강 대시보드 (종단 SVG 지도) | **빌드 결과물** (6.6 MB) |
| `map/` | 전국 녹조 관측 지점 지도 (MapLibre) | 원본 그대로 서빙 |
| `flood/index.html` | 침수 시나리오 3D (three.js) | **빌드 결과물** |
| `chla/index.html` | 녹조 분포 3D (three.js) | **빌드 결과물** |
| `flood/*.png`, `flood/pools/p0~p8/` | 3D 지형·수심·종단거리 격자 | 데이터 산출물 (저장소 밖에서 생성) |
| `data/*.json` | 실시간 수집 결과 | **cron 이 매시 덮어씀** |
| `scripts/` | 수집 스크립트 + cron 실행기 | 원본 |
| `build/` | 빌드 원본 | 원본 |
| `analysis/` | Phase 0 판정 지표 | 원본 |

## 어디를 고치나 — 가장 중요

**빌드 결과물을 직접 고치지 말 것.** 다음 빌드에서 조용히 덮어써진다.

| 바꾸고 싶은 것 | 고칠 파일 | 그다음 |
|---|---|---|
| 3D 지형·카메라·조작·항공영상 | `build/viewer/core.js` | `python3 build/build_viewer.py` |
| 3D 화면 설정 패널(수직과장·건물 버튼 등) | `build/viewer/controls.body.html`, `controls.js` | 빌드 |
| 3D 건물 레이어 | `build/viewer/buildings.js` | 빌드 |
| 침수 화면 UI | `build/viewer/flood.body.html`, `flood.js` | 빌드 |
| 실시간 수위 계산 | `build/viewer/live.js` | 빌드 |
| 녹조 화면 UI | `build/viewer/chla.body.html`, `chla.page.js`, `chla.js` | 빌드 |
| 공통 스타일 | `build/viewer/base.css` | 빌드 |
| 전국 지도 | `map/index.html`, `map/app.js`, `map/style.css` | 빌드 없음 |
| 수집 | `scripts/fetch_*.py` | cron 이 다음 정시에 실행 |
| 대시보드 첫 화면 | `build/template.html` | **저장소에서는 빌드 불가** (아래) |

`build/viewer/` 의 JS 는 **하나의 IIFE 로 이어 붙여** 빌드된다(`build_viewer.py` 의 `PAGES` 순서).
파일마다 따로 로드되는 모듈이 아니다 — 한 파일의 함수·변수를 다른 파일이 그대로 쓴다.
두 페이지가 공유하는 함수는 반드시 `core.js` 에 둘 것(아래 함정 7).

### 대시보드 첫 화면(`index.html`)은 저장소에서 빌드할 수 없다

`build/build_index.py` 는 논문 분석 폴더의 자료(`07k_시계열지도데이터_확장bbox.json`,
`analysis_panel_data.json`, 위성 배경 base64)를 읽는다. 저장소에는 없다.
`build/template.html` 을 고쳤다면 논문 폴더 쪽에서 빌드해 `index.html` 을 복사해야 한다:
`/home/gw/0. 학위논문/분석/morphology/09_manuscript/dashboard/build/build_index.py`

## 확인 방법

화면을 바꿨으면 **실제로 띄워서** 확인한다. 이 컴퓨터에는 `google-chrome` 이 있다.

```bash
python3 -m http.server 8900 --bind 127.0.0.1 &
google-chrome --headless=new --disable-gpu --no-sandbox --enable-unsafe-swiftshader \
  --window-size=1400,880 --virtual-time-budget=45000 \
  --screenshot=/tmp/shot.png "http://127.0.0.1:8900/flood/index.html?pool=4"
```

- `--dump-dom` 결과에는 `<script>` 본문도 들어 있다. `grep` 하면 **소스 문자열이 걸려 오판**한다.
- JS 구문만 빨리 보려면 빌드된 HTML 에서 `<script>` 를 뽑아 `node --check`.
  node 는 `~/.nvm/versions/node/v24.21.0/bin/node`.
- 3D 는 링크 파라미터로 상태를 지정해 열 수 있다(점검·공유용):

| 파라미터 | 뜻 |
|---|---|
| `pool=0~8` | 담수역을 30 m 지형으로 (없으면 전 구간 90 m) |
| `at=X,Y&z=0.03` | EPSG:5186 좌표로 이동, 확대 정도(화면 폭 비율) |
| `s=now\|att\|wrn\|alm\|srs` | 침수 시나리오 |
| `live=1&lh=<색인>` | 관측 수위로 계산, 시각 색인 |
| `bld=0` / `vw=0` | 건물 / 항공영상 끄기 (기본 켜짐) |
| `p=daily&d=2022-08-22` | 녹조 날짜별 (없는 날짜는 가장 가까운 관측일) |
| `bldsrc=파일.js` | 건물 응답을 같은 폴더 파일로 대체 (로컬 점검용, 아래 함정 2) |

## 배포와 cron — 반드시 지킬 것

`/home/gw/Algal-Bloom-Monitoring` 은 **cron 이 매시 10분에 쓰는 작업 폴더**다
(`scripts/run_local_update.sh`: `git pull --rebase --autostash` → 수집 → `data/` 커밋 → 푸시).

- **이 폴더에서 브랜치를 바꾸지 말 것.** cron 이 그 브랜치에 커밋·푸시해 Pages(`main`)가 갱신을 멈춘다.
  브랜치 작업은 워크트리로: `git worktree add ../nakdong-work -b feat/이름`
- 커밋하지 않은 변경을 오래 두지 말 것. cron 의 `pull --rebase --autostash` 와 충돌할 수 있다.
- `data/*.json` 은 cron 이 덮어쓴다. 형식을 바꾸면 수집 스크립트와 화면을 같이 바꿀 것.

## 비밀키

- `~/.config/nakdong-keys.env` (권한 600) — `HRFCO_KEY`, `DATA_GO_KR_KEY`, `VWORLD_KEY_FULL`
- **저장소에 올리지 말 것.** `set -a; . ~/.config/nakdong-keys.env; set +a` 로 읽는다.
- 예외: `flood/vworld-key.js` 의 브이월드 키는 **의도적으로 공개**했다. 등록 도메인에 묶여 있어
  데이터 API 는 배포 주소에서만 통과한다. `VWORLD_KEY_FULL` 은 도메인 제한이 없으므로 공개 금지.

## 알려진 함정 (전부 실제로 겪었다)

1. **브이월드 WMTS 타일 주소는 `{z}/{y}/{x}` 순서다.** `{z}/{x}/{y}` 로 넣으면 200 과 함께 XML 오류가 온다.
2. **브이월드 데이터 API(건물)는 WMTS 와 다르게 동작한다.** `domain` 파라미터와 Referer 를 **둘 다** 검사하고,
   CORS 헤더가 없어 `fetch` 로 못 읽는다 → **JSONP**(`callback=`)로 받는다.
   공개 키로는 **로컬(127.0.0.1)에서 항상 거부**된다. 로컬 점검은 `?bldsrc=` 로 한다.
3. **공공데이터포털 "수질자동측정망(실시간)" API 는 실시간이 아니다.** 일평균·약 55일 지연.
   시간자료는 물환경정보시스템 내부 경로(`scripts/fetch_auto.py`)에서 받는다.
4. **water.nier.go.kr 는 파이썬 기본 User-Agent 를 400 으로 거부한다.** 헤더를 명시할 것.
5. **HRFCO 1시간 자료의 `ymdhm` 은 12자리가 아니라 10자리(YYYYMMDDHH)다.**
6. **조류경보 API 지점명에는 가운뎃점이 있다**(`강정·고령`). 화면은 `강정고령` 으로 찾는다 — 정규화 필요.
7. **두 3D 페이지가 공유하는 함수를 한쪽 모듈에만 두면 다른 페이지에서 조용히 실패한다.**
   `xy5186ToWorld` 가 `chla.js` 에만 있어 침수 페이지의 건물이 전부 걸러진 적이 있다.
8. **오류를 `.catch(()=>{})` 로 삼키지 말 것.** 위 7번을 찾는 데 오래 걸린 이유다. 화면에 표시한다.
9. **`history.replaceState` 로 주소를 통째로 덮어쓰면 다른 파라미터가 지워진다.** `URL.searchParams.set` 을 쓸 것.
10. **`07k` 의 구간 좌표는 EPSG:5186 이 아니라 화면좌표다.** 투영좌표가 필요하면 `MINX/MAXX/PAD` 로 되돌린다.
11. **녹조 일별 값과 구간 정보는 순서로 짝지어진다.** 어긋나면 값이 엉뚱한 구간에 붙는다.
    `chla_daily.json` 의 `s_km` 으로 실행 시 확인한다 — 이 검사를 지우지 말 것.
12. **새 기능의 기본값을 먼저 정할 것.** 항공영상과 건물이 기본 꺼짐이라 "없는 기능"이 된 적이 두 번 있다.
13. **`pkill -f "패턴"` 은 그 패턴이 들어간 자기 셸도 죽인다**(exit 144). PID 로 지정할 것.
14. **파이썬 문자열 치환으로 코드를 고칠 때 대상이 없으면 조용히 아무 일도 안 일어난다.**
    `assert old in s` 로 확인할 것.

## 저장소 밖에 있는 것

3D 의 **지형·수심·격자 데이터**는 논문 분석 폴더에서 만든다(대용량 원자료가 거기 있다).
파이썬은 `/home/gw/0. 학위논문/분석/morphology/.venv/bin/python`.

| 스크립트 (`morphology/10_flood/`) | 만드는 것 |
|---|---|
| `10c_침수계산.py` | 시나리오별 침수격자 (원천) |
| `10d_웹출력.py` | `flood/` 전 구간 90 m 자료 |
| `10e_chla레이어.py` | `flood/chla.json` |
| `10f_구간고해상도.py` | `flood/pools/p0~p8/` 담수역 30 m 자료 |
| `10g_녹조일별.py` | `flood/chla_daily.json` |
| `10i_수면종단격자.py` | `schan.png` (실시간 수위 계산용) |

출력은 논문 폴더의 `09_manuscript/dashboard/flood/` 에 생기므로 저장소로 복사한다.

## 작업 원칙

- **한계는 화면에 적는다.** 이 서비스는 절대 농도가 아니라 상대 강도를, 수리모형이 아니라 지형 기반
  근사를 보여준다(ADR-001, 009). 추정값을 실측처럼 보이게 하지 말 것.
- **수치는 재현해서 확인한다.** 확인 못 한 것은 "미확보"로 적는다.
- **주석은 "무엇"보다 "왜"를 쓴다.** 기존 코드가 그렇게 되어 있다.
- 커밋 메시지는 한국어, `feat:` / `fix:` / `docs:` 접두어, 본문에 이유와 확인 결과.

## 환경

- sudo 없음. 시스템 파이썬에는 `requests` 정도만 있다.
- `apparmor_restrict_unprivileged_userns = 1` 이라 bubblewrap 기반 샌드박스가 실패할 수 있다.
