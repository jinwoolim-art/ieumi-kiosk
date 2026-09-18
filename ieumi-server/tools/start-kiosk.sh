#!/usr/bin/env bash
# =============================================================================
#  start-kiosk.sh -- run the Ieumi app server itself, with auto-restart.
#  macOS and Linux. The Windows equivalent is start-kiosk.bat beside this file.
#
#  This is NOT the relay. The relay (start-relay.sh) only fetches pages for the
#  nightly link sync. This runs the kiosk the client actually talks to.
#
#  Then run tools/share-kiosk.sh in a second terminal to get a link you can
#  send to the client.
#
#  Keys go in ieumi-server/.env -- NOT IN THIS FILE. .env is gitignored; this
#  script is not, so anything written here would be committed.
#
#  Usage:  bash tools/start-kiosk.sh
# =============================================================================
set -u
cd "$(dirname "$0")/.."

# ---- find node --------------------------------------------------------------
# A script run from a GUI terminal may not have your login shell's PATH --
# nvm and Homebrew in particular live where a bare PATH does not look.
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
      or download from     https://nodejs.org

MSG
  exit 1
fi

# ---- are the dependencies installed? ----------------------------------------
# The relay needs nothing but Node, so a machine that runs start-relay.sh
# perfectly well can still have no node_modules. The failure then arrives as a
# stack trace ending in "Cannot find module pg", which never says the one thing
# you need to do about it.
if [ ! -d node_modules/pg ]; then
  cat <<'MSG'

  [!] Dependencies are not installed in this folder.
      The relay needs only Node, so this is easy to miss.

  Run this once, here, then start this script again:
      npm install --omit=dev

MSG
  exit 1
fi

# ---- check the keys ---------------------------------------------------------
# Each of these fails in its own quiet way, and all three look the same from
# the front: Ieumi appears, then says it cannot answer.
#   DATABASE_URL       no catalogue at all
#   ANTHROPIC_API_KEY  every question answers "I cannot answer right now"
#   CLOVA_API_KEY_ID   no voice, and no speech recognition
if [ ! -f .env ]; then
  cat <<'MSG'

  [!] ieumi-server/.env does not exist. The server needs at least:
        DATABASE_URL=postgres://...
        ANTHROPIC_API_KEY=sk-ant-...
        CLOVA_API_KEY_ID=...
        CLOVA_API_KEY=...

MSG
  exit 1
fi
for k in DATABASE_URL ANTHROPIC_API_KEY CLOVA_API_KEY_ID CLOVA_API_KEY; do
  grep -q "^$k=" .env || echo "  [!] $k is not in .env"
done

# ---- the address to hand out ------------------------------------------------
# The ?c= token identifies the centre. Mistyping it does not fail: the page
# loads and quietly serves another centre's catalogue. So it is printed.
KPATH="$("$NODE" tools/kiosk-url.js 2>/dev/null || true)"
[ -n "$KPATH" ] && echo "
  kiosk on this machine:  http://localhost:8791$KPATH"

while true; do
  echo ""
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] starting the Ieumi server on port 8791"
  echo ""
  "$NODE" server.js
  echo ""
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] server exited -- restarting in 5s [Ctrl+C to stop]"
  sleep 5
done
