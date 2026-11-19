// Local KV store for the VPS on SQLite: every command is committed to disk as it runs, memory use
// does not grow with the data, and start-up does not read the whole store.
//
// Semantics are identical to the earlier in-memory store (api/telegram.js before 2026-11 and
// src/local-journal-store.mjs): strings and sets are separate namespaces, values and set members keep
// their JS type, sets keep insertion order, an expired record disappears on access, DEL counts 2 per key.
//
// First open: when the database does not exist yet but the legacy JSON snapshot (and its
// `.journal`) does, everything is imported in one transaction before the store is used, so the
// bot never starts with empty data. The legacy files are left untouched as a frozen backup.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const WRITES = new Set(["SET", "DEL", "SADD", "SREM", "EXPIRE"]);
const SWEEP_MS = 10 * 60 * 1000;
const JOURNAL_META = "__local_journal_v1";

const enc = (value) => JSON.stringify(value === undefined ? null : value);
const dec = (text) => JSON.parse(text);

export function sqlitePathFor(jsonFile) {
  return process.env.LOCAL_SQLITE_FILE || `${String(jsonFile).replace(/\.json$/i, "")}.sqlite3`;
}

export class SqliteStore {
  constructor(file, { legacyFile = null, io = fs } = {}) {
    this.file = file;
    this.legacyFile = legacyFile;
    this.io = io;
    this.db = null;
    this.sweepTimer = null;
  }

