import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export type DB = Database.Database;

// Starting point; you'll likely add columns as you go.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS roots (
  path TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS samples (
  id        INTEGER PRIMARY KEY,
  path      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  mtime_ms  INTEGER NOT NULL,
  bpm       REAL,
  camelot   TEXT,
  kind      TEXT,
  embedding BLOB            -- float32[], read with sqlite-vec functions
);
`;

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  sqliteVec.load(db); // enables vec_distance_cosine(), vec0 tables, etc.
  db.exec(SCHEMA);
  return db;
}

/** Float32Array <-> BLOB helpers for the embedding column. */
export const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
export const fromBlob = (b: Buffer) => new Float32Array(new Uint8Array(b).buffer);
