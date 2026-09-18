#!/usr/bin/env bash
# =============================================================================
#  start-tunnel.sh -- expose the Korea relay through a Cloudflare quick tunnel,
#  with auto-restart. macOS and Linux; start-tunnel.bat is the Windows twin.
#
#  The URL is EPHEMERAL: it changes every time this starts. It is printed here
#  and saved to tunnel_url.txt next to this file.
#
#  Start the relay FIRST, in its own terminal: tools/start-relay.sh
#
#  Needs cloudflared:
#      macOS with Homebrew:  brew install cloudflared
#      or download from:     https://github.com/cloudflare/cloudflared/releases
#
#  Usage:  bash tools/start-tunnel.sh
# =============================================================================
set -u
cd "$(dirname "$0")"

PORT="${KOREA_RELAY_PORT:-8799}"

# ---- find cloudflared -------------------------------------------------------
CFD=""
command -v cloudflared >/dev/null 2>&1 && CFD="cloudflared"
for c in ./cloudflared /opt/homebrew/bin/cloudflared /usr/local/bin/cloudflared \
         /usr/bin/cloudflared "$HOME/Downloads/cloudflared"; do
  [ -n "$CFD" ] && break
  [ -x "$c" ] && CFD="$c"
done

if [ -z "$CFD" ]; then
  cat <<'MSG'

  cloudflared was not found.

      macOS with Homebrew:  brew install cloudflared
      or download the binary for your machine from
      https://github.com/cloudflare/cloudflared/releases
      and put it next to this script (chmod +x it).

  If you just installed it, open a NEW terminal -- the current one still has
  the old PATH.

MSG
  exit 1
fi

# ---- is the relay actually up? ----------------------------------------------
# A tunnel to a port with nothing behind it looks like it worked, and then
# every request 502s, which is a confusing way to find out.
if ! curl -s -o /dev/null -m 3 "http://localhost:${PORT}/health"; then
  echo
  echo "  [!] Nothing is answering on http://localhost:${PORT}"
  echo "      Start tools/start-relay.sh first, in its own terminal."
  echo "      Continuing anyway in 5s..."
  echo
  sleep 5
fi

echo "  using cloudflared: ${CFD}"

trap 'echo; echo "stopped."; exit 0' INT TERM

while true; do
  echo
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] opening tunnel to http://localhost:${PORT}"
  echo
  # 주소가 보이면 파일에 적어 두고, .env 에 넣을 두 줄을 그대로 찍어 줍니다.
  # Catch the URL as it scrolls past, save it, and print the two lines that
  # have to go into .env -- copying them out of the noise by hand is where
  # this goes wrong.
  "$CFD" tunnel --url "http://localhost:${PORT}" 2>&1 | while IFS= read -r line; do
    printf '%s\n' "$line"
    url=$(printf '%s' "$line" | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | head -1)
    if [ -n "$url" ]; then
      printf '%s\n' "$url" > tunnel_url.txt
      echo
      echo "  TUNNEL URL (saved to tunnel_url.txt): $url"
      echo
      echo "  Put these two lines in ieumi-server/.env ON YOUR OWN MACHINE:"
      echo "    KOREA_RELAY_URL=$url"
      echo "    KOREA_RELAY_TOKEN=(same value as .env on this Korea box)"
      echo
    fi
  done
  echo
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] tunnel exited -- restarting in 5s (Ctrl+C to stop)"
  sleep 5
done
