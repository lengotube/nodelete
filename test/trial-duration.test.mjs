import assert from "node:assert/strict";
import { createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("the three free days start at the first caught event, not at connection", async () => {
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
    const readTrial = () => {
      flushStoreSync();
      const data = JSON.parse(readFileSync(process.env.LOCAL_DATA_FILE, "utf8"));
      const [iv, tag, encrypted] = data.strings["trial:90099"].value.split(".").map((value) => Buffer.from(value, "base64url"));
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString());
    };
    await processUpdate({ business_connection: { id: "trial-test", user: { id: 90099 }, user_chat_id: 90099, is_enabled: true, date: Math.floor(before / 1000) } });
    const waiting = readTrial();
    assert.ok(waiting.startedAt >= before);
    assert.equal(waiting.endsAt, null);
    assert.equal(waiting.countdownAt, null);
    assert.ok(calls.some((payload) => payload.text?.includes("Отсчёт начнётся с первого события")));
    const chat = { id: 555, type: "private", first_name: "Friend" };
    await processUpdate({ business_message: { message_id: 7, business_connection_id: "trial-test", chat, from: { id: 555, first_name: "Friend" }, text: "hello", date: Math.floor(Date.now() / 1000) } });
    assert.equal(readTrial().endsAt, null, "an ordinary message does not start the countdown");
    const eventAt = Date.now();
    await processUpdate({ deleted_business_messages: { business_connection_id: "trial-test", chat, message_ids: [7] } });
    const counting = readTrial();
    assert.ok(counting.countdownAt >= eventAt);
    assert.equal(counting.endsAt - counting.countdownAt, 3 * 24 * 60 * 60 * 1000);
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
