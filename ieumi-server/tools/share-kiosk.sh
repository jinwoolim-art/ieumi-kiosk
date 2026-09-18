#!/usr/bin/env bash
# =============================================================================
#  share-kiosk.sh -- put the kiosk on a public HTTPS address you can send.
#  macOS and Linux. The Windows equivalent is share-kiosk.bat beside this file.
#
#  Start tools/start-kiosk.sh FIRST, in its own terminal.
#
#  THE ADDRESS IS TEMPORARY. It changes every time this restarts, and it dies
#  when this terminal closes or the machine sleeps. Good for a testing session
#  with someone on a call; not something to put in a document.
#
#  ANYONE WITH THE LINK CAN USE IT. There is no password on the kiosk -- by
#  design, since a senior standing in front of a screen cannot sign in. Every
#  conversation spends Anthropic and CLOVA credit, so hand the address to the
#  people testing and close this terminal when they are done.
#
#  Usage:  bash tools/share-kiosk.sh
# =============================================================================
set -u
cd "$(dirname "$0")/.."

PORT="${PORT_OVERRIDE:-8791}"

# ---- find node (only to read the centre token) ------------------------------
NODE=""
command -v node >/dev/null 2>&1 && NODE="node"
for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node \
         "$HOME/.nvm/versions/node/*/bin/node" ; do
  [ -n "$NODE" ] && break
  for g in $c; do [ -x "$g" ] && NODE="$g" && break; done
done

# ---- find cloudflared -------------------------------------------------------
CFD=""
command -v cloudflared >/dev/null 2>&1 && CFD="cloudflared"
for c in /opt/homebrew/bin/cloudflared /usr/local/bin/cloudflared \
         /usr/bin/cloudflared "$(dirname "$0")/cloudflared"; do
  [ -n "$CFD" ] && break
  [ -x "$c" ] && CFD="$c"
done

if [ -z "$CFD" ]; then
  cat <<'MSG'

  cloudflared was not found.

  Install it:
      macOS with Homebrew:  brew install cloudflared
      or download from      https://github.com/cloudflare/cloudflared/releases

  If you just installed it, open a NEW terminal -- the current one still has
  the old PATH.

MSG
  exit 1
fi

# ---- is the server actually up? ---------------------------------------------
# A tunnel to a port with nothing behind it looks like it worked, and then
# every request 502s, which is a confusing way to find out.
if ! curl -s -o /dev/null -m 3 "http://localhost:${PORT}/health"; then
  echo
  echo "  [!] Nothing is answering on http://localhost:${PORT}"
  echo "      Start tools/start-kiosk.sh first, in its own terminal."
  echo "      Continuing anyway in 5s..."
  echo
  sleep 5
fi

echo "  using cloudflared: ${CFD}"

# ---- the ?c= token, read once before the tunnel opens -----------------------
KPATH="/kiosk"
if [ -n "$NODE" ]; then
  got="$("$NODE" tools/kiosk-url.js 2>/dev/null || true)"
  [ -n "$got" ] && KPATH="$got"
fi

trap 'echo; echo "stopped."; exit 0' INT TERM

while true; do
  echo
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] opening tunnel to http://localhost:${PORT}"
  echo
  "$CFD" tunnel --url "http://localhost:${PORT}" 2>&1 | while IFS= read -r line; do
    printf '%s\n' "$line"
    url=$(printf '%s' "$line" | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | head -1)
    if [ -n "$url" ]; then
      printf '%s\n' "${url}${KPATH}" > kiosk_url.txt
      echo
      echo "  ================================================================"
      echo "  SEND THIS LINK (also saved to ieumi-server/kiosk_url.txt):"
      echo "  ${url}${KPATH}"
      echo "  ================================================================"
      echo "  Microphone needs this HTTPS address -- not the localhost one."
      echo "  Temporary: it dies when this terminal closes."
      echo
    fi
  done
  echo
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] tunnel exited -- restarting in 5s (Ctrl+C to stop)"
  echo "    NOTE: the address CHANGES on restart. Send the new one."
  sleep 5
done
