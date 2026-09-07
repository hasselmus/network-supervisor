#!/usr/bin/env python3
"""Tiny, read-only Wi-Fi witness for Raspberry Pi-class Linux hosts.

It exposes only GET /status. It never accepts commands or remediation actions.
"""
import json
import os
import random
import re
import socket
import struct
import subprocess
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BOOT_ID = open('/proc/sys/kernel/random/boot_id', encoding='ascii').read().strip()
IFACE = os.environ.get('WITNESS_IFACE', 'wlan0')
SUPERVISOR = os.environ.get('WITNESS_SUPERVISOR', '').strip()
INTERNET = os.environ.get('WITNESS_INTERNET', '1.1.1.1').strip()
DNS_NAME = os.environ.get('WITNESS_DNS_NAME', 'example.com').strip()
PORT = int(os.environ.get('WITNESS_PORT', '8791'))


def run(cmd, timeout=2):
    try:
        return subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, timeout=timeout, check=False
        ).stdout
    except Exception:
        return ''


def default_gateway():
    """Discover the IPv4 default gateway for the Wi-Fi interface."""
    out = run(['/sbin/ip', '-4', 'route', 'show', 'default', 'dev', IFACE])
    if not out:
        out = run(['/usr/sbin/ip', '-4', 'route', 'show', 'default', 'dev', IFACE])
    match = re.search(r'\bvia\s+(\d+\.\d+\.\d+\.\d+)\b', out)
    return match.group(1) if match else None


def ping(host):
    if not host:
        return None
    try:
        return subprocess.run(
            ['/bin/ping', '-n', '-c', '1', '-W', '1', host],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=2, check=False
        ).returncode == 0
    except Exception:
        return False


def wifi():
    text = run(['/usr/sbin/iw', 'dev', IFACE, 'link'])
    if not text:
        text = run(['/sbin/iw', 'dev', IFACE, 'link'])
    if 'Not connected' in text:
        return {'connected': False}
    bssid = re.search(r'Connected to\s+([0-9a-f:]{17})', text, re.I)
    ssid = re.search(r'SSID:\s*(.+)', text)
    signal = re.search(r'signal:\s*(-?[\d.]+)\s*dBm', text, re.I)
    return {
        'connected': bool(bssid),
        'bssid': bssid.group(1).lower() if bssid else None,
        'ssid': ssid.group(1).strip() if ssid else None,
        'signalDbm': float(signal.group(1)) if signal else None,
    }


def system_uptime_seconds():
    try:
        return int(float(open('/proc/uptime', encoding='ascii').read().split()[0]))
    except Exception:
        return None


def _dns_name_wire(name):
    parts = [p.encode('idna') for p in name.rstrip('.').split('.') if p]
    return b''.join(bytes([len(p)]) + p for p in parts) + b'\x00'


def dns_probe(server, name, timeout=1.5):
    """Send one A query directly to the supplied DNS server."""
    if not server or not name:
        return None
    ident = random.randrange(0, 65536)
    header = struct.pack('!HHHHHH', ident, 0x0100, 1, 0, 0, 0)
    question = _dns_name_wire(name) + struct.pack('!HH', 1, 1)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(header + question, (server, 53))
        data, _ = sock.recvfrom(4096)
        if len(data) < 12:
            return False
        rid, flags, _qd, an, _ns, _ar = struct.unpack('!HHHHHH', data[:12])
        rcode = flags & 0x000F
        return rid == ident and bool(flags & 0x8000) and rcode == 0 and an >= 0
    except Exception:
        return False
    finally:
        sock.close()


def status():
    router = os.environ.get('WITNESS_ROUTER', '').strip() or default_gateway()
    return {
        'hostname': socket.gethostname(),
        'bootId': BOOT_ID,
        'uptimeSeconds': system_uptime_seconds(),
        'interface': IFACE,
        **wifi(),
        'router': router,
        'routerReachable': ping(router),
        'routerDnsReachable': dns_probe(router, DNS_NAME),
        'supervisorReachable': ping(SUPERVISOR),
        'internetReachable': ping(INTERNET),
        'timestamp': int(time.time()),
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if urllib.parse.urlparse(self.path).path != '/status':
            self.send_error(404)
            return
        body = json.dumps(status()).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
