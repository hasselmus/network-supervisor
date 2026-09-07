#!/bin/sh
set -eu
REPO=/home/pi/network-supervisor
UNITDIR=/etc/systemd/system
DEFAULTS=/etc/default/network-supervisor-witness
if [ "$(id -u)" -ne 0 ]; then echo "Run as root: sudo sh scripts/install-witness.sh" >&2; exit 1; fi
[ -f "$REPO/witness/agent.py" ] || { echo "Expected repository at $REPO" >&2; exit 1; }
install -m 0644 "$REPO/systemd/network-supervisor-witness.service" "$UNITDIR/network-supervisor-witness.service"
if [ ! -e "$DEFAULTS" ]; then
  cat > "$DEFAULTS" <<'CFG'
# Optional site-local settings. The default gateway is auto-discovered.
# Set WITNESS_SUPERVISOR to the supervisor's hostname or LAN address if you
# want the witness to test that path as well.
WITNESS_SUPERVISOR=
# WITNESS_ROUTER=
# WITNESS_IFACE=wlan0
# WITNESS_INTERNET=1.1.1.1
# WITNESS_DNS_NAME=example.com
# WITNESS_PORT=8791
CFG
  chmod 0644 "$DEFAULTS"
fi
systemctl daemon-reload
systemctl enable network-supervisor-witness.service
systemctl restart network-supervisor-witness.service
systemctl --no-pager --full status network-supervisor-witness.service || true
echo "Configuration: $DEFAULTS"
