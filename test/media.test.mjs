import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Exercise the real encrypted store and update handlers. All file IDs, users,
// payments and Telegram responses below are synthetic; no network is allowed.
const directory = mkdtempSync(join(tmpdir(), "ghost-media-test-"));
const dataFile = join(directory, "store.json");
const key = randomBytes(32);
const originalEnvironment = { ...process.env };
const originalFetch = globalThis.fetch;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.ARCHIVE_ENCRYPTION_KEY = key.toString("base64");
process.env.LOCAL_DATA_FILE = dataFile;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const seal = (value) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map((part) => part.toString("base64url")).join(".");
};
const unseal = (value) => {
  const [iv, tag, bytes] = value.split(".").map((part) => Buffer.from(part, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", key, iv);
  cipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([cipher.update(bytes), cipher.final()]).toString("utf8"));
};
const store = { strings: {}, sets: { "business:enabled": { members: [], expiresAt: null } } };
const seed = (name, value) => { store.strings[name] = { value: seal(value), expiresAt: null }; };
const fixtures = new Map();
function fixture(name, { settings = {}, locked = false, legacy = null } = {}) {
  const ownerId = 900000 + fixtures.size;
  const peerId = 800000 + fixtures.size;
  const connectionId = `test-${name}`;
  const data = {
    ownerId, peerId, connectionId,
    message: (media = {}, messageId = 1) => ({
      business_connection_id: connectionId,
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: peerId, type: "private", first_name: "Test contact" },
      from: { id: peerId, first_name: "Test sender", username: "test_sender" },
      ...media
    }),
    deletion: (messageIds = [1]) => ({
      business_connection_id: connectionId,
      chat: { id: peerId, type: "private", first_name: "Test contact" },
      message_ids: messageIds
    })
  };
  fixtures.set(name, data);
  seed(`connection:${connectionId}`, { id: connectionId, ownerId, userChatId: ownerId, enabled: true });
  store.sets["business:enabled"].members.push(String(ownerId));
  if (locked) seed(`trial:${ownerId}`, { status: "ended", startedAt: 1, endsAt: 2 });
  else seed(`subscription:${ownerId}`, { plan: "vip", scope: "personal", expiresAt: null });
  seed(`settings:${ownerId}`, settings);
  if (legacy) seed(`message:${connectionId}:${peerId}:1`, { senderId: peerId, sender: "Test sender", text: "📷 Фото", hiddenMedia: legacy });
  return data;
}

const types = [
  ["photo", { photo: [{ file_id: "small-photo", width: 10, height: 10 }, { file_id: "full-photo", width: 500, height: 500 }] }, "sendPhoto", "full-photo", "📷 Фото"],
  ["video", { video: { file_id: "full-video" } }, "sendVideo", "full-video", "🎬 Видео"],
  ["voice", { voice: { file_id: "full-voice", duration: 12 } }, "sendVoice", "full-voice", "🎤 Голосовое сообщение"],
  ["video_note", { video_note: { file_id: "full-circle", length: 240 } }, "sendVideoNote", "full-circle", "⭕ Видеосообщение (кружок)"],
  ["animation", { animation: { file_id: "full-animation" }, document: { file_id: "duplicate-document" } }, "sendAnimation", "full-animation", "🎞 Анимация"],
  ["audio", { audio: { file_id: "full-audio" } }, "sendAudio", "full-audio", "🎵 Аудиофайл"],
  ["document", { document: { file_id: "full-document", file_name: "test.pdf" } }, "sendDocument", "full-document", "📎 test.pdf"]
];
for (const [kind] of types) fixture(kind);
fixture("ordinary-with-hidden-toggles-off", { settings: { saveSpoilerMedia: false, sendSpoilerMedia: false } });
fixture("spoiler");
fixture("spoiler-save-off", { settings: { saveSpoilerMedia: false } });
fixture("spoiler-send-off", { settings: { sendSpoilerMedia: false } });
fixture("legacy", { legacy: { kind: "photo", fileId: "legacy-photo" } });
fixture("edit");
fixture("locked", { locked: true });
fixture("notifications-off", { settings: { notifications: false } });
fixture("deletions-off", { settings: { notifyDeleted: false } });
fixture("own-message");
fixture("live-location");
fixture("caption-failure");
fixture("file-failure");
fixture("missing-original");
writeFileSync(dataFile, JSON.stringify(store), { mode: 0o600 });

