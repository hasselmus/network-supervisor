# network-supervisor

A small topology-aware network fault supervisor for fixed home networks.

This is deliberately **not** a bandwidth/NMS dashboard. Its job is to answer: **what physical link, branch or network service is probably broken?** It uses hard evidence from lightly managed Ethernet switches, then functional probes, then fallible Wi-Fi witnesses. Downstream symptoms are suppressed where a stronger upstream explanation exists.

The TP-Link Easy Smart support is informed by Peter Smode's GPL-3.0 `essstat` utility and is therefore kept under GPL-3.0-only as well.

## What v0.1 monitors

- TP-Link Easy Smart switch management over local HTTP.
- Per-port carrier state and negotiated speed/duplex.
- **Change** in bad-packet counters (not merely non-zero lifetime counters).
- Router reachability through the supervisor Pi's Ethernet and Wi-Fi interfaces separately.
- External-IP reachability through both interfaces.
- DNS queries sent directly to the router DNS proxy.
- Optional Raspberry Pi Zero 2 W Wi-Fi witnesses: BSSID, RSSI, boot ID, uptime and simple reachability.
- Human observations entered from the LAN web interface.
- Optional AI diagnosis, including direct OpenAI Responses API support. The offline deterministic monitor does not depend on it.

The dashboard has no traffic graphs and stores events/observations rather than long-term packet-volume telemetry.

## Requirements

- Linux, intended for Raspberry Pi OS / Debian.
- Node.js >= 22.13.
- Python 3 with the `requests` module (`sudo apt install python3-requests` on Debian/Raspberry Pi OS).
- `ping` and `iw` installed.
- `/mnt/ssd` mounted by default for persistent state.
- TP-Link Easy Smart switches compatible with the classic `logon.cgi` / `PortStatisticsRpm.htm` interface.

The default Easy Smart poller deliberately uses a tiny Python `requests.Session()` helper because this matches the behaviour of `essstat` on real Easy Smart firmware. A pure-Node implementation remains available for development by setting `TPLINK_EASYSMART_BACKEND=node`, but is not the default.

## Install on the supervisor Pi

```sh
cd /home/pi
git clone https://github.com/hasselmus/network-supervisor.git
cd network-supervisor
cp site.example.json site.local.json
cp .env.example .env
```

Edit `site.local.json` for the physical site and put the switch credentials in `.env`. Both files are ignored by git.

Validate before installing:

```sh
npm test
npm run check-config
npm start
```

Open `http://pi.local:8790/` from the LAN.

When satisfied:

```sh
sudo sh scripts/install-systemd.sh
```

## Site configuration principles

`switches[].ports` defines what each managed port normally does. `expectedUp:false` means a socket is allowed to be unplugged without an alarm. `expectedLink` makes a link that falls back from 1000M Full to 100M Full diagnostically visible even though it still passes traffic.

`links` describe shared physical dependencies. If both ends are managed, put both switch/port endpoints in the link. A single physical-link diagnosis is then preferred to a cascade of independent host-down diagnoses.

Example:

```json
{
  "id": "hall-bedroom-run",
  "name": "Hall ↔ bedroom Ethernet run",
  "a": { "switch": "hall", "port": 3 },
  "b": { "switch": "bedroom", "port": 1 },
  "expectedUp": true
}
```

### Bad-packet counters

Small cumulative Rx/Tx bad-packet counts are common enough on some consumer equipment that v0.1 does **not** flag a non-zero total. It records a fault only when the counter increases by at least `badPacketDeltaWarn` between polls (default 100). This is intentionally conservative and can be tuned per port.

## Wi-Fi witnesses

The optional witness is a tiny read-only Python HTTP service intended for Pi Zero 2 W machines that already exist for other reasons. The supervisor treats a missing witness as weak evidence only: a witness disappearing cannot by itself create a network-fault diagnosis.

On each witness Pi, clone the repository and run:

```sh
sudo sh scripts/install-witness.sh
```

The service exposes `GET /status` on port 8791. The Wi-Fi default gateway is discovered automatically. Site-local overrides live in `/etc/default/network-supervisor-witness`, notably `WITNESS_SUPERVISOR` if you also want each witness to test reachability back to the main supervisor. The witness also sends a DNS query directly to its gateway, so “router answers ping” and “router DNS works” remain distinct observations.

## AI diagnosis

The web interface can send the current topology, hard switch evidence, functional probes, active diagnoses, recent events and an optional human-entered problem description to an AI. This is always an explicit human action: ordinary polling and deterministic diagnosis remain completely local and work without Internet access.

### OpenAI

Direct OpenAI Responses API support is built in. Add the following to the local `.env` file:

```sh
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.6
OPENAI_REASONING_EFFORT=medium
```

`OPENAI_MODEL` and `OPENAI_REASONING_EFFORT` are optional; the defaults are `gpt-5.6` and `medium`. Restart the supervisor after changing `.env`, then use **Ask configured AI** in the dashboard. The API key is read only by the server process and is never sent to the browser.

An OpenAI API account/key and API billing are separate from a ChatGPT subscription.

### Generic endpoint

A local model gateway or another cloud service can instead be used with:

```sh
AI_PROVIDER=generic
AI_URL=https://example.invalid/diagnose
AI_BEARER_TOKEN=optional-secret
```

The generic endpoint receives JSON and may return plain text or JSON containing an `answer` field.

## Reboots / remediation

v0.1 diagnoses but does **not** reboot equipment automatically. TP-Link Deco and Archer local management APIs are firmware-dependent and largely undocumented. The intended next step is to add explicit, site-tested soft-reboot adapters for the router and Decos, exposed as suggested/manual actions first. Automatic remediation, if added later, should require high-confidence diagnoses, cooldowns and attempt limits.

## Security

The dashboard is designed for a trusted LAN and currently has no user authentication. Do not expose port 8790 or witness port 8791 to the Internet. Keep credentials in `.env`; do not put site credentials into `site.local.json` or tracked source files.
