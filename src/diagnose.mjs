function sevRank(s) {
  return ({ critical: 3, warning: 2, info: 1 })[s] || 0;
}

export function computeCounterDeltas(currentSwitches, previousCounters = new Map()) {
  for (const [switchId, sw] of Object.entries(currentSwitches)) {
    if (!sw.ok) continue;
    for (const p of sw.ports) {
      const key = `${switchId}:${p.port}`;
      const now = { txBad: p.txBad, rxBad: p.rxBad };
      const prev = previousCounters.get(key);
      const delta = (a, b) => a >= b ? a - b : 0;
      p.badDelta = prev ? delta(p.txBad, prev.txBad) + delta(p.rxBad, prev.rxBad) : 0;
      previousCounters.set(key, now);
    }
  }
  return previousCounters;
}

function cellularRadioProblems(spec, cellular) {
  if (!cellular?.ok || !cellular.telemetry?.registered) return [];
  const t = cellular.telemetry;
  const weakRsrp = Number(spec?.weakRsrpDbm ?? -110);
  const poorRsrq = Number(spec?.poorRsrqDb ?? -16);
  const poorSnr = Number(spec?.poorSnrDb ?? 2);
  const problems = [];
  if (Number.isFinite(Number(t.rsrpDbm)) && Number(t.rsrpDbm) <= weakRsrp) problems.push(`RSRP ${t.rsrpDbm} dBm`);
  if (Number.isFinite(Number(t.rsrqDb)) && Number(t.rsrqDb) <= poorRsrq) problems.push(`RSRQ ${t.rsrqDb} dB`);
  if (Number.isFinite(Number(t.snrDb)) && Number(t.snrDb) <= poorSnr) problems.push(`SNR ${Number(t.snrDb).toFixed(1)} dB`);
  return problems;
}

function primaryWanSamples(config, obs) {
  const preferred = config.observer?.ethernetInterface;
  const preferredObs = preferred ? obs.interfaces?.[preferred] : null;
  const source = preferredObs || Object.values(obs.interfaces || {}).find(Boolean);
  return source?.internet || [];
}

