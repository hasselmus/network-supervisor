#!/bin/sh
set -eu
REPO=/home/pi/network-supervisor
UNITDIR=/etc/systemd/system
if [ "$(id -u)" -ne 0 ]; then echo "Run as root: sudo sh scripts/install-systemd.sh" >&2; exit 1; fi
[ -f "$REPO/src/index.mjs" ] || { echo "Expected repository at $REPO" >&2; exit 1; }
[ -f "$REPO/site.local.json" ] || { echo "Create $REPO/site.local.json first" >&2; exit 1; }
[ -f "$REPO/.env" ] || { echo "Create $REPO/.env first" >&2; exit 1; }
python3 -c 'import requests' >/dev/null 2>&1 || { echo "Python requests module is required (Debian/Raspberry Pi OS: sudo apt install python3-requests)" >&2; exit 1; }
mountpoint -q /mnt/ssd || { echo "/mnt/ssd is not mounted; refusing to start" >&2; exit 1; }

# The optional MR600 adapter uses tplinkrouterc6u and its crypto dependencies in
# an isolated venv so Debian's externally-managed system Python remains untouched.
if [ -f "$REPO/requirements-router.txt" ]; then
  if [ ! -x "$REPO/.venv/bin/python" ]; then
    python3 -m venv "$REPO/.venv" 2>/dev/null || {
      echo "python3-venv is required for MR600 telemetry (sudo apt install python3-venv)" >&2
      exit 1
    }
  fi
  "$REPO/.venv/bin/python" -m pip install --disable-pip-version-check -q -r "$REPO/requirements-router.txt"
fi

# Stop any previously installed instance before checking the dashboard port. This
# catches the common transition from an interactive `npm start` test process to
# the permanent service without leaving systemd in an EADDRINUSE restart loop.
systemctl stop network-supervisor.service 2>/dev/null || true
WEBPORT=$(sed -n 's/^[[:space:]]*WEB_PORT[[:space:]]*=[[:space:]]*//p' "$REPO/.env" | tail -n 1 | tr -d "'\"[:space:]")
[ -n "$WEBPORT" ] || WEBPORT=8790
if ss -H -ltn "sport = :$WEBPORT" 2>/dev/null | grep -q .; then
  echo "TCP port $WEBPORT is already in use by another process; refusing to start the service." >&2
  ss -ltnp "sport = :$WEBPORT" >&2 || true
  echo "Stop the old/manual network-supervisor process (or other listener) and rerun this installer." >&2
  exit 1
fi

install -m 0644 "$REPO/systemd/network-supervisor.service" "$UNITDIR/network-supervisor.service"
systemctl daemon-reload
systemctl enable network-supervisor.service
systemctl restart network-supervisor.service
systemctl --no-pager --full status network-supervisor.service || true
echo "Dashboard: http://pi.local:$WEBPORT/"