  open() {
    if (this.db) return this;
    const Database = require("better-sqlite3");
    this.io.mkdirSync(dirname(this.file), { recursive: true });
    const fresh = !this.io.existsSync(this.file);
    const temporary = `${this.file}.importing`;
    // A brand-new database is built under a temporary name and renamed only when complete,
    // so an interrupted first import is simply redone on the next start.
    const path = fresh ? temporary : this.file;
    if (fresh) for (const suffix of ["", "-wal", "-shm", "-journal"]) this.io.rmSync(`${temporary}${suffix}`, { force: true });
    let db = new Database(path);
    // Owner-only, like the JSON store; SQLite gives the -wal/-shm files the same mode.
    this.io.chmodSync(path, 0o600);
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = FULL"); // a committed command survives a power cut
      db.pragma("busy_timeout = 5000");
      db.exec(`
        CREATE TABLE IF NOT EXISTS kv_strings (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS kv_sets (key TEXT PRIMARY KEY, expires_at INTEGER) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS kv_members (id INTEGER PRIMARY KEY, key TEXT NOT NULL, member TEXT NOT NULL, UNIQUE (key, member));
        CREATE INDEX IF NOT EXISTS kv_strings_exp ON kv_strings (expires_at) WHERE expires_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS kv_sets_exp ON kv_sets (expires_at) WHERE expires_at IS NOT NULL;
        CREATE TABLE IF NOT EXISTS kv_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      `);
      if (fresh) {
        const imported = this.importLegacy(db);
        db.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('created', ?)")
          .run(JSON.stringify({ at: new Date().toISOString(), imported }));
        db.pragma("wal_checkpoint(TRUNCATE)");
        db.close();
        this.io.renameSync(temporary, this.file);
        db = new Database(this.file);
        db.pragma("journal_mode = WAL");
        db.pragma("synchronous = FULL");
        db.pragma("busy_timeout = 5000");
      }
    } catch (error) {
      try { db.close(); } catch { /* already closed */ }
      throw error;
    }
    this.db = db;
    this.prepare();
    this.sweep();
    this.sweepTimer = setInterval(() => { try { this.sweep(); } catch (error) { console.error("Store sweep failed", error.message); } }, SWEEP_MS);
    this.sweepTimer.unref?.();
    return this;
  }

  prepare() {
    const db = this.db;
    this.q = {
      getString: db.prepare("SELECT value, expires_at FROM kv_strings WHERE key = ?"),
      setString: db.prepare("INSERT OR REPLACE INTO kv_strings (key, value, expires_at) VALUES (?, ?, ?)"),
      delString: db.prepare("DELETE FROM kv_strings WHERE key = ?"),
      expireString: db.prepare("UPDATE kv_strings SET expires_at = ? WHERE key = ?"),
      getSet: db.prepare("SELECT expires_at FROM kv_sets WHERE key = ?"),
      putSet: db.prepare("INSERT OR REPLACE INTO kv_sets (key, expires_at) VALUES (?, ?)"),
      delSet: db.prepare("DELETE FROM kv_sets WHERE key = ?"),
      expireSet: db.prepare("UPDATE kv_sets SET expires_at = ? WHERE key = ?"),
      members: db.prepare("SELECT member FROM kv_members WHERE key = ? ORDER BY id"),
      countMembers: db.prepare("SELECT count(*) AS n FROM kv_members WHERE key = ?"),
      addMember: db.prepare("INSERT OR IGNORE INTO kv_members (key, member) VALUES (?, ?)"),
      delMember: db.prepare("DELETE FROM kv_members WHERE key = ? AND member = ?"),
      delMembers: db.prepare("DELETE FROM kv_members WHERE key = ?"),
    };
    this.tx = (fn) => db.transaction(fn)();
  }

  // --- records with lazy expiry, as before ---------------------------------------------------

  liveString(key, now) {
    const row = this.q.getString.get(key);
    if (!row) return undefined;
    if (row.expires_at && row.expires_at < now) { this.q.delString.run(key); return undefined; }
    return { value: dec(row.value), expiresAt: row.expires_at ?? null };
  }

  liveSet(key, now) {
    const row = this.q.getSet.get(key);
    if (!row) return undefined;
    if (row.expires_at && row.expires_at < now) { this.tx(() => { this.q.delSet.run(key); this.q.delMembers.run(key); }); return undefined; }
    return { expiresAt: row.expires_at ?? null };
  }

  command(command, now = Date.now()) {
    if (!this.db) this.open();
    const [verb, ...args] = command;
    if (verb === "GET") return this.liveString(args[0], now)?.value || null;
    if (verb === "SMEMBERS") return this.liveSet(args[0], now) ? this.q.members.all(args[0]).map((r) => dec(r.member)) : [];
    if (!WRITES.has(verb)) throw new Error(`Unsupported local storage command: ${verb}`);
    return this.tx(() => {
      if (verb === "SET") {
        const [key, value, , seconds] = args;
        this.q.setString.run(key, enc(value), Number(seconds) ? now + Number(seconds) * 1000 : null);
        return "OK";
      }
      if (verb === "DEL") {
        for (const key of args) { this.q.delString.run(key); this.q.delSet.run(key); this.q.delMembers.run(key); }
        return args.length * 2; // the in-memory store counted `delete` on both namespaces
      }
      if (verb === "SADD") {
        const [key, ...values] = args;
        const previous = this.liveSet(key, now);
        this.q.putSet.run(key, previous?.expiresAt || null);
        for (const value of values) this.q.addMember.run(key, enc(value));
        return this.q.countMembers.get(key).n;
      }
      if (verb === "SREM") {
        const [key, ...values] = args;
        if (!this.liveSet(key, now)) return 0;
        let removed = 0;
        for (const value of values) removed += this.q.delMember.run(key, enc(value)).changes;
        return removed;
      }
      // EXPIRE
      const [key, seconds] = args;
      const at = now + Number(seconds) * 1000;
      if (this.liveString(key, now)) { this.q.expireString.run(at, key); return 1; }
      if (this.liveSet(key, now)) { this.q.expireSet.run(at, key); return 1; }
      return 0;
    });
  }

  // Several commands that must land together (card payments). Reads inside see the batch so far.
  transaction(fn) {
    if (!this.db) this.open();
    return this.tx(fn);
  }

  sweep(now = Date.now()) {
    this.tx(() => {
      this.db.prepare("DELETE FROM kv_strings WHERE expires_at IS NOT NULL AND expires_at < ?").run(now);
      this.db.prepare("DELETE FROM kv_members WHERE key IN (SELECT key FROM kv_sets WHERE expires_at IS NOT NULL AND expires_at < ?)").run(now);
      this.db.prepare("DELETE FROM kv_sets WHERE expires_at IS NOT NULL AND expires_at < ?").run(now);
    });
  }

  close() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    if (!this.db) return;
    try { this.db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* best effort */ }
    this.db.close();
    this.db = null;
  }

  // --- one-time import of the legacy JSON snapshot + journal ------------------------------------

  importLegacy(db) {
    const legacy = this.legacyFile;
    if (!legacy || !this.io.existsSync(legacy)) {
      if (legacy && this.io.existsSync(`${legacy}.journal`)) throw new Error("Legacy journal exists without its snapshot; refusing to start empty");
      return { strings: 0, sets: 0, members: 0, journalBatches: 0 };
    }
    const store = readLegacy(legacy, this.io);
    const now = Date.now();
    const putString = db.prepare("INSERT INTO kv_strings (key, value, expires_at) VALUES (?, ?, ?)");
    const putSet = db.prepare("INSERT INTO kv_sets (key, expires_at) VALUES (?, ?)");
    const addMember = db.prepare("INSERT OR IGNORE INTO kv_members (key, member) VALUES (?, ?)");
    const counts = { strings: 0, sets: 0, members: 0, journalBatches: store.journalBatches };
    db.transaction(() => {
      for (const [key, record] of Object.entries(store.strings)) {
        if (!record || (record.expiresAt && record.expiresAt < now)) continue;
        putString.run(key, enc(record.value), record.expiresAt || null);
        counts.strings++;
      }
      for (const [key, record] of Object.entries(store.sets)) {
        if (!record || (record.expiresAt && record.expiresAt < now)) continue;
        putSet.run(key, record.expiresAt || null);
        counts.sets++;
        for (const member of record.members || []) counts.members += addMember.run(key, enc(member)).changes;
      }
    })();
    return counts;
  }
}

