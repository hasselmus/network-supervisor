#!/usr/bin/env node
import http from 'node:http';
import os from 'node:os';
import process from 'node:process';
import { loadConfig } from './config.mjs';
import { pollEasySmart } from './tplink-easy-smart.mjs';
import { ping, dnsProbe, wifiLink, interfaceLink, fetchWitness } from './probes.mjs';
import { pollMR600, assessMR600 } from './mr600.mjs';
import { computeCounterDeltas, diagnose, FaultLatch } from './diagnose.mjs';
import { Storage } from './storage.mjs';
import { diagnoseWithAI } from './ai.mjs';

const { config, configPath, dataDir } = loadConfig();
if (process.argv.includes('--check-config')) {
  console.log(`OK: ${config.name}; ${(config.switches || []).length} switches, ${(config.nodes || []).length} nodes, ${(config.links || []).length} links${config.cellularRouter?.enabled ? ', cellular telemetry enabled' : ''}.`);
  process.exit(0);
}

const storage = new Storage(dataDir);
const switchCreds = {
  username: process.env.TPLINK_SWITCH_USER || '',
  password: process.env.TPLINK_SWITCH_PASSWORD || '',
};
const routerCreds = {
  username: process.env.TPLINK_ROUTER_USER || 'admin',
  password: process.env.TPLINK_ROUTER_PASSWORD || '',
};
if ((config.switches || []).length && (!switchCreds.username || !switchCreds.password)) {
  throw new Error('TPLINK_SWITCH_USER and TPLINK_SWITCH_PASSWORD are required in .env');
}

const cellularSpec = config.cellularRouter?.enabled
  ? { ...config.cellularRouter, host: config.cellularRouter.host || config.observer.router }
  : null;
const latch = new FaultLatch(config.debounce?.failures ?? 3, config.debounce?.recoveries ?? 2);
const previousCounters = new Map();
const previousWitnessBoot = new Map();
let polling = false;
let current = {
  site: config.name,
  startedMs: Date.now(),
  pollStartedMs: null,
  pollFinishedMs: null,
  switches: {},
  interfaces: {},
  nodes: {},
  witnesses: {},
  wifi: null,
  cellular: cellularSpec ? { configured: true, ok: false, error: 'Not yet polled' } : { configured: false },
  cellularAssessment: null,
  rawDiagnoses: [],
  diagnoses: [],
  configPath,
};

function ifaceAddress(name) {
  const explicit = config.observer?.interfaceAddresses?.[name];
  if (explicit) return explicit;
  return (os.networkInterfaces()[name] || []).find(x => x.family === 'IPv4' && !x.internal)?.address || null;
}

async function pollSwitch(sw) {
  try {
    return [sw.id, { ok: true, name: sw.name, host: sw.host, ports: await pollEasySmart({ host: sw.host, ...switchCreds }) }];
  } catch (err) {
    return [sw.id, { ok: false, name: sw.name, host: sw.host, error: String(err?.message || err), ports: [] }];
  }
}

async function pollInterface(name) {
  if (!name) return null;
  const address = ifaceAddress(name);
  const [link, router, internet, dns] = await Promise.all([
    interfaceLink(name),
    ping(config.observer.router, name),
    Promise.all((config.observer.internetTargets || []).map(async target => ({ target, ...await ping(target, name) }))),
    dnsProbe(config.observer.dnsServer, address).catch(err => ({ ok: false, error: String(err) })),
  ]);
  return [name, { configured: true, address, link, router, internet, dns }];
}

async function pollNode(n) {
  if (!n.host || n.probe !== 'ping') return [n.id, { name: n.name, skipped: true }];
  return [n.id, { name: n.name, host: n.host, ...await ping(n.host) }];
}

async function pollWitness(w) {
  const r = await fetchWitness(w);
  const enriched = { ...r, name: w.name, expectedClosestAp: w.expectedClosestAp || null, unreliable: w.unreliable !== false };
  if (r.ok && r.bootId) {
    const prev = previousWitnessBoot.get(w.id);
    if (prev && prev !== r.bootId) {
      storage.event('witness', 'info', `witness:${w.id}:reboot`, `${w.name} rebooted`, { previousBootId: prev, bootId: r.bootId });
    }
    previousWitnessBoot.set(w.id, r.bootId);
  }
  return [w.id, enriched];
}

