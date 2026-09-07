import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const PYTHON_HELPER = fileURLToPath(new URL('./easysmart_probe.py', import.meta.url));

const LINK_NAMES = {
  0: 'Link Down',
  1: 'LS 1',
  2: '10M Half',
  3: '10M Full',
  4: 'LS 4',
  5: '100M Full',
  6: '1000M Full'
};

function extractArray(text, key) {
  const m = text.match(new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`, 'm'));
  if (!m) throw new Error(`TP-Link response does not contain ${key}`);
  return m[1].split(',').map(x => x.trim()).filter(Boolean).map(Number);
}

export function parsePortStatistics(text) {
  const maxMatch = text.match(/var\s+max_port_num\s*=\s*(\d+)\s*;/m);
  const state = extractArray(text, 'state');
  const link = extractArray(text, 'link_status');
  const pkts = extractArray(text, 'pkts');
  const maxPorts = maxMatch ? Number(maxMatch[1]) : Math.min(state.length, link.length);
  if (pkts.length < maxPorts * 4) throw new Error(`TP-Link packet array too short (${pkts.length} for ${maxPorts} ports)`);
  const ports = [];
  for (let i = 0; i < maxPorts; i++) {
    ports.push({
      port: i + 1,
      enabled: state[i] === 1,
      stateCode: state[i],
      linkCode: link[i],
      link: LINK_NAMES[link[i]] ?? `Unknown ${link[i]}`,
      up: link[i] !== 0,
      txGood: pkts[i * 4],
      txBad: pkts[i * 4 + 1],
      rxGood: pkts[i * 4 + 2],
      rxBad: pkts[i * 4 + 3]
    });
  }
  return ports;
}

// Kept as an optional pure-Node backend for development. The default backend
// is the small requests.Session() helper below because real Easy Smart firmware
// has proved less standards-compliant than our synthetic HTTP tests.
function setCookieValues(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = headers.get('set-cookie');
  return raw ? raw.split(/,(?=[^;,]+=)/) : [];
}

class CookieJar {
  constructor() { this.values = new Map(); }
  absorb(headers) {
    for (const raw of setCookieValues(headers)) {
      const first = raw.split(';', 1)[0].trim();
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (/max-age\s*=\s*0/i.test(raw) || !value) this.values.delete(name);
      else this.values.set(name, value);
    }
  }
  header() { return [...this.values].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function sessionFetch(url, options, jar, timeoutMs, maxRedirects = 5) {
  let currentUrl = url;
  let method = (options.method || 'GET').toUpperCase();
  let body = options.body;
  const baseHeaders = new Headers(options.headers || {});
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const headers = new Headers(baseHeaders);
    const cookie = jar.header();
    if (cookie) headers.set('cookie', cookie);
    const response = await fetch(currentUrl, {
      ...options, method, body, headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs)
    });
    jar.absorb(response.headers);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (redirects === maxRedirects) throw new Error('too many redirects during TP-Link login');
    currentUrl = new URL(location, currentUrl).href;
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      method = 'GET';
      body = undefined;
      baseHeaders.delete('content-type');
      baseHeaders.delete('content-length');
    }
  }
  throw new Error('unexpected redirect loop');
}

export async function pollEasySmartNode({ host, username, password, timeoutMs = 6000 }) {
  const base = `http://${host}`;
  const jar = new CookieJar();
  const body = new URLSearchParams({ logon: 'Login', username, password });
  const login = await sessionFetch(`${base}/logon.cgi`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: `${base}/Logout.htm` },
    body
  }, jar, timeoutMs);
  if (!login.ok) throw new Error(`login HTTP ${login.status}`);
  const stats = await sessionFetch(`${base}/PortStatisticsRpm.htm`, { headers: { referer: `${base}/` } }, jar, timeoutMs);
  if (!stats.ok) throw new Error(`statistics HTTP ${stats.status}`);
  const text = await stats.text();
  if (!/\bstate\s*:\s*\[/m.test(text)) {
    if (/logon\.cgi|name=["']?username|\bLogin\b/i.test(text)) throw new Error('TP-Link returned the login page instead of port statistics (session/authentication failed)');
    throw new Error('TP-Link statistics response does not contain state');
  }
  return parsePortStatistics(text);
}

export async function pollEasySmartPython({ host, username, password, timeoutMs = 6000 }) {
  const python = process.env.PYTHON3 || 'python3';
  const timeoutSeconds = Math.max(1, timeoutMs / 1000);
  try {
    const { stdout } = await execFileAsync(python, [PYTHON_HELPER, '--host', host, '--timeout', String(timeoutSeconds)], {
      timeout: timeoutMs + 3000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, TPLINK_SWITCH_USER: username, TPLINK_SWITCH_PASSWORD: password }
    });
    const ports = JSON.parse(stdout);
    if (!Array.isArray(ports)) throw new Error('helper returned non-array JSON');
    return ports;
  } catch (err) {
    const detail = String(err?.stderr || err?.message || err).trim();
    throw new Error(`Easy Smart requests.Session probe failed: ${detail}`);
  }
}

export async function pollEasySmart(options) {
  const backend = String(process.env.TPLINK_EASYSMART_BACKEND || 'python').toLowerCase();
  if (backend === 'python') return pollEasySmartPython(options);
  if (backend === 'node') return pollEasySmartNode(options);
  throw new Error(`Unknown TPLINK_EASYSMART_BACKEND ${backend}; expected python or node`);
}
