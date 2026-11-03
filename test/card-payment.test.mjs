import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "ghost-card-test-"));
const key = randomBytes(32);
const oldFetch = globalThis.fetch;
const previous = { ...process.env };
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.ARCHIVE_ENCRYPTION_KEY = key.toString("base64");
process.env.LOCAL_DATA_FILE = join(directory, "store.json");
process.env.GHOST_CHECKOUT_INTERNAL_URL = "http://127.0.0.1:5555";
process.env.GHOST_CHECKOUT_PUBLIC_ORIGIN = "https://checkout.example.test";
process.env.GHOST_CHECKOUT_SECRET = "internal-test-secret";
process.env.GHOST_EVENT_SECRET = "event-test-secret";
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
const seal = (value) => {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map((part) => part.toString("base64url")).join(".");
};
const store = { strings: {}, sets: {} };
const seed = (name, value) => { store.strings[name] = { value: seal(value), expiresAt: null }; };
seed("subscription:901", { plan: "ultra", scope: "personal", expiresAt: null });
seed("subscription:902", { plan: "plus", scope: "personal", expiresAt: Date.now() + 3 * 86400000 });
seed("trial:903", { status: "ended", startedAt: Date.now() - 4 * 86400000, endsAt: Date.now() - 86400000 });
seed("trial:904", { status: "active", startedAt: Date.now(), endsAt: Date.now() + 3 * 86400000 });
seed("trial:906", { status: "active", startedAt: Date.now() - 4 * 86400000, endsAt: Date.now() - 1000 });
writeFileSync(process.env.LOCAL_DATA_FILE, JSON.stringify(store), { mode: 0o600 });

let calls = [], remoteStatus = "active", cancelConfirmed = true;
globalThis.fetch = async (url, options) => {
  const parsed = new URL(url), payload = JSON.parse(options.body);
  if (parsed.hostname === "api.telegram.org") {
    calls.push({ method: parsed.pathname.split("/").at(-1), payload });
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  }
  assert.equal(parsed.origin, process.env.GHOST_CHECKOUT_INTERNAL_URL);
  const timestamp = options.headers["X-Ghost-Timestamp"];
  const expected = createHmac("sha256", process.env.GHOST_CHECKOUT_SECRET).update(`${timestamp}.POST.${parsed.pathname}.${options.body}`).digest("hex");
  assert.equal(options.headers["X-Ghost-Signature"], expected);
  calls.push({ method: parsed.pathname, payload });
  let data = { ok: true };
  if (parsed.pathname.endsWith("/checkout")) data.url = "https://checkout.example.test/pay?order=test";
  else if (parsed.pathname.endsWith("/status")) data.offer_used = false, data.subscription = { status: remoteStatus, amount: 79, period_days: 7, next_at: new Date(Date.now() + 7 * 86400000).toISOString() };
  else if (parsed.pathname.endsWith("/cancel")) data = cancelConfirmed ? { ok: true, status: "cancelled" } : { ok: false };
  return { ok: data.ok, json: async () => data };
};
const { processCardPaymentEvent, processUpdate, flushStoreSync } = await import("../api/telegram.js");
const { startDashboardApi } = await import("../src/dashboard-api.js");
const read = (name) => {
  flushStoreSync();
  const value = JSON.parse(readFileSync(process.env.LOCAL_DATA_FILE, "utf8")).strings[name]?.value;
  if (!value) return null;
  const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString());
};
const signed = (payload, { path = "/api/card-payment-event", secret = process.env.GHOST_EVENT_SECRET, timestamp = String(Math.floor(Date.now() / 1000)) } = {}) => {
  const raw = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(`${timestamp}.POST.${path}.${raw}`).digest("hex");
  return [{ "x-ghost-timestamp": timestamp, "x-ghost-signature": signature }, raw];
};
const event = (overrides = {}) => ({ event_id: "cp:123", user_id: 900, kind: "initial", amount: 10, currency: "RUB", period_days: 7, paid_at: new Date().toISOString(), invoice_id: "invoice-1", ...overrides });

test("signed card payments credit seven days exactly once, including concurrent retries", async () => {
  const payload = event(), before = Date.now(), args = signed(payload);
  const results = await Promise.all(Array.from({ length: 4 }, () => processCardPaymentEvent(...args)));
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  const subscription = read("subscription:900");
  assert.ok(subscription.expiresAt >= before + 7 * 86400000 && subscription.expiresAt < before + 7 * 86400000 + 3000);
  assert.equal(read("payment:cp:123").amount, 10);
  assert.equal(readFileSync(process.env.LOCAL_DATA_FILE, "utf8").includes("invoice-1"), false);
  const renewal = event({ event_id: "cp:124", kind: "renewal", amount: 79, invoice_id: "invoice-2" });
  await processCardPaymentEvent(...signed(renewal));
  assert.equal(read("subscription:900").expiresAt, subscription.expiresAt + 7 * 86400000);
});

