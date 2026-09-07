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

function cookieHeader(headers) {
  const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie')].filter(Boolean);
  return values.flatMap(raw => raw.split(/,(?=[^;,]+=)/)).map(x => x.split(';', 1)[0].trim()).filter(Boolean).join('; ');
}

export async function pollEasySmart({ host, username, password, timeoutMs = 6000 }) {
  const base = `http://${host}`;
  const body = new URLSearchParams({ logon: 'Login', username, password });
  const login = await fetch(`${base}/logon.cgi`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: `${base}/Logout.htm` },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (![200, 302, 303].includes(login.status)) throw new Error(`login HTTP ${login.status}`);
  const cookie = cookieHeader(login.headers);
  const stats = await fetch(`${base}/PortStatisticsRpm.htm`, {
    headers: { referer: `${base}/`, ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!stats.ok) throw new Error(`statistics HTTP ${stats.status}`);
  const text = await stats.text();
  return parsePortStatistics(text);
}
