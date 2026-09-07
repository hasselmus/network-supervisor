import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class Storage {
  constructor(dataDir) {
    this.path = path.join(dataDir, 'network-supervisor.sqlite');
    this.db = new DatabaseSync(this.path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        ts_ms INTEGER NOT NULL,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        event_key TEXT,
        message TEXT NOT NULL,
        detail_json TEXT
      );
      CREATE INDEX IF NOT EXISTS events_ts ON events(ts_ms DESC);
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY,
        ts_ms INTEGER NOT NULL,
        text TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cellular_samples (
        id INTEGER PRIMARY KEY,
        ts_ms INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        registered INTEGER,
        network_type TEXT,
        isp TEXT,
        rsrp_dbm REAL,
        rsrq_db REAL,
        snr_db REAL,
        rx_bps INTEGER,
        tx_bps INTEGER,
        band TEXT,
        earfcn TEXT,
        pci TEXT,
        cell_id TEXT,
        detail_json TEXT
      );
      CREATE INDEX IF NOT EXISTS cellular_samples_ts ON cellular_samples(ts_ms DESC);
    `);
    this.insertEvent = this.db.prepare('INSERT INTO events(ts_ms,kind,severity,event_key,message,detail_json) VALUES(?,?,?,?,?,?)');
    this.insertObservation = this.db.prepare('INSERT INTO observations(ts_ms,text) VALUES(?,?)');
    this.insertCellular = this.db.prepare(`INSERT INTO cellular_samples(
      ts_ms,ok,registered,network_type,isp,rsrp_dbm,rsrq_db,snr_db,rx_bps,tx_bps,band,earfcn,pci,cell_id,detail_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    this.deleteOldCellular = this.db.prepare('DELETE FROM cellular_samples WHERE ts_ms < ?');
  }

  event(kind, severity, key, message, detail = null) {
    this.insertEvent.run(Date.now(), kind, severity, key || null, message, detail ? JSON.stringify(detail) : null);
  }

  observation(text) {
    const clean = String(text || '').trim().slice(0, 4000);
    if (!clean) return;
    this.insertObservation.run(Date.now(), clean);
    this.event('human', 'info', null, clean);
  }

  cellularSample(cellular) {
    if (!cellular?.configured) return;
    const t = cellular.telemetry || {};
    const ts = Number(cellular.sampledAtMs || Date.now());
    this.insertCellular.run(
      ts,
      cellular.ok ? 1 : 0,
      cellular.ok ? (t.registered ? 1 : 0) : null,
      t.networkTypeInfo ?? null,
      t.isp ?? null,
      t.rsrpDbm ?? null,
      t.rsrqDb ?? null,
      t.snrDb ?? null,
      t.rxBytesPerSecond ?? null,
      t.txBytesPerSecond ?? null,
      t.band ?? null,
      t.earfcn ?? null,
      t.pci ?? null,
      t.cellId ?? null,
      JSON.stringify(cellular),
    );
    // Seven days at a 30-second cadence is only ~20k rows; pruning keeps it bounded.
    this.deleteOldCellular.run(ts - 7 * 24 * 60 * 60 * 1000);
  }

  recentEvents(limit = 100) {
    return this.db.prepare('SELECT ts_ms,kind,severity,event_key,message,detail_json FROM events ORDER BY id DESC LIMIT ?').all(limit)
      .map(r => ({ ...r, ts_ms: Number(r.ts_ms), detail: r.detail_json ? JSON.parse(r.detail_json) : null, detail_json: undefined }));
  }

  recentObservations(limit = 10) {
    return this.db.prepare('SELECT ts_ms,text FROM observations ORDER BY id DESC LIMIT ?').all(limit)
      .map(r => ({ ...r, ts_ms: Number(r.ts_ms) }));
  }

  recentCellularSamples(limit = 60) {
    return this.db.prepare(`SELECT ts_ms,ok,registered,network_type,isp,rsrp_dbm,rsrq_db,snr_db,rx_bps,tx_bps,band,earfcn,pci,cell_id
      FROM cellular_samples ORDER BY id DESC LIMIT ?`).all(limit).map(r => ({
        ...r,
        ts_ms: Number(r.ts_ms),
        ok: Boolean(r.ok),
        registered: r.registered == null ? null : Boolean(r.registered),
      }));
  }
}
