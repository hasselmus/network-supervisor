import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HELPER = path.join(HERE, 'mr600_probe.py');
let detectedClient = null;

function pythonPath() {
  if (process.env.MR600_PYTHON) return process.env.MR600_PYTHON;
  const venv = path.join(ROOT, '.venv', 'bin', 'python');
  return existsSync(venv) ? venv : (process.env.PYTHON3 || 'python3');
}

async function invoke(spec, creds, client) {
  const timeoutMs = Number(spec.timeoutMs || 12000);
  const timeoutSeconds = Math.max(2, Math.ceil(timeoutMs / 1000) - 2);
  const { stdout } = await execFileP(
    pythonPath(),
    [HELPER, '--host', spec.host, '--timeout', String(timeoutSeconds), '--client', client],
    {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        TPLINK_ROUTER_USER: creds.username || 'admin',
        TPLINK_ROUTER_PASSWORD: creds.password || '',
      },
    },
  );
  const parsed = JSON.parse(stdout);
  if (!parsed?.telemetry) throw new Error('MR600 helper returned no telemetry');
  return parsed;
}

export async function pollMR600(spec, creds) {
  if (!spec?.enabled) return { configured: false };
  if (!spec.host) return { configured: true, ok: false, error: 'cellularRouter.host is not configured' };
  if (!creds?.password) return { configured: true, ok: false, error: 'TPLINK_ROUTER_PASSWORD is not configured' };

  const requested = detectedClient || 'auto';
  try {
    let result;
    try {
      result = await invoke(spec, creds, requested);
    } catch (firstError) {
      if (!detectedClient) throw firstError;
      detectedClient = null;
      result = await invoke(spec, creds, 'auto');
    }
    detectedClient = result.client || detectedClient;
    return {
      configured: true,
      ok: true,
      host: spec.host,
      client: result.client,
      telemetry: result.telemetry,
      sampledAtMs: Date.now(),
    };
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    return {
      configured: true,
      ok: false,
      host: spec.host,
      error: detail || 'MR600 telemetry failed',
      sampledAtMs: Date.now(),
    };
  }
}

export function assessMR600(cellular, spec = {}) {
  if (!cellular?.configured) return { state: 'disabled', label: 'Not configured' };
  if (!cellular.ok) return { state: 'unknown', label: 'Telemetry unavailable' };
  const t = cellular.telemetry || {};
  if (!t.registered) return { state: 'critical', label: 'Cellular not registered' };

  const weakRsrp = Number(spec.weakRsrpDbm ?? -110);
  const poorRsrq = Number(spec.poorRsrqDb ?? -16);
  const poorSnr = Number(spec.poorSnrDb ?? 2);
  const poor = [];
  if (Number.isFinite(Number(t.rsrpDbm)) && Number(t.rsrpDbm) <= weakRsrp) poor.push(`RSRP ${t.rsrpDbm} dBm`);
  if (Number.isFinite(Number(t.rsrqDb)) && Number(t.rsrqDb) <= poorRsrq) poor.push(`RSRQ ${t.rsrqDb} dB`);
  if (Number.isFinite(Number(t.snrDb)) && Number(t.snrDb) <= poorSnr) poor.push(`SNR ${Number(t.snrDb).toFixed(1)} dB`);
  if (poor.length) return { state: 'warning', label: 'Radio quality degraded', detail: poor.join(' · ') };
  return { state: 'ok', label: 'LTE registered / radio plausible' };
}

export function summariseCellularSamples(samples = []) {
  const good = samples.filter(x => x?.ok && x?.registered);
  if (!good.length) return null;
  const nums = key => good.map(x => Number(x[key])).filter(Number.isFinite);
  const stats = arr => {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    return { min: sorted[0], median, max: sorted.at(-1) };
  };
  const identities = [...new Set(good.map(x => [x.band, x.earfcn, x.pci, x.cell_id].filter(v => v != null && v !== '').join('/')).filter(Boolean))];
  return {
    samples: good.length,
    rsrpDbm: stats(nums('rsrp_dbm')),
    rsrqDb: stats(nums('rsrq_db')),
    snrDb: stats(nums('snr_db')),
    observedCells: identities.slice(0, 8),
  };
}
