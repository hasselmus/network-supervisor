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
install -m 0644 "$REPO/systemd/network-supervisor.service" "$UNITDIR/network-supervisor.service"
systemctl daemon-reload
systemctl enable network-supervisor.service
systemctl restart network-supervisor.service
systemctl --no-pager --full status network-supervisor.service || true
echo "Dashboard: http://pi.local:8790/"