const calls = [];
let nextMessageId = 100;
globalThis.fetch = async (url, options) => {
  assert.ok(String(url).startsWith("https://api.telegram.org/bottest-token/"), "Unexpected network request");
  const method = String(url).split("/").at(-1);
  const payload = JSON.parse(options.body);
  const messageId = ++nextMessageId;
  calls.push({ method, payload, messageId });
  if (payload.voice === "invalid-file") return { json: async () => ({ ok: false, description: "Bad Request: wrong file identifier" }) };
  if (payload.video === "caption-failure-video" && payload.caption !== "<b>Ghost сохранил медиа.</b>") {
    return { json: async () => ({ ok: false, description: "Bad Request: caption is too long" }) };
  }
  return { json: async () => ({ ok: true, result: { message_id: messageId, chat: { id: payload.chat_id } } }) };
};
const { processUpdate, flushStoreSync, getDashboard } = await import("../api/telegram.js");
const read = (name) => {
  flushStoreSync();
  const value = JSON.parse(readFileSync(dataFile, "utf8")).strings[name]?.value;
  return value ? unseal(value) : null;
};
const snapshot = (f, messageId = 1) => read(`message:${f.connectionId}:${f.peerId}:${messageId}`);
const send = async (f, media, messageId = 1) => processUpdate({ business_message: f.message(media, messageId) });
const remove = async (f, messageIds = [1]) => processUpdate({ deleted_business_messages: f.deletion(messageIds) });
const resetCalls = () => { calls.length = 0; };

for (const [kind, media, method, fileId, label] of types) {
  test(`deleted ${kind} is saved and returned in its native Telegram format`, async () => {
    const f = fixtures.get(kind);
    resetCalls();
    await send(f, media);
    assert.equal(calls.length, 0, "Receiving media must not notify immediately");
    assert.equal(snapshot(f).media.fileId, fileId);
    assert.equal(snapshot(f).text, label);
    assert.equal(readFileSync(dataFile, "utf8").includes(fileId), false, "File references must be encrypted");
    await remove(f);
    const delivery = calls.find((call) => call.method === method);
    assert.ok(delivery);
    assert.equal(delivery.payload[kind], fileId);
    if (kind === "video_note") {
      assert.equal(calls.length, 2);
      assert.equal(calls[0].method, "sendMessage");
      assert.equal(delivery.payload.reply_parameters.message_id, calls[0].messageId);
      assert.equal(delivery.payload.caption, undefined);
      assert.equal(delivery.payload.parse_mode, undefined);
      assert.ok(calls[0].payload.text.includes(label));
    } else {
      assert.equal(calls.length, 1);
      assert.ok(delivery.payload.caption.includes("удалил(а)"));
      assert.ok(delivery.payload.caption.includes(label));
      assert.equal(delivery.payload.parse_mode, "HTML");
    }
  });
}

test("hidden-media toggles do not prevent ordinary media recovery", async () => {
  const f = fixtures.get("ordinary-with-hidden-toggles-off");
  resetCalls();
  await send(f, { voice: { file_id: "ordinary-voice" } });
  await remove(f);
  assert.equal(calls[0].method, "sendVoice");
});

test("spoiler media is saved and restored when enabled", async () => {
  const f = fixtures.get("spoiler");
  resetCalls();
  await send(f, { has_media_spoiler: true, photo: [{ file_id: "spoiler-photo" }] });
  assert.equal(snapshot(f).media.hasSpoiler, true);
  await remove(f);
  assert.equal(calls[0].payload.photo, "spoiler-photo");
});

for (const mode of ["spoiler-save-off", "spoiler-send-off"]) {
  test(`${mode} respects the existing preference`, async () => {
    const f = fixtures.get(mode);
    resetCalls();
    await send(f, { has_media_spoiler: true, video: { file_id: "hidden-video" } });
    assert.equal(Boolean(snapshot(f).media), mode === "spoiler-send-off");
    await remove(f);
    assert.deepEqual(calls.map((call) => call.method), ["sendMessage"]);
  });
}

test("previously saved hiddenMedia records remain recoverable", async () => {
  resetCalls();
  await remove(fixtures.get("legacy"));
  assert.equal(calls[0].payload.photo, "legacy-photo");
});