// Whole database as the legacy { strings, sets } shape (tests and diagnostics; not for the live bot).
export function readSnapshot(file) {
  const Database = require("better-sqlite3");
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const strings = {}, sets = {};
    for (const r of db.prepare("SELECT key, value, expires_at FROM kv_strings").iterate()) {
      strings[r.key] = { value: dec(r.value), expiresAt: r.expires_at ?? null };
    }
    for (const r of db.prepare("SELECT key, expires_at FROM kv_sets").iterate()) sets[r.key] = { members: [], expiresAt: r.expires_at ?? null };
    for (const r of db.prepare("SELECT key, member FROM kv_members ORDER BY id").iterate()) sets[r.key]?.members.push(dec(r.member));
    return { strings, sets };
  } finally { db.close(); }
}

// --- legacy reader: JSON snapshot, then the checksummed journal batches after its sequence ----------

function apply(store, command, now) {
  const [verb, ...args] = command;
  const live = (records, key) => {
    const value = records[key];
    if (value?.expiresAt && value.expiresAt < now) { delete records[key]; return undefined; }
    return value;
  };
  if (verb === "SET") {
    const [key, value, , seconds] = args;
    store.strings[key] = { value, expiresAt: Number(seconds) ? now + Number(seconds) * 1000 : null };
  } else if (verb === "DEL") {
    for (const key of args) { delete store.strings[key]; delete store.sets[key]; }
  } else if (verb === "SADD") {
    const [key, ...values] = args;
    const previous = live(store.sets, key);
    const members = new Set(previous?.members || []);
    values.forEach((value) => members.add(value));
    store.sets[key] = { members: [...members], expiresAt: previous?.expiresAt || null };
  } else if (verb === "SREM") {
    const [key, ...values] = args;
    const record = live(store.sets, key);
    if (record) { const members = new Set(record.members); values.forEach((value) => members.delete(value)); record.members = [...members]; }
  } else if (verb === "EXPIRE") {
    const [key, seconds] = args;
    const record = live(store.strings, key) || live(store.sets, key);
    if (record) record.expiresAt = now + Number(seconds) * 1000;
  } else {
    throw new Error(`Invalid journal operation: ${verb}`);
  }
}

export function readLegacy(file, io = fs) {
  const store = JSON.parse(io.readFileSync(file, "utf8"));
  if (!store || typeof store !== "object" || Array.isArray(store)) throw new Error("Invalid local store snapshot");
  store.strings ||= {};
  store.sets ||= {};
  const checkpoint = store[JOURNAL_META]?.seq ?? 0;
  delete store[JOURNAL_META];
  let seq = checkpoint;
  let batches = 0;
  const journal = `${file}.journal`;
  if (io.existsSync(journal)) {
    // Read line by line from a buffer: the journal may be larger than one JS string can hold.
    const buffer = io.readFileSync(journal);
    let start = 0;
    while (start < buffer.length) {
      const end = buffer.indexOf(10, start);
      if (end === -1) break; // torn last line from a crash: never committed
      const line = buffer.toString("utf8", start, end);
      start = end + 1;
      let record;
      try { record = JSON.parse(line); } catch { break; } // torn line
      if (typeof record.body !== "string" || createHash("sha256").update(record.body).digest("hex") !== record.sha256) {
        throw new Error("Local store journal checksum mismatch");
      }
      const batch = JSON.parse(record.body);
      if (batch.v !== 1 || !Number.isSafeInteger(batch.seq) || !Array.isArray(batch.ops)) throw new Error("Invalid journal batch");
      if (batch.seq <= checkpoint) continue;
      if (batch.seq !== seq + 1) throw new Error("Local store journal sequence gap");
      for (const op of batch.ops) apply(store, op.command, op.at);
      seq = batch.seq;
      batches++;
    }
  }
  store.journalBatches = batches;
  return store;
}
