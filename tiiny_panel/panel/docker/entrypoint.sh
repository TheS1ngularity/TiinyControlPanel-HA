#!/bin/bash
# Starts the Tiiny Control Panel in the container (see the Dockerfile). Installed as /app/bin/tiiny-panel.
#   tiiny-panel [panel options]   start the panel in server mode (the default), for example: tiiny-panel --allow-commands
#   tiiny-panel info              where to open the panel and how to sign in: docker exec tiiny-panel tiiny-panel info
#   tiiny-panel code              show the setup code for the first device: docker exec tiiny-panel tiiny-panel code
#   tiiny-panel pair [--limited]  print a one-time sign-in link for a device: docker exec tiiny-panel tiiny-panel pair
#   tiiny-panel mcp ...           the MCP bridge for AI assistants on this machine: docker exec -i tiiny-panel tiiny-panel mcp
#   tiiny-panel health            Docker's health check
# It runs as the user that owns /data (PUID and PGID, default 1000), not as root, and installs Tiiny's own
# command-line tool into /data with Tiiny's installer on the first start.
set -euo pipefail

cmd="${1:-}"
if [ "$cmd" = "health" ]; then   # HTTP, or HTTPS when a certificate is set (by environment or on the command line)
  url="127.0.0.1:${TIINY_UI_PORT:-8765}/__tiiny__"
  curl -fsS --max-time 4 -o /dev/null "http://$url" 2>/dev/null || exec curl -fsSk --max-time 4 -o /dev/null "https://$url"
  exit 0
fi

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
for n in "$PUID" "$PGID"; do
  case "$n" in
    ''|*[!0-9]*) echo "PUID and PGID must be numbers (they are \"$PUID\" and \"$PGID\")." >&2; exit 64 ;;
  esac
done

if [ "$(id -u)" = 0 ] && [ "$PUID" != 0 ]; then
  # Give /data to its user (only what isn't theirs yet), then carry on as that user. Some network shares
  # don't allow changing owners: then the folder has to be writable for that user already.
  mkdir -p /data
  if ! find /data -xdev \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown -h "$PUID:$PGID" {} + 2>/dev/null; then
    echo "Note: couldn't give everything in /data to user $PUID (group $PGID). If the panel can't save, make the data folder writable for that user." >&2
  fi
  exec python3 -c 'import os, sys
os.setgroups([]); os.setgid(int(sys.argv[1])); os.setuid(int(sys.argv[2])); os.execv(sys.argv[3], sys.argv[3:])' \
    "$PGID" "$PUID" "$0" "$@"
fi

export HOME=/data
export PATH="/data/.local/tiiny/bin:$PATH"
case "$cmd" in
  pair|mcp|code|info)
    shift
    exec python3 /app/tiiny_ui.py "$cmd" "$@" ;;
esac

if [ ! -x /data/.local/tiiny/bin/tiiny ]; then
  echo "First start: installing Tiiny's command-line tool from tiiny-cli.tiiny.cloud…"
  if ! curl -fsSL --max-time 300 "https://tiiny-cli.tiiny.cloud/install-linux.sh" | bash; then
    echo "Couldn't install Tiiny's command-line tool right now. The panel starts without it; restart the container to try again."
  fi
fi

exec python3 /app/tiiny_ui.py --server --no-browser "$@"
