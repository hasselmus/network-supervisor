import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import dgram from 'node:dgram';
const execFileP = promisify(execFile);

export async function ping(target, iface = null, timeoutSeconds = 2) {
  const args = [];
  if (iface) args.push('-I', iface);
  args.push('-n', '-c', '1', '-W', String(timeoutSeconds), target);
  const started = Date.now();
  try {
    const { stdout } = await execFileP('/bin/ping', args, { timeout: (timeoutSeconds + 1) * 1000 });
    const match = stdout.match(/time[=<]([\d.]+)\s*ms/i);
    const measured = match ? Number(match[1]) : Date.now() - started;
    return { ok: true, ms: Number.isFinite(measured) ? measured : Date.now() - started };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: String(err?.message || err) };
  }
}

async function readSysfs(path) {
  try { return (await readFile(path, 'utf8')).trim(); }
  catch { return null; }
}

/** Read Linux's local view of an interface's physical/operational link.
 *
 * For Ethernet this gives hard local carrier evidence even when there is no
 * managed switch at the far end. speed/duplex are best-effort: Linux may omit
 * them or return -1 while the link is down. For Wi-Fi, `iw ... link` remains the
 * more informative association probe, but operstate/carrier are still useful
 * context.
 */
export async function interfaceLink(iface) {
  if (!iface) return { available: false };
  const base = `/sys/class/net/${iface}`;
  const [carrierRaw, operstate, speedRaw, duplexRaw] = await Promise.all([
    readSysfs(`${base}/carrier`),
    readSysfs(`${base}/operstate`),
    readSysfs(`${base}/speed`),
    readSysfs(`${base}/duplex`),
  ]);
  if ([carrierRaw, operstate, speedRaw, duplexRaw].every(v => v == null)) {
    return { available: false, error: `interface ${iface} not found in sysfs` };
  }
  const carrier = carrierRaw === '1' ? true : carrierRaw === '0' ? false : null;
  const speedN = Number(speedRaw);
  const speedMbps = Number.isFinite(speedN) && speedN > 0 ? speedN : null;
  const duplex = duplexRaw && !/^unknown$/i.test(duplexRaw) ? duplexRaw.toLowerCase() : null;
  const link = carrier === false
    ? 'Link Down'
    : speedMbps && duplex
      ? `${speedMbps}M ${duplex[0].toUpperCase()}${duplex.slice(1)}`
      : carrier === true ? 'Link Up' : null;
  return { available: true, carrier, operstate: operstate || null, speedMbps, duplex, link };
}

function dnsQueryPacket(name = 'example.com') {
  const id = Math.floor(Math.random() * 65536), labels = name.split('.'), qname = Buffer.concat([...labels.map(s => Buffer.concat([Buffer.from([s.length]), Buffer.from(s)])), Buffer.from([0])]), head = Buffer.alloc(12), tail = Buffer.alloc(4);
  head.writeUInt16BE(id, 0); head.writeUInt16BE(0x0100, 2); head.writeUInt16BE(1, 4); tail.writeUInt16BE(1, 0); tail.writeUInt16BE(1, 2);
  return { id, packet: Buffer.concat([head, qname, tail]) };
}

export function dnsProbe(server, sourceAddress = null, timeoutMs = 2500) {
  return new Promise(resolve => {
    const { id, packet } = dnsQueryPacket();
    const sock = dgram.createSocket('udp4'), started = Date.now();
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch {}
      resolve({ ...result, ms: Date.now() - started });
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
    sock.on('error', err => finish({ ok: false, error: err.message }));
    sock.on('message', msg => {
      if (msg.length < 12 || msg.readUInt16BE(0) !== id) return;
      const flags = msg.readUInt16BE(2), rcode = flags & 15;
      finish({ ok: (flags & 0x8000) !== 0 && rcode === 0, rcode });
    });
    const send = () => sock.send(packet, 53, server, err => { if (err) finish({ ok: false, error: err.message }); });
    if (sourceAddress) sock.bind({ address: sourceAddress, port: 0 }, send); else send();
  });
}

export async function wifiLink(iface = 'wlan0') {
  try {
    const { stdout } = await execFileP('/usr/sbin/iw', ['dev', iface, 'link'], { timeout: 2000 });
    if (/Not connected/i.test(stdout)) return { connected: false, raw: stdout.trim() };
    const bssid = stdout.match(/Connected to\s+([0-9a-f:]{17})/i)?.[1]?.toLowerCase() || null;
    const ssid = stdout.match(/SSID:\s*(.+)/)?.[1]?.trim() || null;
    const signalDbm = Number(stdout.match(/signal:\s*(-?[\d.]+)\s*dBm/i)?.[1] ?? NaN);
    return { connected: true, bssid, ssid, signalDbm: Number.isFinite(signalDbm) ? signalDbm : null };
  } catch (err) {
    return { connected: null, error: String(err?.message || err) };
  }
}

export async function fetchWitness(w, timeoutMs = 3000) {
  try {
    const r = await fetch(w.url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { ok: true, ...(await r.json()) };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
