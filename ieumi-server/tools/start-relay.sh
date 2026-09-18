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
if [ ! -f ".env" ]; then
  cat <<'MSG'

  No .env file in ieumi-server/
  Create it with one line:

      KOREA_RELAY_TOKEN=<a long random string>

  To generate one:
      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

MSG
  exit 1
fi

if ! grep -q '^KOREA_RELAY_TOKEN=' .env; then
  cat <<'MSG'

  [!] KOREA_RELAY_TOKEN is not set in .env.
      The relay will still start, but anyone who finds the address can use
      it. Fine for a local test, not for a tunnel.

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
