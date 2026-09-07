import test from 'node:test';
import assert from 'node:assert/strict';
import { assessMR600, summariseCellularSamples } from '../src/mr600.mjs';
import { diagnose } from '../src/diagnose.mjs';

const spec = { enabled: true, host: '10.0.0.1', weakRsrpDbm: -110, poorRsrqDb: -16, poorSnrDb: 2, wanLatencyWarnMs: 250 };

function cellular(overrides = {}) {
  return {
    configured: true,
    ok: true,
    telemetry: {
      registered: true,
      networkTypeInfo: '4G LTE',
      rsrpDbm: -88,
      rsrqDb: -12,
      snrDb: 13.4,
      rxBytesPerSecond: 1000,
      txBytesPerSecond: 1000,
      ...overrides,
    },
  };
}

function baseObs(cell = cellular(), internet = [{ target: '1.1.1.1', ok: true, ms: 40 }, { target: '8.8.8.8', ok: true, ms: 45 }]) {
  return {
    switches: {},
    cellular: cell,
    interfaces: {
      eth0: { configured: true, router: { ok: true }, internet, dns: { ok: true } },
    },
  };
}

const config = {
  links: [],
  switches: [],
  observer: { ethernetInterface: 'eth0' },
  cellularRouter: spec,
};

test('MR600 screenshot-like RF values are not classified as degraded', () => {
  assert.equal(assessMR600(cellular(), spec).state, 'ok');
});

test('weak RSRP is classified as degraded radio', () => {
  const a = assessMR600(cellular({ rsrpDbm: -115 }), spec);
  assert.equal(a.state, 'warning');
  assert.match(a.detail, /RSRP/);
});

test('registered LTE plus failed external targets localises failure beyond the LAN', () => {
  const obs = baseObs(cellular(), [{ target: '1.1.1.1', ok: false }, { target: '8.8.8.8', ok: false }]);
  const d = diagnose(config, obs);
  assert.ok(d.some(x => x.id === 'router:cellular-wan'));
  assert.ok(!d.some(x => x.id === 'router:wan'));
});

test('sustained high WAN latency with plausible RF and low local traffic is surfaced', () => {
  const obs = baseObs(cellular(), [{ target: '1.1.1.1', ok: true, ms: 310 }, { target: '8.8.8.8', ok: true, ms: 340 }]);
  const d = diagnose(config, obs);
  assert.ok(d.some(x => x.id === 'router:cellular-latency'));
});

test('cellular history summary reports radio range and observed cells', () => {
  const s = summariseCellularSamples([
    { ok: true, registered: true, rsrp_dbm: -90, rsrq_db: -12, snr_db: 12, band: '1', earfcn: '300', pci: '182', cell_id: 'A' },
    { ok: true, registered: true, rsrp_dbm: -88, rsrq_db: -11, snr_db: 14, band: '1', earfcn: '300', pci: '182', cell_id: 'A' },
  ]);
  assert.equal(s.samples, 2);
  assert.equal(s.rsrpDbm.median, -89);
  assert.deepEqual(s.observedCells, ['1/300/182/A']);
});
