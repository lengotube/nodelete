import assert from "node:assert/strict";
import { createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("a new business connection starts three free days immediately", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ghost-trial-test-"));
  const previous = { ...process.env };
  const oldFetch = globalThis.fetch;
  const key = randomBytes(32);
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.ARCHIVE_ENCRYPTION_KEY = key.toString("base64");
  process.env.LOCAL_DATA_FILE = join(directory, "store.json");
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  const calls = [];
  globalThis.fetch = async (url, request) => {
    assert.ok(String(url).startsWith("https://api.telegram.org/bottest-token/"));
    calls.push(JSON.parse(request.body));
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  const { processUpdate, flushStoreSync } = await import("../api/telegram.js");
  try {
    const before = Date.now();
    await processUpdate({ business_connection: { id: "trial-test", user: { id: 90099 }, user_chat_id: 90099, is_enabled: true, date: Math.floor(before / 1000) } });
    flushStoreSync();
    const data = JSON.parse(readFileSync(process.env.LOCAL_DATA_FILE, "utf8"));
    const [iv, tag, encrypted] = data.strings["trial:90099"].value.split(".").map((value) => Buffer.from(value, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const trial = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString());
    assert.ok(trial.startedAt >= before);
    assert.equal(trial.countdownAt, trial.startedAt);
    assert.equal(trial.endsAt - trial.startedAt, 3 * 24 * 60 * 60 * 1000);
    assert.ok(calls.some((payload) => payload.text?.includes("Отсчёт начался с подключения")));
  } finally {
    flushStoreSync();
    globalThis.fetch = oldFetch;
    for (const name of ["TELEGRAM_BOT_TOKEN", "ARCHIVE_ENCRYPTION_KEY", "LOCAL_DATA_FILE", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
