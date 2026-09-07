import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

export function loadDotEnv(filename = path.join(ROOT, '.env')) {
  if (!existsSync(filename)) return;
  for (const raw of readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function loadConfig() {
  loadDotEnv();
  const configPath = path.resolve(ROOT, process.env.SITE_CONFIG || 'site.local.json');
  if (!existsSync(configPath)) throw new Error(`Site configuration not found: ${configPath}`);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  validateConfig(config);
  const dataDir = process.env.DATA_DIR || '/mnt/ssd/network-supervisor';
  mkdirSync(dataDir, { recursive: true });
  return { config, configPath, dataDir };
}

export function validateConfig(c) {
  const errors = [];
  if (!c || typeof c !== 'object') errors.push('configuration must be an object');
  if (!c?.name) errors.push('name is required');
  if (!c?.observer?.router) errors.push('observer.router is required');
  if (!c?.observer?.dnsServer) errors.push('observer.dnsServer is required');
  if (!Array.isArray(c?.switches)) errors.push('switches must be an array');
  const ids = new Set();
  for (const sw of c?.switches || []) {
    if (!sw.id || !sw.host) errors.push('each switch requires id and host');
    if (ids.has(sw.id)) errors.push(`duplicate switch id: ${sw.id}`);
    ids.add(sw.id);
    for (const [p, spec] of Object.entries(sw.ports || {})) {
      if (!/^\d+$/.test(p)) errors.push(`${sw.id}: invalid port number ${p}`);
      if (spec.expectedLink && !['10M Half','10M Full','100M Full','1000M Full'].includes(spec.expectedLink)) errors.push(`${sw.id} port ${p}: unsupported expectedLink ${spec.expectedLink}`);
    }
  }
  if (errors.length) throw new Error(`Invalid site configuration:\n- ${errors.join('\n- ')}`);
}
