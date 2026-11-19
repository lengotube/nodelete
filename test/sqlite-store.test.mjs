import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SqliteStore, readSnapshot } from "../src/sqlite-store.mjs";

const directory = mkdtempSync(join(tmpdir(), "ghost-sqlite-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
let n = 0;
const fresh = (legacyFile = null) => new SqliteStore(join(directory, `s${++n}.sqlite3`), { legacyFile }).open();

// Reference: the in-memory store the bot used before (src/local-journal-store.mjs `apply`).
function reference(store, command, now) {
  const [verb, ...args] = command;
  const live = (records, key) => {
    const value = records[key];
    if (value?.expiresAt && value.expiresAt < now) { delete records[key]; return undefined; }
    return value;
  };
  if (verb === "GET") return live(store.strings, args[0])?.value || null;
  if (verb === "SMEMBERS") return [...(live(store.sets, args[0])?.members || [])];
  if (verb === "SET") {
    const [key, value, , seconds] = args;
    store.strings[key] = { value, expiresAt: Number(seconds) ? now + Number(seconds) * 1000 : null };
    return "OK";
  }
  if (verb === "DEL") { let removed = 0; for (const key of args) { if (delete store.strings[key]) removed++; if (delete store.sets[key]) removed++; } return removed; }
  if (verb === "SADD") {
    const [key, ...values] = args;
    const previous = live(store.sets, key);
    const members = new Set(previous?.members || []);
    values.forEach((value) => members.add(value));
    store.sets[key] = { members: [...members], expiresAt: previous?.expiresAt || null };
    return members.size;
  }
  if (verb === "SREM") {
    const [key, ...values] = args;
    const record = live(store.sets, key);
    if (!record) return 0;
    const members = new Set(record.members);
    let removed = 0;
    values.forEach((value) => { if (members.delete(value)) removed++; });
    record.members = [...members];
    return removed;
  }
  if (verb === "EXPIRE") {
    const [key, seconds] = args;
    const record = live(store.strings, key) || live(store.sets, key);
    if (record) record.expiresAt = now + Number(seconds) * 1000;
    return record ? 1 : 0;
  }
  throw new Error(verb);
}

test("every command behaves exactly like the old in-memory store (random sequences)", () => {
  let seed = 12345;
  const rnd = (k) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
  const keys = ["a", "b", "c", "owner:1:keys", "set:x"];
  const values = ["1", "2", 3, "three", "", "x".repeat(50)];
  for (let round = 0; round < 30; round++) {
    const db = fresh(), mem = { strings: {}, sets: {} };
    let now = 1_800_000_000_000;
    for (let i = 0; i < 400; i++) {
      now += rnd(4) * 700; // time moves, so TTLs of 1–3 s expire along the way
      const key = keys[rnd(keys.length)], value = values[rnd(values.length)];
      const pick = rnd(9);
      const command = pick === 0 ? ["GET", key]
        : pick === 1 ? ["SET", key, value]
        : pick === 2 ? ["SET", key, value, "EX", 1 + rnd(3)]
        : pick === 3 ? ["DEL", key, keys[rnd(keys.length)]]
        : pick === 4 ? ["SADD", key, value, values[rnd(values.length)]]
        : pick === 5 ? ["SREM", key, value]
        : pick === 6 ? ["SMEMBERS", key]
        : pick === 7 ? ["EXPIRE", key, 1 + rnd(3)]
        : ["GET", key];
      assert.deepEqual(db.command(command, now), reference(mem, command, now), `round ${round} step ${i}: ${JSON.stringify(command)}`);
    }
    db.close();
  }
});

test("data survives reopening; a batch in a transaction is all-or-nothing", () => {
  const file = join(directory, "reopen.sqlite3");
  let db = new SqliteStore(file).open();
  db.command(["SET", "k", "v", "EX", 3600]);
  db.command(["SADD", "s", "b", "a", "b"]);
  assert.throws(() => db.transaction(() => {
    db.command(["SET", "pay", "x"]);
    db.command(["SADD", "payments:ids", "cp:1"]);
    throw new Error("crash in the middle");
  }));
  db.close();
  db = new SqliteStore(file).open();
  assert.equal(db.command(["GET", "k"]), "v");
  assert.deepEqual(db.command(["SMEMBERS", "s"]), ["b", "a"]);
  assert.equal(db.command(["GET", "pay"]), null);
  assert.deepEqual(db.command(["SMEMBERS", "payments:ids"]), []);
  db.close();
});

test("first start imports the legacy JSON snapshot and its journal, keeping types and order", () => {
  const legacy = join(directory, "legacy.json");
  const now = Date.now();
  writeFileSync(legacy, JSON.stringify({
    strings: { keep: { value: "sealed", expiresAt: null }, gone: { value: "old", expiresAt: now - 1000 }, ttl: { value: "t", expiresAt: now + 60000 } },
    sets: { ids: { members: ["b", "a", 7], expiresAt: null } },
    __local_journal_v1: { v: 1, seq: 2 }
  }));
  const line = (seq, ops) => { const body = JSON.stringify({ v: 1, seq, ops }); return JSON.stringify({ body, sha256: createHash("sha256").update(body).digest("hex") }) + "\n"; };
  writeFileSync(`${legacy}.journal`,
    line(2, [{ at: now, command: ["SET", "skipped", "already in snapshot"] }]) +
    line(3, [{ at: now, command: ["SADD", "ids", "c"] }, { at: now, command: ["SET", "new", "n"] }]) +
    line(4, [{ at: now, command: ["DEL", "keep"] }]) +
    '{"body":"torn');
  const db = fresh(legacy);
  assert.equal(db.command(["GET", "keep"]), null);
  assert.equal(db.command(["GET", "new"]), "n");
  assert.equal(db.command(["GET", "skipped"]), null);
  assert.equal(db.command(["GET", "gone"]), null);
  assert.equal(db.command(["GET", "ttl"]), "t");
  assert.deepEqual(db.command(["SMEMBERS", "ids"]), ["b", "a", 7, "c"]);
  const file = db.file;
  db.close();
  assert.equal(existsSync(`${file}.importing`), false);
  assert.equal(statSync(file).mode & 0o777, 0o600, "the database must be readable by its owner only");
  assert.deepEqual(Object.keys(readSnapshot(file).strings).sort(), ["new", "ttl"]);
});

test("refuses to start empty when a legacy journal exists without its snapshot", () => {
  const legacy = join(directory, "only-journal.json");
  writeFileSync(`${legacy}.journal`, "");
  assert.throws(() => fresh(legacy), /refusing to start empty/);
});

test("a corrupted journal stops the import instead of starting with partial data", () => {
  const legacy = join(directory, "corrupt.json");
  writeFileSync(legacy, JSON.stringify({ strings: {}, sets: {} }));
  writeFileSync(`${legacy}.journal`, JSON.stringify({ body: JSON.stringify({ v: 1, seq: 1, ops: [] }), sha256: "bad" }) + "\n");
  const store = new SqliteStore(join(directory, "corrupt.sqlite3"), { legacyFile: legacy });
  assert.throws(() => store.open(), /checksum/);
  assert.equal(existsSync(join(directory, "corrupt.sqlite3")), false);
});
