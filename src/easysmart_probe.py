#!/usr/bin/env python3
"""TP-Link Easy Smart switch poll helper.

This intentionally uses requests.Session(), matching the proven behaviour of
Peter Smode's essstat utility. Some Easy Smart firmware appears to couple web
session state to behaviour that Node's fetch/cookie emulation does not reproduce
reliably.

Credentials are read from TPLINK_SWITCH_USER / TPLINK_SWITCH_PASSWORD so they
never appear in argv or tracked site configuration.
"""

import argparse
import json
import os
import re
import sys

import requests

LINK_NAMES = {
    0: "Link Down",
    1: "LS 1",
    2: "10M Half",
    3: "10M Full",
    4: "LS 4",
    5: "100M Full",
    6: "1000M Full",
}


def extract_array(text: str, key: str):
    match = re.search(rf"\b{re.escape(key)}\s*:\s*\[([^\]]*)\]", text, re.MULTILINE)
    if not match:
        raise RuntimeError(f"TP-Link response does not contain {key}")
    return [int(x.strip()) for x in match.group(1).split(",") if x.strip()]


def parse_port_statistics(text: str):
    max_match = re.search(r"var\s+max_port_num\s*=\s*(\d+)\s*;", text, re.MULTILINE)
    state = extract_array(text, "state")
    link = extract_array(text, "link_status")
    pkts = extract_array(text, "pkts")
    max_ports = int(max_match.group(1)) if max_match else min(len(state), len(link))
    if len(pkts) < max_ports * 4:
        raise RuntimeError(f"TP-Link packet array too short ({len(pkts)} for {max_ports} ports)")

    ports = []
    for i in range(max_ports):
        link_code = link[i]
        ports.append({
            "port": i + 1,
            "enabled": state[i] == 1,
            "stateCode": state[i],
            "linkCode": link_code,
            "link": LINK_NAMES.get(link_code, f"Unknown {link_code}"),
            "up": link_code != 0,
            "txGood": pkts[i * 4],
            "txBad": pkts[i * 4 + 1],
            "rxGood": pkts[i * 4 + 2],
            "rxBad": pkts[i * 4 + 3],
        })
    return ports


def poll(host: str, username: str, password: str, timeout: float):
    base = f"http://{host}"
    session = requests.Session()

    login_headers = {"Referer": f"{base}/Logout.htm"}
    login_data = {"logon": "Login", "username": username, "password": password}
    response = session.post(
        f"{base}/logon.cgi",
        data=login_data,
        headers=login_headers,
        timeout=timeout,
    )
    response.raise_for_status()

    # A second GET of / is harmless on firmware where the POST already follows
    # to the UI, and matches another long-standing Easy Smart poller. It also
    # gives firmware that completes login lazily a chance to establish state.
    root = session.get(base + "/", headers={"Referer": f"{base}/"}, timeout=timeout)
    root.raise_for_status()

    headers = {
        "Referer": f"{base}/",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Upgrade-Insecure-Requests": "1",
    }
    stats = session.get(f"{base}/PortStatisticsRpm.htm", headers=headers, timeout=timeout)
    stats.raise_for_status()
    text = stats.text

    if not re.search(r"\bstate\s*:\s*\[", text):
        if re.search(r"logon\.cgi|name=[\"']?username|\bLogin\b", text, re.IGNORECASE):
            raise RuntimeError("TP-Link returned the login page instead of port statistics (session/authentication failed)")
        raise RuntimeError("TP-Link statistics response does not contain state")

    return parse_port_statistics(text)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--timeout", type=float, default=6.0)
    args = parser.parse_args()

    username = os.environ.get("TPLINK_SWITCH_USER", "")
    password = os.environ.get("TPLINK_SWITCH_PASSWORD", "")
    if not username or not password:
        raise RuntimeError("TPLINK_SWITCH_USER and TPLINK_SWITCH_PASSWORD are required")

    print(json.dumps(poll(args.host, username, password, args.timeout), separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
