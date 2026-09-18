#!/usr/bin/env bash
# =============================================================================
#  start-relay.sh -- run the Korea fetch relay, with auto-restart.
#  macOS and Linux. The Windows equivalent is start-relay.bat beside this file.
#
#  All it does is open a page and hand back what it got. Korean government
#  sites refuse foreign IPs, so doing only this from Korea lets the rest of
#  the system live anywhere.
#
#  THE TOKEN GOES IN ieumi-server/.env -- NOT IN THIS FILE.
#      KOREA_RELAY_TOKEN=<a long random string>
#  .env is gitignored; this script is not, so a token written here would be
#  committed to the repository.
#
#  Then run tools/start-tunnel.sh in a second terminal to expose it.
#
#  Usage:  bash tools/start-relay.sh      (or chmod +x it once, then ./…)
# =============================================================================
set -u
cd "$(dirname "$0")/.."

# ---- find node --------------------------------------------------------------
# A double-clicked script, or one run from a GUI terminal, may not have the
# same PATH as your login shell -- nvm and Homebrew in particular live in
# places a bare PATH does not know about.
NODE=""
command -v node >/dev/null 2>&1 && NODE="node"
for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node \
         "$HOME/.nvm/versions/node/*/bin/node" ; do
  [ -n "$NODE" ] && break
  for g in $c; do [ -x "$g" ] && NODE="$g" && break; done
done

if [ -z "$NODE" ]; then
  cat <<'MSG'

  Node.js was not found.

  Install it:
      macOS with Homebrew:  brew install node
      or download from:     https://nodejs.org

  If you just installed it, open a NEW terminal -- the current one still has
  the old PATH.

MSG
  exit 1
fi

# ---- check the token --------------------------------------------------------
# 환경변수로 줘도 됩니다 — .env 파일이 반드시 있어야 하는 것은 아닙니다.
#
# 맥의 파인더는 점으로 시작하는 이름을 거부합니다 ("Names that begin with a dot
# are reserved for the system"). 그래서 .env 를 못 만드는 경우가 있는데, 그때
# export KOREA_RELAY_TOKEN=... 한 줄이면 충분합니다. env.js 는 환경변수를
# 먼저 봅니다. 파일을 요구하고 멈춰 서면 안 됩니다.
#
# The token may come from the environment; the file is one way, not the only
# way. Finder refuses to create dot-files, and env.js already prefers
# process.env -- so refusing to start without the file would block a setup
# that works perfectly well.
if [ -n "${KOREA_RELAY_TOKEN:-}" ]; then
  echo "  token: from the environment"
elif [ -f ".env" ] && grep -q '^KOREA_RELAY_TOKEN=' .env; then
  echo "  token: from .env"
else
  cat <<'MSG'

  [!] KOREA_RELAY_TOKEN is not set -- not in the environment, and not in
      ieumi-server/.env. The relay will still start, but anyone who finds
      the address can use it. Fine for a local test, not for a tunnel.

  Either export it for this terminal:
      export KOREA_RELAY_TOKEN=<a long random string>

  Or create the file (Finder will not let you; the terminal will):
      echo 'KOREA_RELAY_TOKEN=<a long random string>' > .env

  To generate one:
      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

MSG
  sleep 5
fi

# ---- run --------------------------------------------------------------------
trap 'echo; echo "stopped."; exit 0' INT TERM

while true; do
  echo
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] starting Korea fetch relay"
  echo
  "$NODE" korea-relay.js
  echo
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] relay exited -- restarting in 5s (Ctrl+C to stop)"
  sleep 5
done
