import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const HOUR = 3600000, DAY = 24 * HOUR, NOW = Date.UTC(2026, 10, 4, 12);

function accessLine() {
  class Clock extends Date { constructor(...a) { a.length ? super(...a) : super(NOW); } static now() { return NOW; } }
  const element = { innerHTML: "", classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, querySelector() { return { textContent: "" }; } };
  const context = {
    window: {}, document: { querySelector() { return element; }, querySelectorAll() { return []; }, documentElement: {}, body: element },
    location: { search: "", href: "https://example.test/" }, history: { replaceState() {} }, localStorage: { getItem() { return null; }, setItem() {} },
    URL, URLSearchParams, Date: Clock, AbortController, setTimeout() { return 1; }, clearTimeout() {}, scrollTo() {}, alert() {}, navigator: {}, fetch: async () => ({ ok: false })
  };
  runInNewContext(`${readFileSync(new URL("../public/app.js", import.meta.url), "utf8")}\nglobalThis.accessLine=accessLine;`, context);
  return context.accessLine;
}

test("the Mini App line shows what is left", () => {
  const line = accessLine();
  const trial = (endsAt) => ({ access: "trial", trial: { status: "active", endsAt } });
  const paid = (title, expiresAt) => ({ access: "paid", subscription: { title, expiresAt } });
  assert.equal(line(trial(null), false), "Триал: 3 дня начнутся с первого события");
  assert.equal(line(trial(NOW + 2 * DAY + 5 * HOUR), false), "Триал: осталось 2 дня 5 часов");
  assert.equal(line(trial(NOW + DAY), false), "Триал: осталось 1 день");
  assert.equal(line(trial(NOW + 3 * HOUR), false), "Триал: осталось 3 часа");
  assert.equal(line(trial(NOW + 60000), false), "Триал: осталось меньше часа");
  assert.equal(line(trial(NOW + 2 * DAY), true), "Trial: 2 days left");
  assert.equal(line(paid("Lite", NOW + 5 * DAY + 3 * HOUR), false), "Lite: осталось 5 дней, до 9 ноября");
  assert.equal(line(paid("Ultra", null), false), "Ultra: навсегда");
  assert.equal(line(paid(null, NOW + 30 * DAY), false), "Тариф: осталось 30 дней, до 4 декабря");
  assert.equal(line({ access: "locked", trial: { status: "ended" } }, false), "");
});

test("the dashboard sends trial and plan end dates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ghost-access-test-"));
  const previous = { ...process.env }, oldFetch = globalThis.fetch;
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.ARCHIVE_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.LOCAL_DATA_FILE = join(directory, "store.json");
  delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
  globalThis.fetch = async () => ({ json: async () => ({ ok: true, result: { message_id: 1 } }) });
  const { processUpdate, getDashboard, flushStoreSync } = await import("../api/telegram.js");
  try {
    const id = 90199;
    await processUpdate({ business_connection: { id: "access-test", user: { id }, user_chat_id: id, is_enabled: true, date: Math.floor(Date.now() / 1000) } });
    let data = await getDashboard(id);
    assert.equal(data.access, "trial");
    assert.equal(data.trial.endsAt, null);
    assert.equal(data.subscription, null);
    const before = Date.now();
    await processUpdate({ message: { message_id: 1, date: Math.floor(before / 1000), chat: { id, type: "private" }, from: { id, first_name: "U" }, successful_payment: { currency: "XTR", total_amount: 179, invoice_payload: "ghost-plan:plus:179", telegram_payment_charge_id: "access-test-charge" } } });
    data = await getDashboard(id);
    assert.equal(data.access, "paid");
    assert.equal(data.subscription.title, "Plus");
    assert.ok(Math.abs(data.subscription.expiresAt - before - 30 * DAY) < 60000);
  } finally {
    flushStoreSync();
    globalThis.fetch = oldFetch;
    for (const name of ["TELEGRAM_BOT_TOKEN", "ARCHIVE_ENCRYPTION_KEY", "LOCAL_DATA_FILE", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