export function diagnose(config, obs) {
  const out = [];
  const linkedPorts = new Set();
  const failedLinks = new Set();

  for (const link of config.links || []) {
    if (link.expectedUp === false) continue;
    const endpointStates = [link.a, link.b]
      .map(ep => {
        if (!ep?.switch || !ep?.port) return null;
        linkedPorts.add(`${ep.switch}:${ep.port}`);
        const sw = obs.switches[ep.switch];
        return sw?.ok ? sw.ports.find(p => p.port === Number(ep.port)) || null : null;
      })
      .filter(Boolean);

    if (endpointStates.some(p => !p.up)) {
      failedLinks.add(link.id);
      out.push({
        id: `link:${link.id}`,
        severity: 'critical',
        category: 'physical',
        title: `${link.name}: Ethernet link down`,
        detail: 'Managed-switch carrier evidence shows that this expected physical link is down.',
        evidence: endpointStates.map(p => `port ${p.port}: ${p.link}`),
      });
    }
  }

  for (const swSpec of config.switches || []) {
    const sw = obs.switches[swSpec.id];
    if (!sw?.ok) {
      const explained = (config.links || []).some(link =>
        [link.a, link.b].some(ep => ep?.switch === swSpec.id) && failedLinks.has(link.id));
      if (!explained) {
        out.push({
          id: `switch:${swSpec.id}:management`,
          severity: 'warning',
          category: 'management',
          title: `${swSpec.name}: management interface unavailable`,
          detail: sw?.error || 'HTTP polling failed.',
        });
      }
      continue;
    }

    for (const [portNo, pSpec] of Object.entries(swSpec.ports || {})) {
      const p = sw.ports.find(x => x.port === Number(portNo));
      if (!p) {
        out.push({
          id: `switch:${swSpec.id}:port:${portNo}:missing`,
          severity: 'warning',
          category: 'monitor',
          title: `${swSpec.name} port ${portNo}: not reported by switch`,
          detail: 'The configured port is absent from the switch statistics response.',
        });
        continue;
      }

      const key = `${swSpec.id}:${portNo}`;
      if (pSpec.expectedUp !== false && !p.up && !linkedPorts.has(key)) {
        out.push({
          id: `port:${key}:down`,
          severity: 'critical',
          category: 'physical',
          title: `${swSpec.name} port ${portNo} (${pSpec.name || 'unnamed'}): link down`,
          detail: 'This port is configured as normally up.',
        });
      }
      if (p.up && pSpec.expectedLink && p.link !== pSpec.expectedLink) {
        out.push({
          id: `port:${key}:negotiation`,
          severity: 'warning',
          category: 'physical',
          title: `${swSpec.name} port ${portNo} (${pSpec.name || 'unnamed'}): ${p.link}, expected ${pSpec.expectedLink}`,
          detail: 'The link is up but auto-negotiated speed/duplex differs from the site expectation.',
        });
      }
      const threshold = Number(pSpec.badPacketDeltaWarn ?? config.badPacketDeltaWarn ?? 100);
      if (p.badDelta >= threshold) {
        out.push({
          id: `port:${key}:errors`,
          severity: 'warning',
          category: 'physical',
          title: `${swSpec.name} port ${portNo} (${pSpec.name || 'unnamed'}): bad-packet counter rising`,
          detail: `${p.badDelta} new bad packets since the previous poll (threshold ${threshold}). Cumulative non-zero counters are not faults.`,
        });
      }
    }
  }

  const usable = Object.values(obs.interfaces || {}).filter(x => x && x.configured !== false);
  const routerOK = usable.some(x => x.router?.ok);
  const internetOK = usable.some(x => (x.internet || []).some(y => y.ok));
  const dnsOK = usable.some(x => x.dns?.ok);
  const cellSpec = config.cellularRouter || {};
  const cellular = obs.cellular;
  const radioProblems = cellularRadioProblems(cellSpec, cellular);

  if (usable.length && !routerOK && failedLinks.size === 0) {
    out.push({
      id: 'router:lan-unreachable',
      severity: 'critical',
      category: 'service',
      title: 'Router LAN service unreachable',
      detail: 'The router did not answer through any monitored interface and no managed-switch carrier fault currently explains it.',
    });
  }

  if (routerOK && !internetOK) {
    if (cellular?.ok && !cellular.telemetry?.registered) {
      out.push({
        id: 'router:cellular-registration',
        severity: 'critical',
        category: 'cellular',
        title: 'Cellular registration lost',
        detail: `The MR600 LAN is reachable, but its modem reports ${cellular.telemetry?.networkTypeInfo || 'no cellular service'}.`,
      });
    } else if (cellular?.ok && cellular.telemetry?.registered) {
      out.push({
        id: 'router:cellular-wan',
        severity: 'critical',
        category: 'cellular',
        title: radioProblems.length ? 'Cellular WAN unavailable with degraded radio' : 'LTE registered but Internet path unavailable',
        detail: radioProblems.length
          ? `MR600 remains registered, but external IP targets fail and radio quality is poor (${radioProblems.join(' · ')}).`
          : 'MR600 remains registered and its radio values are not obviously poor, but no configured external IP target is reachable. This points beyond the local LAN, e.g. cellular scheduling/core/operator path.',
      });
    } else {
      out.push({
        id: 'router:wan',
        severity: 'critical',
        category: 'service',
        title: 'Probable 4G/WAN failure',
        detail: 'The router is reachable on the LAN, but no configured external IP target is reachable.',
      });
    }
  }

  if (routerOK && internetOK && !dnsOK) {
    out.push({
      id: 'router:dns',
      severity: 'warning',
      category: 'service',
      title: 'Router DNS proxy appears faulty',
      detail: 'External IP connectivity works, but DNS queries sent directly to the router fail.',
    });
  }

  if (routerOK && internetOK && cellular?.ok && cellular.telemetry?.registered && radioProblems.length) {
    out.push({
      id: 'router:cellular-radio',
      severity: 'warning',
      category: 'cellular',
      title: 'Cellular radio quality degraded',
      detail: `${radioProblems.join(' · ')}. Internet still responds, so this is a degraded radio condition rather than a complete outage.`,
    });
  }

  // Conservative congestion/path indicator: only flag sustained high latency when
  // all configured external probes on the primary path are high, RF is plausible,
  // and the router itself is not already moving enough local traffic to make
  // self-induced queueing an obvious explanation.
  if (routerOK && internetOK && cellular?.ok && cellular.telemetry?.registered && radioProblems.length === 0) {
    const samples = primaryWanSamples(config, obs).filter(x => x?.ok && Number.isFinite(Number(x.ms)));
    const latencyWarn = Number(cellSpec.wanLatencyWarnMs ?? 250);
    const allHigh = samples.length >= 2 && samples.every(x => Number(x.ms) >= latencyWarn);
    const t = cellular.telemetry || {};
    const txBusy = Number(t.txBytesPerSecond || 0) >= Number(cellSpec.localTxBusyBytesPerSecond ?? 250000);
    const rxBusy = Number(t.rxBytesPerSecond || 0) >= Number(cellSpec.localRxBusyBytesPerSecond ?? 5000000);
    if (allHigh && !txBusy && !rxBusy) {
      out.push({
        id: 'router:cellular-latency',
        severity: 'warning',
        category: 'cellular',
        title: 'Cellular/WAN latency is unusually high',
        detail: `All primary external probes are ≥${latencyWarn} ms while LTE remains registered, RF is plausible and router traffic is low. Cellular/operator congestion or an upstream mobile-network path issue is more likely than the local LAN.`,
      });
    }
  }

  const ethName = config.observer?.ethernetInterface;
  const wifiName = config.observer?.wifiInterface;
  const eth = ethName ? obs.interfaces?.[ethName] : null;
  const wifi = wifiName ? obs.interfaces?.[wifiName] : null;
  if (eth?.router && wifi?.router) {
    if (!eth.router.ok && wifi.router.ok && failedLinks.size === 0) {
      out.push({
        id: 'path:ethernet',
        severity: 'warning',
        category: 'service',
        title: 'Ethernet path from supervisor is faulty',
        detail: `Router reachable via ${wifiName}, but not via ${ethName}.`,
      });
    }
    if (!wifi.router.ok && eth.router.ok) {
      out.push({
        id: 'path:wifi',
        severity: 'warning',
        category: 'service',
        title: 'Wi-Fi path from supervisor is faulty',
        detail: `Router reachable via ${ethName}, but not via ${wifiName}.`,
      });
    }
  }

  // Missing Pi Zero witnesses remain visible in obs.witnesses and on the
  // dashboard, but are deliberately not diagnoses. They are unreliable by
  // design and may later be used only as corroborating evidence.
  return out.sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || a.title.localeCompare(b.title));
}

export class FaultLatch {
  constructor(failures = 3, recoveries = 2) {
    this.failures = failures;
    this.recoveries = recoveries;
    this.states = new Map();
  }

  update(raw) {
    const rawMap = new Map(raw.map(x => [x.id, x]));
    const keys = new Set([...this.states.keys(), ...rawMap.keys()]);
    const transitions = [];

    for (const key of keys) {
      const rec = this.states.get(key) || { present: 0, absent: 0, active: false, item: null };
      const item = rawMap.get(key);
      if (item) {
        rec.present++;
        rec.absent = 0;
        rec.item = item;
        if (!rec.active && rec.present >= this.failures) {
          rec.active = true;
          transitions.push({ type: 'started', item });
        }
      } else {
        rec.absent++;
        rec.present = 0;
        if (rec.active && rec.absent >= this.recoveries) {
          rec.active = false;
          transitions.push({ type: 'cleared', item: rec.item });
        }
        if (!rec.active && rec.absent >= this.recoveries) {
          this.states.delete(key);
          continue;
        }
      }
      this.states.set(key, rec);
    }

    return {
      active: [...this.states.values()].filter(x => x.active).map(x => x.item),
      transitions,
    };
  }
}