async function pollCycle() {
  if (polling) return;
  polling = true;
  const started = Date.now();
  try {
    const [switchPairs, interfacePairs, nodePairs, witnessPairs, wifi, cellular] = await Promise.all([
      Promise.all((config.switches || []).map(pollSwitch)),
      Promise.all([...new Set([config.observer?.ethernetInterface, config.observer?.wifiInterface].filter(Boolean))].map(pollInterface)),
      Promise.all((config.nodes || []).map(pollNode)),
      Promise.all((config.witnesses || []).map(pollWitness)),
      config.observer?.wifiInterface ? wifiLink(config.observer.wifiInterface) : null,
      cellularSpec ? pollMR600(cellularSpec, routerCreds) : Promise.resolve({ configured: false }),
    ]);

    const switches = Object.fromEntries(switchPairs);
    computeCounterDeltas(switches, previousCounters);
    const interfaces = Object.fromEntries(interfacePairs.filter(Boolean));
    const nodes = Object.fromEntries(nodePairs);
    const witnesses = Object.fromEntries(witnessPairs);
    const cellularAssessment = cellularSpec ? assessMR600(cellular, cellularSpec) : null;
    storage.cellularSample(cellular);

    const candidate = { switches, interfaces, nodes, witnesses, wifi, cellular };
    const rawDiagnoses = diagnose(config, candidate);
    const latched = latch.update(rawDiagnoses);
    for (const t of latched.transitions) {
      if (t.type === 'started') storage.event('fault', t.item.severity, t.item.id, t.item.title, t.item);
      else storage.event('recovery', 'info', t.item.id, `Recovered: ${t.item.title}`, t.item);
    }
    current = {
      ...current,
      ...candidate,
      cellularAssessment,
      pollStartedMs: started,
      pollFinishedMs: Date.now(),
      rawDiagnoses,
      diagnoses: latched.active,
      supervisorError: null,
    };
  } catch (err) {
    storage.event('supervisor', 'warning', 'supervisor:poll-error', `Polling cycle failed: ${err?.message || err}`);
    current = { ...current, pollStartedMs: started, pollFinishedMs: Date.now(), supervisorError: String(err?.stack || err) };
  } finally {
    polling = false;
  }
}

function json(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function text(res, body, type = 'text/plain; charset=utf-8', status = 200) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
function readBody(req, max = 65536) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', c => {
      s += c;
      if (s.length > max) { reject(new Error('request too large')); req.destroy(); }
    });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

