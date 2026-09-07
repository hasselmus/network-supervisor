import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class Storage {
  constructor(dataDir) {
    this.path = path.join(dataDir, 'network-supervisor.sqlite');
    this.db = new DatabaseSync(this.path);
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY,ts_ms INTEGER NOT NULL,kind TEXT NOT NULL,severity TEXT NOT NULL,event_key TEXT,message TEXT NOT NULL,detail_json TEXT); CREATE INDEX IF NOT EXISTS events_ts ON events(ts_ms DESC); CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY,ts_ms INTEGER NOT NULL,text TEXT NOT NULL);`);
    this.insertEvent=this.db.prepare('INSERT INTO events(ts_ms,kind,severity,event_key,message,detail_json) VALUES(?,?,?,?,?,?)');
    this.insertObservation=this.db.prepare('INSERT INTO observations(ts_ms,text) VALUES(?,?)');
  }
  event(kind,severity,key,message,detail=null){this.insertEvent.run(Date.now(),kind,severity,key||null,message,detail?JSON.stringify(detail):null)}
  observation(text){const clean=String(text||'').trim().slice(0,4000);if(!clean)return;this.insertObservation.run(Date.now(),clean);this.event('human','info',null,clean)}
  recentEvents(limit=100){return this.db.prepare('SELECT ts_ms,kind,severity,event_key,message,detail_json FROM events ORDER BY id DESC LIMIT ?').all(limit).map(r=>({...r,ts_ms:Number(r.ts_ms),detail:r.detail_json?JSON.parse(r.detail_json):null,detail_json:undefined}))}
  recentObservations(limit=10){return this.db.prepare('SELECT ts_ms,text FROM observations ORDER BY id DESC LIMIT ?').all(limit).map(r=>({...r,ts_ms:Number(r.ts_ms)}))}
}