test("editing preserves the old attachment in the edit event and the new attachment for later deletion", async () => {
  const f = fixtures.get("edit");
  await send(f, { video: { file_id: "old-video" }, caption: "Old <text> & caption" });
  resetCalls();
  await processUpdate({ edited_business_message: f.message({ video: { file_id: "new-video" }, caption: "New <text> & caption" }) });
  assert.equal(calls[0].payload.video, "old-video");
  assert.ok(calls[0].payload.caption.includes("New &lt;text&gt; &amp; caption"));
  assert.ok(calls[0].payload.caption.includes("Old &lt;text&gt; &amp; caption"));
  assert.equal(snapshot(f).media.fileId, "new-video");
  resetCalls();
  await remove(f);
  assert.equal(calls[0].payload.video, "new-video");
});

test("expired access hides media and releases saved voice and video note only after payment", async () => {
  const f = fixtures.get("locked");
  resetCalls();
  await send(f, { voice: { file_id: "locked-voice" } }, 1);
  await send(f, { video_note: { file_id: "locked-circle" } }, 2);
  await remove(f, [1, 2]);
  assert.ok(calls.every((call) => call.method === "sendMessage"));
  const dashboard = await getDashboard(f.ownerId);
  assert.equal(dashboard.access, "locked");
  assert.ok(dashboard.events.every((event) => event.locked && !event.media && !event.hiddenMedia));
  assert.equal(read(`locked-events:${f.ownerId}`).length, 2);
  resetCalls();
  await processUpdate({ message: {
    from: { id: f.ownerId, first_name: "Test owner" }, chat: { id: f.ownerId, type: "private" },
    successful_payment: { invoice_payload: "ghost-plan:lite:180", currency: "XTR", total_amount: 180, telegram_payment_charge_id: "test-media-charge" }
  } });
  assert.ok(calls.some((call) => call.method === "sendVoice" && call.payload.voice === "locked-voice"));
  const circle = calls.find((call) => call.method === "sendVideoNote");
  assert.equal(circle.payload.video_note, "locked-circle");
  assert.ok(calls.some((call) => call.method === "sendMessage" && call.messageId === circle.payload.reply_parameters.message_id));
  assert.equal(read(`locked-events:${f.ownerId}`), null);
});

for (const name of ["notifications-off", "deletions-off", "own-message"]) {
  test(`${name} does not produce an unwanted media notification`, async () => {
    const f = fixtures.get(name);
    resetCalls();
    const own = name === "own-message" ? { from: { id: f.ownerId, first_name: "Owner" } } : {};
    await send(f, { photo: [{ file_id: "silent-photo" }], ...own });
    await remove(f);
    assert.equal(calls.length, 0);
  });
}

test("live-location updates are still ignored", async () => {
  const f = fixtures.get("live-location");
  resetCalls();
  await send(f, { location: { latitude: 1, longitude: 2, live_period: 60 } });
  await processUpdate({ edited_business_message: f.message({ location: { latitude: 2, longitude: 3, live_period: 60 } }) });
  assert.equal(calls.length, 0);
});

test("an oversized caption falls back without losing the media or full notice", async () => {
  const f = fixtures.get("caption-failure");
  resetCalls();
  await send(f, { video: { file_id: "caption-failure-video" }, caption: "Long media caption" });
  await remove(f);
  assert.deepEqual(calls.map((call) => call.method), ["sendVideo", "sendVideo", "sendMessage"]);
  assert.equal(calls[1].payload.caption, "<b>Ghost сохранил медиа.</b>");
  assert.ok(calls[2].payload.text.includes("Long media caption"));
});

test("an unavailable Telegram file still produces the text notification", async () => {
  const f = fixtures.get("file-failure");
  resetCalls();
  await send(f, { voice: { file_id: "invalid-file" } });
  await remove(f);
  assert.deepEqual(calls.map((call) => call.method), ["sendVoice", "sendMessage"]);
});

test("missing originals never fabricate an attachment", async () => {
  resetCalls();
  await remove(fixtures.get("missing-original"));
  assert.deepEqual(calls.map((call) => call.method), ["sendMessage"]);
  assert.ok(calls[0].payload.text.includes("Ghost не получил исходный текст"));
});

after(() => {
  flushStoreSync();
  globalThis.fetch = originalFetch;
  for (const name of ["TELEGRAM_BOT_TOKEN", "ARCHIVE_ENCRYPTION_KEY", "LOCAL_DATA_FILE", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) {
    if (originalEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnvironment[name];
  }
  rmSync(directory, { recursive: true, force: true });
});