const HTML = String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Network supervisor</title><style>
:root{font-family:system-ui,-apple-system,Segoe UI,sans-serif;color-scheme:light dark;--bg:#101418;--card:#181f26;--fg:#edf2f5;--muted:#9dabba;--line:#303b46;--crit:#ff7474;--warn:#f1bd58;--ok:#6fd19a}@media(prefers-color-scheme:light){:root{--bg:#f4f6f8;--card:#fff;--fg:#111820;--muted:#687581;--line:#d8dfe5;--crit:#a51616;--warn:#825400;--ok:#176b3c}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg)}main{max-width:1450px;margin:auto;padding:18px}h1{font-size:1.4rem;margin:0}.top{display:flex;gap:14px;align-items:center;flex-wrap:wrap}.muted{color:var(--muted)}.status{font-weight:700}.ok{color:var(--ok)}.critical{color:var(--crit)}.warning{color:var(--warn)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin-top:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.card h2{font-size:1rem;margin:0 0 8px}.fault{border-left:5px solid var(--line);margin:8px 0;padding:8px}.fault.critical{border-left-color:var(--crit)}.fault.warning{border-left-color:var(--warn)}table{width:100%;border-collapse:collapse;font-size:.88rem}td,th{text-align:left;border-bottom:1px solid var(--line);padding:5px}button,textarea{font:inherit}button{padding:7px 10px;border:1px solid var(--line);border-radius:7px;background:var(--card);color:var(--fg);cursor:pointer}textarea{width:100%;min-height:76px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}.small{font-size:.82rem}.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:.9rem}.kv>span:nth-child(odd){color:var(--muted)}
</style></head><body><main><div class="top"><h1 id="title">Network supervisor</h1><span id="overall" class="status">Loading…</span><button onclick="pollNow()">Poll now</button><span id="stamp" class="muted small"></span></div><div id="faults"></div><div class="grid"><section class="card"><h2>Managed Ethernet</h2><div id="switches"></div></section><section class="card"><h2>Functional paths</h2><div id="paths"></div></section><section class="card"><h2>4G / WAN</h2><div id="cellular"></div></section><section class="card"><h2>Wi-Fi witnesses</h2><div id="witnesses"></div></section><section class="card"><h2>Diagnosis / observation</h2><textarea id="problem" placeholder="Optional human observation, e.g. ‘phone shows Wi-Fi but pages do not load’"></textarea><p><button onclick="saveObservation()">Save observation</button> <button onclick="askAI()">Ask configured AI</button></p><pre id="ai" class="small muted"></pre></section></div><script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=v=>v==null||v===''?'—':esc(v);const fmtRate=v=>{v=Number(v);if(!Number.isFinite(v))return'—';if(v>=1e6)return(v/1e6).toFixed(1)+' MB/s';if(v>=1e3)return(v/1e3).toFixed(1)+' KB/s';return Math.round(v)+' B/s'};
async function api(url,opt){const r=await fetch(url,opt),d=await r.json();if(!r.ok)throw new Error(d.error||r.statusText);return d}
function renderCellular(d){const c=d.cellular,a=d.cellularAssessment,el=document.getElementById('cellular');if(!c?.configured){el.innerHTML='<span class="muted">Not configured.</span>';return}if(!c.ok){el.innerHTML='<p><b class="warning">Telemetry unavailable</b></p><p class="small muted">'+esc(c.error||'')+'</p>';return}const t=c.telemetry||{},klass=a?.state==='warning'?'warning':a?.state==='critical'?'critical':'ok';let cell=[t.band?'B'+t.band:null,t.earfcn?'EARFCN '+t.earfcn:null,t.pci?'PCI '+t.pci:null].filter(Boolean).join(' · ');let extra=t.secondaryBand?' + B'+t.secondaryBand:'';el.innerHTML='<p><b class="'+klass+'">'+esc(a?.label||'LTE telemetry')+'</b>'+(a?.detail?'<br><span class="small muted">'+esc(a.detail)+'</span>':'')+'</p><div class="kv"><span>Network</span><b>'+fmt(t.networkTypeInfo)+'</b><span>ISP</span><span>'+fmt(t.isp)+'</span><span>Cell</span><span>'+fmt(cell||t.cellId)+(extra?esc(extra):'')+'</span><span>CID</span><span>'+fmt(t.cellId)+'</span><span>RSRP</span><span>'+fmt(t.rsrpDbm)+' dBm</span><span>RSRQ</span><span>'+fmt(t.rsrqDb)+' dB</span><span>SNR</span><span>'+(t.snrDb==null?'—':esc(Number(t.snrDb).toFixed(1))+' dB')+'</span><span>Traffic</span><span>↓ '+fmtRate(t.rxBytesPerSecond)+' · ↑ '+fmtRate(t.txBytesPerSecond)+'</span><span>SIM</span><span>'+fmt(t.simStatusInfo)+'</span></div>'}
function renderInterface(n,x){const good=(x.internet||[]).filter(y=>y.ok),lat=good.length?' · '+Math.round(Math.min(...good.map(y=>y.ms)))+' ms':'';const l=x.link||{},link=l.available?(l.link||l.operstate||'unknown'):null;const linkText=link?' · link '+esc(link):'';return'<p><b>'+esc(n)+'</b> '+esc(x.address||'')+linkText+'<br>router '+(x.router?.ok?'✓':'✗')+' · Internet '+(good.length?'✓'+lat:'✗')+' · DNS '+(x.dns?.ok?'✓':'✗')+'</p>'}
async function load(){try{const d=await api('/api/status');document.getElementById('title').textContent=d.site;const faults=d.diagnoses||[],highest=faults.find(x=>x.severity==='critical')?'critical':faults.find(x=>x.severity==='warning')?'warning':'ok',ov=document.getElementById('overall');ov.className='status '+highest;ov.textContent=faults.length?faults.length+' active diagnosis'+(faults.length===1?'':'es'):'Network appears healthy';document.getElementById('stamp').textContent=d.pollFinishedMs?'Last poll '+new Date(d.pollFinishedMs).toLocaleString():'';document.getElementById('faults').innerHTML=faults.map(f=>'<div class="card fault '+esc(f.severity)+'"><b>'+esc(f.title)+'</b><div class="small">'+esc(f.detail)+'</div></div>').join('');const specs=Object.fromEntries((d.configSummary.switches||[]).map(s=>[s.id,s]));const switchHtml=Object.entries(d.switches||{}).map(([id,sw])=>{if(!sw.ok)return'<p><b>'+esc(sw.name)+'</b>: <span class="warning">poll failed</span> '+esc(sw.error)+'</p>';const spec=specs[id]||{};return'<p><b>'+esc(sw.name)+'</b> <span class="muted">'+esc(sw.host)+'</span></p><table><tr><th>Port</th><th>Use</th><th>Link</th><th>Bad Δ</th></tr>'+sw.ports.map(p=>'<tr><td>'+p.port+'</td><td>'+esc(spec.ports?.[String(p.port)]?.name||'')+'</td><td>'+esc(p.link)+'</td><td>'+esc(p.badDelta)+'</td></tr>').join('')+'</table>'}).join('');document.getElementById('switches').innerHTML=switchHtml||'<span class="muted">No managed switches configured.</span>';document.getElementById('paths').innerHTML=Object.entries(d.interfaces||{}).map(([n,x])=>renderInterface(n,x)).join('')+(d.wifi?'<p class="small muted">wlan: '+esc(d.wifi.ssid||'')+' · '+esc(d.wifi.bssid||'')+' · '+esc(d.wifi.signalDbm??'?')+' dBm</p>':'');renderCellular(d);document.getElementById('witnesses').innerHTML=Object.entries(d.witnesses||{}).map(([id,w])=>'<p><b>'+esc(w.name||id)+'</b>: '+(w.ok?'✓':'unavailable')+(w.ok?'<br><span class="small muted">'+esc(w.hostname||'')+' · BSSID '+esc(w.bssid||'?')+' · '+esc(w.signalDbm??'?')+' dBm · uptime '+esc(w.uptimeSeconds??'?')+' s</span>':'')+'</p>').join('')||'<span class="muted">No witnesses configured.</span>'}catch(e){document.getElementById('overall').textContent=e.message}}
async function pollNow(){await api('/api/poll',{method:'POST'});setTimeout(load,800)}async function saveObservation(){await api('/api/observe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:document.getElementById('problem').value})});document.getElementById('ai').textContent='Observation saved.'}async function askAI(){const out=document.getElementById('ai');out.textContent='Asking…';try{const d=await api('/api/ai-diagnose',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({problem:document.getElementById('problem').value})});out.textContent=typeof d.answer==='string'?d.answer:JSON.stringify(d.answer,null,2)}catch(e){out.textContent=e.message}}load();setInterval(load,15000);
</script></main></body></html>`;

const host = process.env.WEB_HOST || '0.0.0.0';
const port = Math.max(1, Math.min(65535, Number(process.env.WEB_PORT || 8790)));
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/') return text(res, HTML, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, {
      ...current,
      configSummary: {
        switches: config.switches,
        nodes: config.nodes,
        links: config.links,
        witnesses: config.witnesses,
        cellularRouter: cellularSpec,
      },
    });
    if (req.method === 'GET' && url.pathname === '/api/events') return json(res, storage.recentEvents(Math.min(500, Number(url.searchParams.get('limit') || 100))));
    if (req.method === 'GET' && url.pathname === '/api/cellular-history') return json(res, storage.recentCellularSamples(Math.min(500, Number(url.searchParams.get('limit') || 120))));
    if (req.method === 'POST' && url.pathname === '/api/poll') { pollCycle(); return json(res, { ok: true, polling: true }); }
    if (req.method === 'POST' && url.pathname === '/api/observe') { const body = JSON.parse(await readBody(req) || '{}'); storage.observation(body.text); return json(res, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/api/ai-diagnose') { const body = JSON.parse(await readBody(req) || '{}'); return json(res, { answer: await diagnoseWithAI({ config, current, storage, problem: body.problem }) }); }
    return json(res, { error: 'not found' }, 404);
  } catch (err) {
    return json(res, { error: String(err?.message || err) }, 500);
  }
});

server.on('error', err => {
  if (err?.code === 'EADDRINUSE') console.error(`Dashboard port ${port} is already in use; stop the other network-supervisor instance or change WEB_PORT.`);
  else console.error(err);
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`Network supervisor: http://${host}:${port}/ — ${config.name}`));
await pollCycle();
setInterval(pollCycle, Math.max(10, Number(config.pollIntervalSeconds || 30)) * 1000).unref();
