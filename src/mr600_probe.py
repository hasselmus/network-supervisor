#!/usr/bin/env python3
"""Read-only TP-Link Archer MR-series LTE telemetry.

Uses tplinkrouterc6u for the router's encrypted local management protocol.
Credentials are read from environment variables so they never appear in argv.
The first invocation may auto-detect the MR crypto/protocol variant; callers can
cache and pass the returned client class on later invocations.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict, is_dataclass
from typing import Any

from tplinkrouterc6u import (
    TPLinkMRClient,
    TPLinkMRClientGCM,
    TPLinkMR200Client,
    TPLinkMR6400v7Client,
    TPLinkMR600Client,
)

# tplinkrouterc6u lists Archer MR600 v1/v2/v3 as supported, but those hardware
# generations do not necessarily use the class named TPLinkMR600Client.  The
# upstream provider probes several MR-family transports in this order.  We keep
# the search restricted to MR-family clients and, importantly, require a full
# authorize + get_lte_status transaction before accepting a candidate.
CLIENTS = {
    "TPLinkMRClientGCM": TPLinkMRClientGCM,
    "TPLinkMRClient": TPLinkMRClient,
    "TPLinkMR200Client": TPLinkMR200Client,
    "TPLinkMR6400v7Client": TPLinkMR6400v7Client,
    "TPLinkMR600Client": TPLinkMR600Client,
}
AUTO_ORDER = [
    "TPLinkMRClientGCM",
    "TPLinkMRClient",
    "TPLinkMR200Client",
    "TPLinkMR6400v7Client",
    "TPLinkMR600Client",
]

EXTRA_KEYS = {
    "rfInfoBand",
    "rfInfoChannel",
    "rfInfoPCellBand",
    "rfInfoPCellChannel",
    "rfInfoSCellBand",
    "rfInfoSCellChannel",
    "rfInfoPCI",
    "rfInfoCellID",
    "rfInfoRssi",
}


def normalise_host(host: str) -> str:
    host = host.strip().rstrip("/")
    if not host.startswith(("http://", "https://")):
        host = "http://" + host
    return host


def to_plain(value: Any) -> Any:
    if is_dataclass(value):
        return asdict(value)
    if isinstance(value, dict):
        return {str(k): to_plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_plain(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def collect_extra_fields(value: Any, out: dict[str, Any]) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key in EXTRA_KEYS and child not in (None, ""):
                out.setdefault(key, child)
            collect_extra_fields(child, out)
    elif isinstance(value, (list, tuple)):
        for child in value:
            collect_extra_fields(child, out)


def read_raw_radio_extras(router: Any) -> dict[str, Any]:
    """Best-effort read of fields shown by MR600 status pages.

    Older MR600 firmware normally exposes these through LTE_NET_STATUS at the
    same stack used by tplinkrouterc6u.get_lte_status(). Unknown/missing fields
    are harmless; this extension is deliberately optional.
    """
    try:
        act = router.ActItem(
            router.ActItem.GET,
            "LTE_NET_STATUS",
            "2,1,0,0,0,0",
            attrs=list(EXTRA_KEYS),
        )
        _, values = router.req_act([act])
        found: dict[str, Any] = {}
        collect_extra_fields(values, found)
        return found
    except Exception:
        return {}


def friendly_status(status: Any, extras: dict[str, Any]) -> dict[str, Any]:
    raw = to_plain(status)
    # tplinkrouterc6u exposes MR rfInfoSnr in tenths of a dB. The MR600 web UI
    # displays the corresponding decimal dB value (e.g. raw 134 -> 13.4 dB).
    raw_snr = getattr(status, "snr", None)
    snr_db = (float(raw_snr) / 10.0) if raw_snr is not None else None
    network_type = getattr(status, "network_type", None)
    network_info = getattr(status, "network_type_info", None)
    sim_info = getattr(status, "sim_status_info", None)

    def first(*keys):
        for key in keys:
            value = extras.get(key)
            if value not in (None, "", "0", 0):
                return value
        return None

    return {
        "raw": raw,
        "enabled": getattr(status, "enable", None),
        "connectStatus": getattr(status, "connect_status", None),
        "networkType": network_type,
        "networkTypeInfo": network_info,
        "simStatus": getattr(status, "sim_status", None),
        "simStatusInfo": sim_info,
        "registered": bool(network_type not in (None, 0)),
        "isp": getattr(status, "isp_name", None),
        "rsrpDbm": getattr(status, "rsrp", None),
        "rsrqDb": getattr(status, "rsrq", None),
        "snrDb": snr_db,
        "rssiDbm": first("rfInfoRssi"),
        "signalLevel": getattr(status, "sig_level", None),
        "rxBytesPerSecond": getattr(status, "cur_rx_speed", None),
        "txBytesPerSecond": getattr(status, "cur_tx_speed", None),
        "totalBytes": getattr(status, "total_statistics", None),
        "band": first("rfInfoPCellBand", "rfInfoBand"),
        "earfcn": first("rfInfoPCellChannel", "rfInfoChannel"),
        "pci": first("rfInfoPCI"),
        "cellId": first("rfInfoCellID"),
        "secondaryBand": first("rfInfoSCellBand"),
        "secondaryEarfcn": first("rfInfoSCellChannel"),
        "extra": extras,
    }


def _dispose(router: Any) -> None:
    try:
        router.logout()
    except Exception:
        pass
    try:
        router.req.close()
    except Exception:
        pass


def try_client(cls: type, name: str, host: str, password: str, username: str, timeout: int):
    """Return (router, status) only after a complete LTE read succeeds.

    `supports()` alone is insufficient because several MR generations share
    enough of the login surface for the wrong client class to look plausible.
    """
    router = cls(host, password, username, timeout=timeout)
    try:
        if not router.supports():
            raise RuntimeError("protocol not supported")
        router.authorize()
        status = router.get_lte_status()
        return router, status
    except Exception:
        _dispose(router)
        raise


def poll(host: str, username: str, password: str, timeout: int, client_name: str) -> dict[str, Any]:
    names = AUTO_ORDER if client_name == "auto" else [client_name]
    errors = []
    for name in names:
        cls = CLIENTS.get(name)
        if cls is None:
            raise RuntimeError(f"unknown MR client {name}")
        try:
            router, status = try_client(cls, name, host, password, username, timeout)
        except Exception as exc:
            errors.append(f"{name}: {exc}")
            continue
        try:
            extras = read_raw_radio_extras(router)
            return {
                "client": name,
                "telemetry": friendly_status(status, extras),
            }
        finally:
            _dispose(router)

    raise RuntimeError("no supported MR600 local protocol found (" + "; ".join(errors) + ")")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--timeout", type=int, default=8)
    parser.add_argument("--client", default="auto", choices=["auto", *CLIENTS.keys()])
    args = parser.parse_args()

    password = os.environ.get("TPLINK_ROUTER_PASSWORD", "")
    username = os.environ.get("TPLINK_ROUTER_USER", "admin")
    if not password:
        raise RuntimeError("TPLINK_ROUTER_PASSWORD is required")

    result = poll(normalise_host(args.host), username, password, args.timeout, args.client)
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
