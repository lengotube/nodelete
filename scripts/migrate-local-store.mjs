// One-time move of the VPS store from the JSON snapshot + journal to SQLite.
// Run with the bot stopped:  node --max-old-space-size=6144 scripts/migrate-local-store.mjs [store.json] [store.sqlite3]
// The bot would do the same import on its first start; running it separately keeps that start fast
// and shows the counts. The legacy files are only read.
import { existsSync } from "node:fs";
import { SqliteStore, sqlitePathFor } from "../src/sqlite-store.mjs";

const legacy = process.argv[2] || process.env.LOCAL_DATA_FILE;
if (!legacy) throw new Error("Pass the legacy store.json path or set LOCAL_DATA_FILE");
const target = process.argv[3] || sqlitePathFor(legacy);
if (existsSync(target)) {
  console.log(`Already migrated: ${target}`);
  process.exit(0);
}
const started = Date.now();
const store = new SqliteStore(target, { legacyFile: legacy }).open();
const created = JSON.parse(store.db.prepare("SELECT value FROM kv_meta WHERE key = 'created'").get().value);
store.close();
console.log(JSON.stringify({ target, seconds: Math.round((Date.now() - started) / 1000), ...created.imported,
  heapMb: Math.round(process.memoryUsage().rss / 1048576) }));