test("invalid signatures, old timestamps, replay across endpoints, amounts and conflicting IDs fail closed", async () => {
  await assert.rejects(processCardPaymentEvent(...signed(event({ event_id: "cp:200" }), { secret: "wrong" })));
  await assert.rejects(processCardPaymentEvent(...signed(event({ event_id: "cp:201" }), { timestamp: String(Math.floor(Date.now() / 1000) - 301) })));
  await assert.rejects(processCardPaymentEvent(...signed(event({ event_id: "cp:202" }), { path: "/internal/ghost/cancel" })));
  await assert.rejects(processCardPaymentEvent(...signed(event({ event_id: "cp:203", amount: 79 }))));
  await assert.rejects(processCardPaymentEvent(...signed(event({ event_id: "cp:123", user_id: 905 }))));
  assert.equal(read("payment:cp:203"), null);
});

test("card plans grant their authenticated calendar duration and reject mismatched prices", async () => {
  for (const [index, plan, amount, months] of [[1, 'plus', 179, 1], [2, 'quarter', 449, 3], [3, 'prime', 1290, 12]]) {
    const p = event({ event_id: `cp:7${index}`, user_id: 910 + index, plan, amount, period_days: 0, period_months: months });
    await processCardPaymentEvent(...signed(p));
    const expiry = read(`subscription:${910 + index}`).expiresAt;
    const expected = new Date();
    const day = expected.getUTCDate();
    expected.setUTCDate(1); expected.setUTCMonth(expected.getUTCMonth() + months);
    expected.setUTCDate(Math.min(day, new Date(Date.UTC(expected.getUTCFullYear(), expected.getUTCMonth() + 1, 0)).getUTCDate()));
    assert.ok(Math.abs(expiry - expected.getTime()) < 3000);
    await assert.rejects(processCardPaymentEvent(...signed({ ...p, event_id: `cp:8${index}`, amount: amount + 1 })));
  }
});

