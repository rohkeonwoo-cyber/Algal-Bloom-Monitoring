#!/usr/bin/env bash
# 국내 IP(이 컴퓨터)에서 공공API를 수집해 GitHub 저장소에 올린다.
#
# 배경: 한강홍수통제소 API는 GitHub Actions(해외 데이터센터)에서 연결이 차단돼
#       타임아웃이 난다. 그래서 수집만 국내에서 하고 결과 JSON만 올리는 구조.
#
# 사전 준비 (한 번만):
#   1) 저장소를 로컬에 클론
#        git clone https://github.com/rohkeonwoo-cyber/Algal-Bloom-Monitoring.git ~/Algal-Bloom-Monitoring
#   2) 키를 저장소 밖의 파일에 보관 (저장소에 올라가면 안 되므로)
#        mkdir -p ~/.config && cat > ~/.config/nakdong-keys.env <<'EOF'
#        HRFCO_KEY=발급받은_HRFCO_키
#        DATA_GO_KR_KEY=디코딩된_datagokr_키
#        EOF
#        chmod 600 ~/.config/nakdong-keys.env
#   3) git push 인증 설정 (아래 둘 중 하나)
#        - HTTPS + Personal Access Token: 첫 push 때 토큰을 비밀번호로 입력하고
#          git config --global credential.helper store 로 저장
#        - 또는 SSH 키 등록 후 원격주소를 git@github.com:... 로 변경
#
# 실행:  bash scripts/run_local_update.sh
# 자동화(매시 10분):  crontab -e 에 아래 한 줄 추가
#   10 * * * * bash ~/Algal-Bloom-Monitoring/scripts/run_local_update.sh >> ~/nakdong-update.log 2>&1

set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/Algal-Bloom-Monitoring}"
KEY_FILE="${KEY_FILE:-$HOME/.config/nakdong-keys.env}"
PYTHON="${PYTHON:-python3}"

echo "=== $(date '+%Y-%m-%d %H:%M:%S') 수집 시작 ==="

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "오류: $REPO_DIR 가 git 저장소가 아닙니다. 위 '사전 준비 1)' 의 clone 을 먼저 하세요." >&2
  exit 1
fi
if [ ! -f "$KEY_FILE" ]; then
  echo "오류: 키 파일이 없습니다: $KEY_FILE (위 '사전 준비 2)' 참고)" >&2
  exit 1
fi

set -a; . "$KEY_FILE"; set +a   # 키를 환경변수로 로드

cd "$REPO_DIR"
git pull --rebase --quiet || echo "경고: git pull 실패(계속 진행)"

ok_hrfco=1; ok_algae=1
"$PYTHON" scripts/fetch_hrfco.py || { ok_hrfco=0; echo "경고: HRFCO 수집 실패"; }
"$PYTHON" scripts/fetch_algae.py || { ok_algae=0; echo "경고: 조류경보 수집 실패"; }

if [ "$ok_hrfco" = "0" ] && [ "$ok_algae" = "0" ]; then
  echo "두 수집 모두 실패 — 커밋하지 않고 종료" >&2
  exit 1
fi

git add -A data/
if git diff --staged --quiet; then
  echo "갱신된 내용 없음 — 커밋 생략"
else
  git commit -m "chore: 실시간 데이터 갱신 ($(date '+%Y-%m-%d %H:%M'))"
fi

# 푸시는 커밋 여부와 분리한다. 지난 회차에 푸시가 실패(네트워크·인증)해 로컬 커밋이
# 밀려 있는데 이번 회차에 데이터 변화가 없으면, 커밋과 함께 푸시까지 건너뛰어
# 밀린 커밋이 영구히 올라가지 않는다. 그래서 "origin보다 앞서 있으면 푸시".
ahead=$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
if [ "$ahead" -gt 0 ]; then
  if git push; then
    echo "푸시 완료 (커밋 ${ahead}개)"
  else
    echo "경고: 푸시 실패 — 커밋 ${ahead}개가 로컬에 남았습니다(다음 회차에 재시도)." >&2
    exit 1
  fi
else
  echo "올릴 커밋 없음"
fi

echo "=== 완료 ==="