test("Mini App checkout authenticates user and enforces the trial on the introductory plan", async () => {
  const server = startDashboardApi({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const init = (id) => {
    const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id }) });
    const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
    params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
    return params.toString();
  };
  const post = (body) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/api/card-checkout', headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve([res.statusCode, JSON.parse(Buffer.concat(chunks))]));
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  try {
    assert.equal((await post({ initData: 'broken', plan: 'plus' }))[0], 401);
    assert.equal((await post({ initData: init(904), plan: 'lite' }))[0], 403);
    assert.deepEqual((await post({ initData: init(904), action: 'quote' }))[1], {ok:true, weeklyPlan:'lite_regular', weeklyPrice:79});
    assert.deepEqual((await post({ initData: init(906), action: 'quote' }))[1], {ok:true, weeklyPlan:'lite', weeklyPrice:10});
    assert.equal((await post({ initData: init(904), plan: 'lite_regular' }))[0], 200);
    assert.equal((await post({ initData: init(906), plan: 'lite' }))[0], 200);
    assert.equal((await post({ initData: init(904), plan: 'plus' }))[0], 200);
    assert.equal((await post({ initData: init(904), plan: 'ultra' }))[0], 403);
    assert.ok(calls.some((call) => call.method === '/internal/ghost/checkout' && call.payload.user_id === 904 && call.payload.plan === 'plus'));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("regular weekly purchase credits seven days at 79 rubles", async () => {
  const before = Date.now();
  await processCardPaymentEvent(...signed(event({ event_id: "cp:weekly-regular", user_id: 920, plan: "lite_regular", amount: 79 })));
  assert.ok(read("subscription:920").expiresAt >= before + 7 * 86400000);
  assert.equal(read("payment:cp:weekly-regular").amount, 79);
  await assert.rejects(processCardPaymentEvent(...signed(event({ event_id: "cp:weekly-wrong", user_id: 921, plan: "lite_regular", amount: 10 }))));
});

test("HTTP payment callback verifies the original body before recording payment", async () => {
  const server = startDashboardApi({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const send = ([headers, raw]) => new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: server.address().port, method: "POST", path: "/api/card-payment-event", headers: { ...headers, "content-type": "application/json" } }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on("error", reject);
      req.end(raw);
    });
    const payload = event({ event_id: "cp:http", user_id: 908, invoice_id: "http-invoice" });
    assert.equal((await send(signed(payload, { secret: "wrong" }))).status, 401);
    assert.equal(read("payment:cp:http"), null);
    assert.equal((await send(signed(payload))).status, 200);
    assert.equal(read("payment:cp:http").amount, 10);
    assert.equal((await send(signed(payload))).body.duplicate, true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("permanent access is preserved and an accidental payment is recorded for review", async () => {
  const result = await processCardPaymentEvent(...signed(event({ event_id: "cp:301", user_id: 901, invoice_id: "ultra-invoice" })));
  assert.equal(result.needsReview, true);
  assert.equal(read("subscription:901").expiresAt, null);
  assert.equal(read("payment:cp:301").status, "needs_review");
});

test("card payment extends rather than replacing the remaining paid access", async () => {
  const existing = read("subscription:902").expiresAt;
  await processCardPaymentEvent(...signed(event({ event_id: "cp:302", user_id: 902, invoice_id: "existing-invoice" })));
  assert.equal(read("subscription:902").expiresAt, existing + 7 * 86400000);
});

test("simultaneous card and Stars payments both extend the same user's access", async () => {
  const before = Date.now();
  const card = event({ event_id: "cp:concurrent", user_id: 907, invoice_id: "concurrent-invoice" });
  const stars = { message: {
    from: { id: 907, first_name: "Test" }, chat: { id: 907, type: "private" },
    successful_payment: { invoice_payload: "ghost-plan:plus:179", currency: "XTR", total_amount: 179, telegram_payment_charge_id: "concurrent-stars" }
  } };
  await Promise.all([processCardPaymentEvent(...signed(card)), processUpdate(stars)]);
  const expiresAt = read("subscription:907").expiresAt;
  assert.ok(expiresAt >= before + 37 * 86400000 && expiresAt < before + 37 * 86400000 + 3000);
  assert.equal(read("payment:cp:concurrent").amount, 10);
  assert.equal(read("payment:concurrent-stars").amount, 179);
});

test("unsupported distributed storage fails closed before crediting", async () => {
  process.env.KV_REST_API_URL = "https://kv.example.test";
  try { await assert.rejects(processCardPaymentEvent(...signed(event({ event_id: "cp:400", user_id: 906 })))); }
  finally { delete process.env.KV_REST_API_URL; }
  assert.equal(read("payment:cp:400"), null);
});

const callback = (id, action) => ({ callback_query: { id: "query-" + action, from: { id }, data: action, message: { chat: { id, type: "private" }, message_id: 1 } } });
test("the promo is limited to ended trials and opens the configured checkout", async () => {
  calls = [];
  await processUpdate(callback(903, "card_offer"));
  assert.ok(calls.some((call) => call.method === "/internal/ghost/checkout"));
  const notice = calls.find((call) => call.payload.text?.includes("7 дней за 10 ₽"));
  assert.match(notice.payload.text, /Условия предложения указаны на странице оплаты/);
  assert.equal(notice.payload.reply_markup.inline_keyboard[0][0].url, "https://checkout.example.test/pay?order=test");
  calls = [];
  await processUpdate(callback(904, "card_offer"));
  assert.ok(!calls.some((call) => call.method === "/internal/ghost/checkout"));
});

test("unsub shows status, asks for confirmation and never claims cancellation on provider failure", async () => {
  calls = [];
  await processUpdate({ message: { from: { id: 903, first_name: "Test" }, chat: { id: 903, type: "private" }, text: "/unsub" } });
  assert.ok(calls.some((call) => call.payload.text?.includes("79 ₽ каждые 7 дней")));
  calls = [];
  await processUpdate(callback(903, "card_cancel_ask"));
  assert.ok(calls.some((call) => call.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === "card_cancel_confirm"));
  cancelConfirmed = false;
  calls = [];
  await processUpdate(callback(903, "card_cancel_confirm"));
  assert.ok(calls.some((call) => call.payload.text?.includes("Не удалось подтвердить отмену")));
  cancelConfirmed = true;
  calls = [];
  await processUpdate(callback(903, "card_cancel_confirm"));
  assert.ok(calls.some((call) => call.payload.text?.includes("Автопродление отключено")));
  remoteStatus = "cancellation_pending";
  calls = [];
  await processUpdate(callback(903, "card_subscription"));
  assert.ok(calls.some((call) => call.payload.text?.includes("Отмена обрабатывается")));
});

after(() => {
  flushStoreSync();
  globalThis.fetch = oldFetch;
  for (const name of ["TELEGRAM_BOT_TOKEN", "ARCHIVE_ENCRYPTION_KEY", "LOCAL_DATA_FILE", "KV_REST_API_URL", "KV_REST_API_TOKEN", "GHOST_CHECKOUT_INTERNAL_URL", "GHOST_CHECKOUT_PUBLIC_ORIGIN", "GHOST_CHECKOUT_SECRET", "GHOST_EVENT_SECRET"]) {
    if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  }
  rmSync(directory, { recursive: true, force: true });
});
