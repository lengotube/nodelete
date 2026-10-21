import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const API = "https://api.telegram.org";
const APP_URL = (process.env.PUBLIC_APP_URL || "").replace(/\/$/, "");
const BRAND = process.env.BOT_BRAND || "Ghost";
const BOT_USERNAME = process.env.BOT_USERNAME || "ghostmsg_robot";
const SUPPORT_URL = process.env.SUPPORT_URL || "";
const TERMS_URL = process.env.TERMS_URL || "https://telegra.ph/Polzovatelskoe-soglashenie-Ghost-10-17";
const PRIVACY_URL = process.env.PRIVACY_URL || "https://telegra.ph/Politika-konfidencialnosti-Ghost-10-17";
const ADMIN_IDS = new Set((process.env.ADMIN_IDS || "7822690557").split(",").map((id) => id.trim()).filter(Boolean));
const RETENTION_SECONDS = 90 * 24 * 60 * 60;
const TRIAL_DURATION_MS = 3 * 24 * 60 * 60 * 1000;
const FIRST_NUDGE_DELAY_MS = 15 * 1000;
const SAFETY_NUDGE_DELAY_MS = 24 * 60 * 60 * 1000;
const PAYWALL_NUDGE_DELAY_MS = 6 * 60 * 60 * 1000;
const TRIAL_FORECAST_DAYS = 30;
const PLANS = {
  lite: { title: "Lite", stars: 180, days: 7, scope: "personal" },
  plus: { title: "Plus", stars: 360, days: 30, scope: "personal" },
  prime: { title: "Prime", stars: 1700, days: 365, scope: "personal" },
  ultra: { title: "Ultra", stars: 4370, days: null, scope: "personal" },
  group5: { title: "Группы · 5", stars: 499, days: 30, scope: "groups", groups: 5 },
  group10: { title: "Группы · 10", stars: 749, days: 30, scope: "groups", groups: 10 },
  group20: { title: "Группы · 20", stars: 1249, days: 30, scope: "groups", groups: 20 },
  group50: { title: "Группы · 50", stars: 3999, days: 30, scope: "groups", groups: 50 }
};
const LOCALE = {
  ru: { connect: "Подключить", support: "Поддержка", language: "Язык", languagePick: "Выберите язык интерфейса:", languageSaved: "Язык: русский", payment: "Оплата получена", activated: "активирован" },
  en: { connect: "Connect", support: "Support", language: "Language", languagePick: "Choose your interface language:", languageSaved: "Language: English", payment: "Payment received", activated: "activated" }
};

const welcomeText = (appUrl) => `
<b><tg-emoji emoji-id="5413857558517553804">💬</tg-emoji></b><b> Восстанавливает личные сообщения</b>
<b><tg-emoji emoji-id="5413822103562524971">📢</tg-emoji></b><b> Восстанавливает сообщения в группах</b>
<b><tg-emoji emoji-id="5411515199318431537">📄</tg-emoji></b><b> Делает резервную копию выбранных переписок</b>

Это работает через <b>официальную функцию Telegram</b> — <a href="https://t.me/durov/519">пост Павла Дурова</a>.
<tg-emoji emoji-id="5411510242926172833">👮</tg-emoji> Подробнее <a href="${appUrl}/app?screen=safety">о безопасности ›</a>

<b>Подключение за 30 секунд:</b>
<tg-emoji emoji-id="5794182096603847292">1️⃣</tg-emoji> Скопируй username <b>${BRAND}</b>
&#x20;      <code>@${BOT_USERNAME}</code> <tg-emoji emoji-id="5413573223092624530">↩️</tg-emoji> нажми
<tg-emoji emoji-id="5794303034292968945">2⃣</tg-emoji> Открой <a href="tg://settings/edit">настройки</a>
&#x20;      <a href="tg://settings/edit">Telegram-профиля</a>
<tg-emoji emoji-id="5794031944547178894">3⃣</tg-emoji> Найди пункт настроек
&#x20;     <tg-emoji emoji-id="5469753237865275412">✨</tg-emoji> <b>Автоматизация чатов</b>
<tg-emoji emoji-id="5793901252987330401">4⃣</tg-emoji> Вставь username <b>${BRAND}</b>
&#x20;      <code>@${BOT_USERNAME}</code>
&#x20;      и нажми <b>Добавить</b>

<b>Частые вопросы:</b>
<a href="${appUrl}/app?screen=safety">Насколько это безопасно? ›</a>
<a href="${appUrl}/app?screen=help">У меня не работает ›</a>
<a href="${appUrl}/app?screen=groups">Как настроить в группах ›</a>
<a href="${appUrl}/app?screen=backup">Как настроить резервную копию переписок ›</a>
<a href="${TERMS_URL}">Пользовательское соглашение ›</a>
<a href="${PRIVACY_URL}">Политика конфиденциальности ›</a>
`.trim();

const welcomeTextEn = (appUrl) => `
<b><tg-emoji emoji-id="5413857558517553804">💬</tg-emoji></b><b> Keeps copies of new private messages</b>
<b><tg-emoji emoji-id="5413822103562524971">📢</tg-emoji></b><b> Tracks permitted group events</b>
<b><tg-emoji emoji-id="5411515199318431537">📄</tg-emoji></b><b> Creates backups of selected chats</b>

This works through an <b>official Telegram feature</b> — <a href="https://t.me/durov/519">Pavel Durov's post</a>.
<tg-emoji emoji-id="5411510242926172833">👮</tg-emoji> Read more <a href="${appUrl}/app?screen=safety">about safety ›</a>

<b>Connect in 30 seconds:</b>
<tg-emoji emoji-id="5794182096603847292">1️⃣</tg-emoji> Copy the <b>${BRAND}</b> username
&#x20;      <code>@${BOT_USERNAME}</code> <tg-emoji emoji-id="5413573223092624530">↩️</tg-emoji> tap it
<tg-emoji emoji-id="5794303034292968945">2⃣</tg-emoji> Open <a href="tg://settings/edit">Telegram profile settings</a>
<tg-emoji emoji-id="5794031944547178894">3⃣</tg-emoji> Find <tg-emoji emoji-id="5469753237865275412">✨</tg-emoji> <b>Chat automation</b>
<tg-emoji emoji-id="5793901252987330401">4⃣</tg-emoji> Paste <code>@${BOT_USERNAME}</code> and tap <b>Add</b>

<b>Frequently asked questions:</b>
<a href="${appUrl}/app?screen=safety">Is it safe? ›</a>
<a href="${appUrl}/app?screen=help">It doesn't work ›</a>
<a href="${appUrl}/app?screen=groups">How do groups work? ›</a>
<a href="${appUrl}/app?screen=backup">How do backups work? ›</a>
<a href="${TERMS_URL}">Terms of Service ›</a>
<a href="${PRIVACY_URL}">Privacy Policy ›</a>
`.trim();

const telegram = async (method, payload) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!body.ok) throw new Error(`${method}: ${body.description || "Telegram API error"}`);
  return body.result;
};

const appLink = (screen = "connect") => APP_URL ? `${APP_URL}/app?screen=${screen}` : undefined;
const botLink = `https://t.me/${BOT_USERNAME}`;

const keyboard = (language = "ru") => {
  const copy = LOCALE[language] || LOCALE.ru;
  return ({
  inline_keyboard: [
    [{ text: copy.connect, icon_custom_emoji_id: "5411465691230411357", web_app: { url: appLink("connect") || botLink } }],
    [
      { text: copy.support, icon_custom_emoji_id: "5411350246804461567", url: SUPPORT_URL || process.env.COMMUNITY_URL || botLink },
      { text: copy.language, icon_custom_emoji_id: "5224450179368767019", callback_data: "language" }
    ]
  ]
  });
};

const getKey = () => {
  const raw = Buffer.from(process.env.ARCHIVE_ENCRYPTION_KEY || "", "base64");
  if (raw.length !== 32) throw new Error("ARCHIVE_ENCRYPTION_KEY must be a 32-byte base64 value");
  return raw;
};

const seal = (value) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
};

const unseal = (value) => {
  const [iv, tag, encrypted] = String(value).split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"));
};

// The file backend is used on the VPS. Serialize access inside the process:
// a GET from long-polling and a scheduled funnel write may otherwise try to
// replace the same temporary file at once and corrupt the JSON store.
const localStoreOnce = async (command) => {
  const file = process.env.LOCAL_DATA_FILE;
  if (!file) throw new Error("Vercel KV or LOCAL_DATA_FILE must be configured");
  await mkdir(dirname(file), { recursive: true });
  let store = { strings: {}, sets: {} };
  try { store = JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const now = Date.now();
  for (const [key, record] of Object.entries(store.strings)) if (record.expiresAt && record.expiresAt < now) delete store.strings[key];
  for (const [key, record] of Object.entries(store.sets)) if (record.expiresAt && record.expiresAt < now) delete store.sets[key];
  const [verb, ...args] = command;
  let result = null;
  if (verb === "SET") {
    const [key, value, , seconds] = args;
    store.strings[key] = { value, expiresAt: Number(seconds) ? now + Number(seconds) * 1000 : null };
    result = "OK";
  } else if (verb === "GET") result = store.strings[args[0]]?.value || null;
  else if (verb === "DEL") { result = 0; for (const key of args) { if (delete store.strings[key]) result++; if (delete store.sets[key]) result++; } }
  else if (verb === "SADD") { const [key, ...values] = args; const current = new Set(store.sets[key]?.members || []); values.forEach((value) => current.add(value)); store.sets[key] = { members: [...current], expiresAt: store.sets[key]?.expiresAt || null }; result = current.size; }
  else if (verb === "SREM") { const [key, ...values] = args; const current = new Set(store.sets[key]?.members || []); let removed = 0; values.forEach((value) => { if (current.delete(value)) removed++; }); if (store.sets[key]) store.sets[key].members = [...current]; result = removed; }
  else if (verb === "SMEMBERS") result = store.sets[args[0]]?.members || [];
  else if (verb === "EXPIRE") { const [key, seconds] = args; const record = store.strings[key] || store.sets[key]; if (record) record.expiresAt = now + Number(seconds) * 1000; result = record ? 1 : 0; }
  else throw new Error(`Unsupported local storage command: ${verb}`);
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(store), { mode: 0o600 });
  await rename(temporary, file);
  return result;
};

let localStoreQueue = Promise.resolve();
const localStore = (command) => {
  const task = localStoreQueue.then(() => localStoreOnce(command));
  // Keep later commands available after a failed read/write while returning the
  // original failure to the caller that triggered it.
  localStoreQueue = task.catch(() => undefined);
  return task;
};

const kvRequest = async (command) => {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return localStore(command);
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error(`KV request failed (${response.status})`);
  const data = await response.json();
  if (data.error) throw new Error(`KV error: ${data.error}`);
  return data.result;
};

const put = async (key, data, seconds = RETENTION_SECONDS) => {
  const command = ["SET", key, seal(data)];
  if (Number.isFinite(seconds) && seconds > 0) command.push("EX", seconds);
  return kvRequest(command);
};
const get = async (key) => {
  const encrypted = await kvRequest(["GET", key]);
  return encrypted ? unseal(encrypted) : null;
};
const remove = async (...keys) => keys.length ? kvRequest(["DEL", ...keys]) : 0;
const addOwnerKey = async (ownerId, key) => {
  await kvRequest(["SADD", `owner:${ownerId}:keys`, key]);
  await kvRequest(["EXPIRE", `owner:${ownerId}:keys`, RETENTION_SECONDS]);
};
const addToSet = async (key, ...values) => values.length ? kvRequest(["SADD", key, ...values.map(String)]) : 0;
const removeFromSet = async (key, ...values) => values.length ? kvRequest(["SREM", key, ...values.map(String)]) : 0;
const members = async (key) => (await kvRequest(["SMEMBERS", key])) || [];
const isAdmin = (id) => ADMIN_IDS.has(String(id));

const messageKey = (connectionId, chatId, messageId) => `message:${connectionId}:${chatId}:${messageId}`;

const messagePreview = (message) => {
  if (message.text) return message.text;
  if (message.caption) return message.caption;
  if (message.photo) return "📷 Фото";
  if (message.video) return "🎬 Видео";
  if (message.voice) return "🎤 Голосовое сообщение";
  if (message.document) return `📎 ${message.document.file_name || "Документ"}`;
  return "Сообщение без текстового содержимого";
};

const chatTitle = (chat) => chat?.title || [chat?.first_name, chat?.last_name].filter(Boolean).join(" ") || null;
const EVENT_LIMIT = 200;
const clip = (value, size = 500) => { const text = String(value ?? ""); return text.length > size ? `${text.slice(0, size)}…` : text; };
async function recordEvent(ownerId, event) {
  if (!ownerId) return;
  const key = `events:${ownerId}`;
  const list = (await get(key)) || [];
  list.unshift({ ...event, at: Date.now() });
  await put(key, list.slice(0, EVENT_LIMIT));
  await addOwnerKey(ownerId, key);
}

const senderName = (message) => [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || "Собеседник";
const notifyOwner = (chatId, text) => telegram("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });

const trialKey = (ownerId) => `trial:${ownerId}`;
const lockedEventsKey = (ownerId) => `locked-events:${ownerId}`;
const funnelKey = (ownerId) => `funnel:${ownerId}`;
const funnelPendingKey = "funnel:pending";
const trialActiveKey = "trials:active";
const planKeyboard = () => ({ inline_keyboard: [[{ text: "⭐ Выбрать тариф", web_app: { url: appLink("plans") || botLink } }]] });

async function personalSubscription(ownerId) {
  return get(`subscription:${ownerId}`);
}

async function getAccessState(ownerId) {
  if (await personalSubscription(ownerId)) return { kind: "paid" };
  const trial = await get(trialKey(ownerId));
  if (trial?.status === "active" && trial.endsAt > Date.now()) return { kind: "trial", trial };
  return { kind: "locked", trial };
}

async function rememberOwnerData(ownerId, key) {
  await addOwnerKey(ownerId, key);
  return key;
}

async function updateFunnel(ownerId, stage, extra = {}) {
  const key = funnelKey(ownerId);
  const previous = (await get(key)) || { startedAt: Date.now(), events: [] };
  const events = Array.isArray(previous.events) ? previous.events : [];
  const last = events.at(-1);
  if (!last || last.stage !== stage || Date.now() - last.at > 30 * 1000) {
    events.push({ stage, at: Date.now() });
  }
  const next = { ...previous, ...extra, events: events.slice(-40) };
  await put(key, next, null);
  await rememberOwnerData(ownerId, key);
  return next;
}

async function beginFunnel(ownerId) {
  const current = await get(funnelKey(ownerId));
  if (current?.startedAt) return current;
  const funnel = await updateFunnel(ownerId, "started", { startedAt: Date.now(), reminders: {} });
  await addToSet(funnelPendingKey, ownerId);
  return funnel;
}

export async function trackFunnelEvent(ownerId, stage) {
  const allowed = new Set(["mini_app_opened", "view_connect", "username_copied", "settings_requested", "view_plans", "invoice_opened"]);
  if (!ownerId || !allowed.has(stage)) return;
  await beginFunnel(ownerId);
  await updateFunnel(ownerId, stage);
}

async function startTrial(connection) {
  const ownerId = connection.ownerId;
  if (!ownerId || await personalSubscription(ownerId)) return null;
  const key = trialKey(ownerId);
  const existing = await get(key);
  if (existing) return null;
  const startedAt = Date.now();
  const trial = {
    status: "active",
    startedAt,
    endsAt: startedAt + TRIAL_DURATION_MS,
    connectionId: connection.id,
    userChatId: connection.userChatId
  };
  await put(key, trial, null);
  await rememberOwnerData(ownerId, key);
  await addToSet(trialActiveKey, ownerId);
  await updateFunnel(ownerId, "trial_started", { connectedAt: startedAt });
  await removeFromSet(funnelPendingKey, ownerId);
  return trial;
}

async function finishTrial(ownerId, trial) {
  if (!trial || trial.status !== "active") return;
  if (await personalSubscription(ownerId)) {
    await put(trialKey(ownerId), { ...trial, status: "converted", convertedAt: Date.now() }, null);
    await removeFromSet(trialActiveKey, ownerId);
    return;
  }
  const events = (await get(`events:${ownerId}`)) || [];
  const caught = events.filter((event) => event.at >= trial.startedAt && event.at < trial.endsAt).length;
  const forecast = caught * (TRIAL_FORECAST_DAYS / 3);
  const ended = { ...trial, status: "ended", endedAt: Date.now(), caught };
  await put(trialKey(ownerId), ended, null);
  await removeFromSet(trialActiveKey, ownerId);
  await updateFunnel(ownerId, "trial_ended", { trialEndedAt: ended.endedAt, trialEvents: caught });
  const summary = caught
    ? `За время пробного периода Ghost зафиксировал <b>${caught}</b> ${caught === 1 ? "событие" : caught < 5 ? "события" : "событий"}. Это примерно <b>${forecast}</b> ${forecast === 1 ? "сообщение" : forecast < 5 ? "сообщения" : "сообщений"} за 30 дней при такой же активности.`
    : "За время пробного периода Ghost не получил доступных событий. Он продолжит сообщать о новых событиях без показа содержимого, пока не будет выбран тариф.";
  await telegram("sendMessage", {
    chat_id: trial.userChatId || ownerId,
    text: `<b>Пробный период завершён</b>\n\n${summary}\n\nGhost продолжит фиксировать новые доступные события. Выберите тариф, чтобы видеть их содержимое.`,
    parse_mode: "HTML",
    reply_markup: planKeyboard()
  });
}

async function recordLockedEvent(ownerId, event) {
  const key = lockedEventsKey(ownerId);
  const list = (await get(key)) || [];
  list.unshift(event);
  await put(key, list.slice(0, 25), null);
  await rememberOwnerData(ownerId, key);
}

async function sendLockedEventNotice(connection, type) {
  const key = `paywall:last:${connection.ownerId}`;
  const last = await get(key);
  if (last?.at && Date.now() - last.at < PAYWALL_NUDGE_DELAY_MS) return;
  const label = type === "edited" ? "изменение сообщения" : "удаление сообщения";
  await telegram("sendMessage", {
    chat_id: connection.userChatId,
    text: `<b>🔒 Ghost зафиксировал ${label}</b>\n\nПробный период завершён. Содержимое сохранено и откроется после выбора тарифа.`,
    parse_mode: "HTML",
    reply_markup: planKeyboard()
  });
  await put(key, { at: Date.now() }, 7 * 24 * 60 * 60);
  await rememberOwnerData(connection.ownerId, key);
}

async function deliverLockedEvents(ownerId, chatId) {
  const key = lockedEventsKey(ownerId);
  const events = (await get(key)) || [];
  if (!events.length) return;
  const rows = events.slice(0, 10).map((event) => {
    if (event.type === "edited") return editedMessageNotice(event);
    return deletedMessageNotice(event);
  });
  await notifyOwner(chatId, `<b>События, сохранённые после триала</b>\n\n${rows.join("\n\n")}`.slice(0, 4000));
  await remove(key);
}

async function activateTrialsForConnectedUsers() {
  for (const rawId of await members("business:enabled")) {
    const ownerId = String(rawId);
    if (await personalSubscription(ownerId) || await get(trialKey(ownerId))) continue;
    const keys = await members(`owner:${ownerId}:keys`);
    const connectionKey = keys.find((key) => key.startsWith("connection:"));
    const connection = connectionKey ? await get(connectionKey) : null;
    if (!connection?.enabled) continue;
    const trial = await startTrial(connection);
    if (!trial) continue;
    await telegram("sendMessage", {
      chat_id: trial.userChatId || ownerId,
      parse_mode: "HTML",
      text: `🎁 <b>Для вас активирован бесплатный пробный период на 3 дня.</b>\n\nДо ${new Date(trial.endsAt).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })} Ghost будет показывать содержимое новых доступных событий.`
    });
  }
}

export async function runFunnelAutomation() {
  const now = Date.now();
  await activateTrialsForConnectedUsers();
  for (const rawId of await members(funnelPendingKey)) {
    const ownerId = String(rawId);
    const funnel = await get(funnelKey(ownerId));
    if (!funnel?.startedAt || funnel.connectedAt || await personalSubscription(ownerId)) {
      await removeFromSet(funnelPendingKey, ownerId);
      continue;
    }
    const reminders = funnel.reminders || {};
    if (!reminders.first && now - funnel.startedAt >= FIRST_NUDGE_DELAY_MS) {
      await telegram("sendMessage", {
        chat_id: ownerId,
        text: "Нужна помощь с подключением? Нажмите кнопку — Ghost пришлёт прямую ссылку на настройки Telegram.",
        reply_markup: { inline_keyboard: [[{ text: "⚙ Открыть настройки Telegram", callback_data: "connect" }]] }
      });
      await put(funnelKey(ownerId), { ...funnel, reminders: { ...reminders, first: now } }, null);
      continue;
    }
    if (!reminders.safety && now - funnel.startedAt >= SAFETY_NUDGE_DELAY_MS) {
      await telegram("sendMessage", {
        chat_id: ownerId,
        text: "Ghost подключается только через встроенную «Автоматизацию чатов». Пароль и код входа не нужны; доступ можно отключить в любой момент.",
        reply_markup: { inline_keyboard: [[{ text: "⚙ Открыть настройки Telegram", callback_data: "connect" }]] }
      });
      await put(funnelKey(ownerId), { ...funnel, reminders: { ...reminders, safety: now } }, null);
      await removeFromSet(funnelPendingKey, ownerId);
    }
  }
  for (const rawId of await members(trialActiveKey)) {
    const ownerId = String(rawId);
    const trial = await get(trialKey(ownerId));
    if (!trial || trial.status !== "active") {
      await removeFromSet(trialActiveKey, ownerId);
      continue;
    }
    if (now >= trial.endsAt) await finishTrial(ownerId, trial);
  }
}

const planFromPayload = (payload) => {
  const [, planId] = String(payload || "").split(":");
  return PLANS[planId] ? { id: planId, ...PLANS[planId] } : null;
};

async function sendStarsInvoice(chatId, planId) {
  const plan = PLANS[planId];
  if (!plan) throw new Error("Unknown plan");
  return telegram("sendInvoice", {
    chat_id: chatId,
    title: `${BRAND} ${plan.title}`,
    description: plan.days ? `Доступ к Ghost на ${plan.days === 365 ? "1 год" : `${plan.days} ${plan.days === 7 ? "дней" : "дней"}`}.` : "Постоянный доступ к Ghost.",
    payload: `ghost-plan:${planId}`,
    currency: "XTR",
    prices: [{ label: `${plan.title} — Ghost`, amount: plan.stars }],
    start_parameter: `buy_${planId}`
  });
}

async function completeStarsPayment(message) {
  const payment = message.successful_payment;
  const plan = planFromPayload(payment.invoice_payload);
  if (!plan || payment.currency !== "XTR" || payment.total_amount !== plan.stars) return;
  const expiresAt = plan.days ? Date.now() + plan.days * 24 * 60 * 60 * 1000 : null;
  const record = { plan: plan.id, scope: plan.scope, groups: plan.groups || 0, expiresAt, chargeId: payment.telegram_payment_charge_id, purchasedAt: new Date().toISOString() };
  const subscriptionKey = plan.scope === "groups" ? `group-subscription:${message.from.id}` : `subscription:${message.from.id}`;
  await put(subscriptionKey, record, plan.days ? plan.days * 24 * 60 * 60 : null);
  await put(`payment:${payment.telegram_payment_charge_id}`, { ...record, userId: message.from.id, amount: payment.total_amount, currency: payment.currency }, null);
  await addToSet("payments:ids", payment.telegram_payment_charge_id);
  const language = (await get(`language:${message.from.id}`))?.code || "ru";
  const copy = LOCALE[language] || LOCALE.ru;
  const isGroupPlan = plan.scope === "groups";
  if (!isGroupPlan) {
    const trial = await get(trialKey(message.from.id));
    if (trial?.status === "active") {
      await put(trialKey(message.from.id), { ...trial, status: "converted", convertedAt: Date.now() }, null);
      await removeFromSet(trialActiveKey, message.from.id);
    }
    await updateFunnel(message.from.id, "payment_completed", { paidAt: Date.now(), plan: plan.id });
  }
  await telegram("sendMessage", {
    chat_id: message.chat.id,
    text: isGroupPlan
      ? `✅ <b>Доступ для ${plan.groups} групп активирован.</b>\n\nОн действует до ${new Date(expiresAt).toLocaleDateString("ru-RU")}. Откройте инструкцию и добавьте Ghost только в группы, которыми вы управляете.`
      : language === "en"
      ? `✅ <b>${copy.payment}.</b>\n\nYour <b>${plan.title}</b> plan is ${copy.activated}${plan.days ? ` until ${new Date(expiresAt).toLocaleDateString("en-GB")}` : " forever"}.`
      : `✅ <b>${copy.payment}.</b>\n\nТариф <b>${plan.title}</b> ${copy.activated}${plan.days ? ` до ${new Date(expiresAt).toLocaleDateString("ru-RU")}` : " навсегда"}.`,
    parse_mode: "HTML",
    reply_markup: isGroupPlan ? { inline_keyboard: [[{ text: "Открыть инструкцию для групп", web_app: { url: appLink("groups-guide") || botLink } }]] } : undefined
  });
  if (!isGroupPlan) await deliverLockedEvents(message.from.id, message.chat.id);
}

async function saveBusinessMessage(message) {
  if (!message.business_connection_id || !message.chat?.id || !message.message_id) return;
  const connection = await get(`connection:${message.business_connection_id}`);
  // A business message can arrive just before the connection update reaches us
  // (for example after a process restart). Keep that snapshot too: the matching
  // deletion update contains the connection id and can retrieve it safely.
  if (connection && !connection.enabled) return;
  const key = messageKey(message.business_connection_id, message.chat.id, message.message_id);
  const snapshot = {
    ownerId: connection?.ownerId || null,
    connectionId: message.business_connection_id,
    chatId: message.chat.id,
    messageId: message.message_id,
    senderId: message.from?.id || null,
    sender: senderName(message),
    username: message.from?.username || null,
    chatTitle: chatTitle(message.chat),
    text: messagePreview(message),
    timestamp: message.date,
    savedAt: new Date().toISOString()
  };
  await put(key, snapshot);
  if (connection?.ownerId) {
    await addOwnerKey(connection.ownerId, key);
    const chatsKey = `owner:${connection.ownerId}:chats`;
    await addToSet(chatsKey, message.chat.id);
    await addOwnerKey(connection.ownerId, chatsKey);
  }
  console.log("Business message snapshot saved", {
    connectionId: message.business_connection_id,
    chatId: message.chat.id,
    messageId: message.message_id
  });
}

async function processEditedBusinessMessage(message) {
  const key = messageKey(message.business_connection_id, message.chat.id, message.message_id);
  const previous = await get(key);
  await saveBusinessMessage(message);
  const connection = await get(`connection:${message.business_connection_id}`);
  if (!connection?.enabled) return;
  if (!previous || String(message.from?.id) === String(connection.ownerId) || String(previous.senderId) === String(connection.ownerId)) return;
  const event = {
    type: "edited",
    chatId: message.chat.id,
    chatTitle: chatTitle(message.chat),
    sender: senderName(message),
    username: message.from?.username || previous.username || null,
    senderId: message.from?.id || previous.senderId || null,
    text: clip(messagePreview(message)),
    previous: clip(previous.text),
    occurredAt: Date.now()
  };
  await recordEvent(connection.ownerId, event);
  const access = await getAccessState(connection.ownerId);
  if (access.kind === "locked") {
    await recordLockedEvent(connection.ownerId, event);
    return sendLockedEventNotice(connection, "edited");
  }
  await notifyOwner(connection.userChatId, editedMessageNotice(event));
}

async function processDeletedBusinessMessages(deleted) {
  const connection = await get(`connection:${deleted.business_connection_id}`);
  if (!connection?.enabled) return;
  // Bot API uses `chat` here. Keep `chat_id` as a compatibility fallback.
  const chatId = deleted.chat?.id ?? deleted.chat_id;
  console.log("Business deletion received", {
    connectionId: deleted.business_connection_id,
    chatId,
    messageIds: deleted.message_ids || []
  });
  if (!chatId) {
    console.error("Business deletion has no chat id", { connectionId: deleted.business_connection_id });
    return;
  }
  for (const id of deleted.message_ids || []) {
    const key = messageKey(deleted.business_connection_id, chatId, id);
    const previous = await get(key);
    if (previous && String(previous.senderId) === String(connection.ownerId)) continue;
    if (!previous) {
      await recordEvent(connection.ownerId, { type: "deleted", chatId, chatTitle: chatTitle(deleted.chat), sender: null, text: null, unknown: true });
      if ((await getAccessState(connection.ownerId)).kind !== "locked") {
        await notifyOwner(connection.userChatId,
          `<b>🗑 Сообщение удалено</b>\n\nTelegram сообщил об удалении, но Ghost не получил исходный текст. Это бывает, если сообщение было отправлено до подключения или не входило в разрешённый доступ бота.`
        );
      }
      continue;
    }
    const event = {
      type: "deleted",
      chatId,
      chatTitle: previous.chatTitle || chatTitle(deleted.chat),
      sender: previous.sender,
      username: previous.username || null,
      senderId: previous.senderId || null,
      text: clip(previous.text),
      occurredAt: Date.now()
    };
    await recordEvent(connection.ownerId, event);
    if ((await getAccessState(connection.ownerId)).kind === "locked") {
      await recordLockedEvent(connection.ownerId, event);
      await sendLockedEventNotice(connection, "deleted");
      continue;
    }
    await notifyOwner(connection.userChatId, deletedMessageNotice(event));
  }
}

async function storeConnection(connection) {
  const ownerId = connection.user?.id;
  if (!ownerId) return;
  const data = {
    id: connection.id,
    ownerId,
    userChatId: connection.user_chat_id,
    enabled: connection.is_enabled,
    connectedAt: connection.date
  };
  await put(`connection:${connection.id}`, data, RETENTION_SECONDS);
  await addOwnerKey(ownerId, `connection:${connection.id}`);
  if (connection.is_enabled) {
    await addToSet("business:enabled", ownerId);
    const trial = await startTrial(data);
    const trialText = trial
      ? `\n\n🎁 <b>Пробный период активирован на 3 дня.</b> До ${new Date(trial.endsAt).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })} Ghost будет показывать содержимое новых доступных событий бесплатно.`
      : "";
    await notifyOwner(connection.user_chat_id,
      `✅ <b>${escapeHtml(BRAND)} подключён и готов к работе.</b>\n\nЯ буду присылать уведомления, если Telegram передаст мне событие удаления или изменения в чатах, которые вы разрешили. Старые сообщения до подключения недоступны.${trialText}`
    );
  } else {
    await removeFromSet("business:enabled", ownerId);
    await removeFromSet(trialActiveKey, ownerId);
    await removeFromSet(funnelPendingKey, ownerId);
    await eraseOwnerData(ownerId);
  }
}

async function eraseOwnerData(ownerId) {
  const keys = (await kvRequest(["SMEMBERS", `owner:${ownerId}:keys`])) || [];
  await remove(...keys, `owner:${ownerId}:keys`);
  await removeFromSet(trialActiveKey, ownerId);
  await removeFromSet(funnelPendingKey, ownerId);
}

const escapeHtml = (value) => String(value || "").replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]);

const notificationTime = (value = Date.now()) => {
  const timestamp = Number(value);
  const date = new Date(timestamp > 0 && timestamp < 20_000_000_000 ? timestamp * 1000 : timestamp || Date.now());
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
};

const senderMention = ({ sender, username, senderId } = {}) => {
  const name = escapeHtml(sender || "Собеседник");
  const handle = String(username || "").replace(/^@/, "").trim();
  const href = handle
    ? `https://t.me/${encodeURIComponent(handle)}`
    : senderId ? `tg://user?id=${encodeURIComponent(String(senderId))}` : null;
  return href ? `<a href="${href}"><b>${name}</b></a>` : `<b>${name}</b>`;
};

const deletedMessageNotice = (event) =>
  `<tg-emoji emoji-id="5411218378423575851">🗑</tg-emoji> ${senderMention(event)} удалил(а) сообщение · <i>${notificationTime(event.occurredAt)}</i>\n\n` +
  `<blockquote>${escapeHtml(event.text)}</blockquote>`;

const editedMessageNotice = (event) =>
  `<tg-emoji emoji-id="5413857558517553804">💬</tg-emoji> ${senderMention(event)} изменил(а) сообщение · <i>${notificationTime(event.occurredAt)}</i>\n\n` +
  `<b>Новое:</b>\n<blockquote>${escapeHtml(event.text)}</blockquote>\n\n` +
  `<b>Было:</b>\n<blockquote><s>${escapeHtml(event.previous)}</s></blockquote>`;

const dateKey = (value = new Date()) => new Date(value).toISOString().slice(0, 10);
const money = (value) => new Intl.NumberFormat("ru-RU").format(Number(value) || 0);

async function registerUser(message, referralCode = null) {
  if (!message.from || message.chat?.type !== "private") return null;
  const key = `user:${message.from.id}`;
  const previous = await get(key);
  const user = {
    id: message.from.id,
    name: senderName(message),
    username: message.from.username || null,
    joinedAt: previous?.joinedAt || new Date().toISOString(),
    referralCode: previous?.referralCode || referralCode || null,
    lastSeenAt: new Date().toISOString()
  };
  await put(key, user, null);
  await addToSet("users:active", message.from.id);
  return { user, isNew: !previous };
}

async function createReferral(code, price, adminId) {
  const normalized = String(code || "").toLowerCase();
  if (!/^[a-z0-9_-]{3,48}$/.test(normalized)) throw new Error("Название: 3–48 символов, только латинские буквы, цифры, _ или -.");
  if (!Number.isFinite(Number(price)) || Number(price) < 0) throw new Error("Цена должна быть неотрицательным числом.");
  if (await get(`referral:${normalized}`)) throw new Error("Такая рекламная ссылка уже существует.");
  const record = { code: normalized, price: Number(price), createdBy: adminId, createdAt: new Date().toISOString() };
  await put(`referral:${normalized}`, record, null);
  await addToSet("referrals:codes", normalized);
  return record;
}

async function registerReferralVisit(code, message) {
  const referral = await get(`referral:${code}`);
  if (!referral || !message.from) return null;
  const stats = (await get(`referral:${code}:events`)) || { clicks: 0 };
  await put(`referral:${code}:events`, { clicks: stats.clicks + 1 }, null);
  // First visit per user is what the link costs (unique visitors × price); keep its time for the ledger panel.
  const isFirstVisit = !(await members(`referral:${code}:visitors`)).map(String).includes(String(message.from.id));
  await addToSet(`referral:${code}:visitors`, message.from.id);
  if (isFirstVisit) await addToSet("ledger:ref_visits", `${Date.now()}|${code}|${message.from.id}|${referral.price}`);
  await registerUser(message, code);
  return referral;
}

async function referralStats(code) {
  const referral = await get(`referral:${code}`);
  if (!referral) return null;
  const event = (await get(`referral:${code}:events`)) || { clicks: 0 };
  const visitors = await members(`referral:${code}:visitors`);
  let paid = 0;
  for (const id of visitors) if (await get(`subscription:${id}`)) paid++;
  const unique = visitors.length;
  return { ...referral, clicks: event.clicks, unique, paid, conversion: unique ? paid / unique * 100 : 0, totalCost: unique * referral.price };
}

function referralReport(stats, detailed = false) {
  if (!stats) return "Ссылка не найдена.";
  const rows = [
    `<b>Рекламная ссылка: ${escapeHtml(stats.code)}</b>`,
    detailed ? `Цена за пользователя: <b>${money(stats.price)}</b>` : null,
    `Переходов: <b>${money(stats.clicks)}</b>`,
    `Уникальных пользователей: <b>${money(stats.unique)}</b>`,
    `Конверсия в оплату: <b>${stats.conversion.toFixed(1)}%</b>`,
    `Итоговая стоимость: <b>${money(stats.totalCost)}</b>`
  ].filter(Boolean);
  return rows.join("\n");
}

function adminKeyboard() {
  return { inline_keyboard: [
    [{ text: "📨 Рассылка", callback_data: "admin:broadcast" }, { text: "📊 Статистика", callback_data: "admin:stats" }],
    [{ text: "🔗 Рефералы", callback_data: "admin:referrals" }, { text: "👥 Пользователи", callback_data: "admin:users" }],
    [{ text: "🧹 Удалить невалидных", callback_data: "admin:purge" }],
    [{ text: "← Назад", callback_data: "admin:back" }]
  ] };
}

async function sendAdminPanel(chatId) {
  const profiles = await members("users:active");
  const invalid = await members("users:invalid");
  const payments = await members("payments:ids");
  return telegram("sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: `<b>Админ-панель Ghost</b>\n\nПользователи для рассылки: <b>${money(profiles.length)}</b>\nНевалидные: <b>${money(invalid.length)}</b>\nПлатежи: <b>${money(payments.length)}</b>`,
    reply_markup: adminKeyboard()
  });
}

async function sendAdminStats(chatId) {
  const ids = await members("users:active");
  const users = (await Promise.all(ids.map((id) => get(`user:${id}`)))).filter(Boolean);
  const payments = (await Promise.all((await members("payments:ids")).map((id) => get(`payment:${id}`)))).filter(Boolean);
  const today = dateKey();
  const newToday = users.filter((user) => dateKey(user.joinedAt) === today).length;
  const paidToday = payments.filter((payment) => dateKey(payment.purchasedAt) === today);
  const revenueToday = paidToday.reduce((total, payment) => total + (payment.amount || 0), 0);
  const revenueAll = payments.reduce((total, payment) => total + (payment.amount || 0), 0);
  const linked = (await members("business:enabled")).length;
  const referralCodes = await members("referrals:codes");
  const text = `<b>📊 Статистика Ghost — сегодня</b>\n━━━━━━━━━━━━\n\n<b>👥 Пользователи</b>\nНовых: <b>${money(newToday)}</b>\nДоступных для рассылки: <b>${money(users.length)}</b>\nПодключили автоматизацию: <b>${money(linked)}</b>\n\n<b>⭐ Платежи</b>\nСегодня: <b>${money(paidToday.length)}</b> (${money(revenueToday)} Stars)\nВсего: <b>${money(payments.length)}</b> (${money(revenueAll)} Stars)\nКонверсия в оплату: <b>${users.length ? (payments.length / users.length * 100).toFixed(1) : "0.0"}%</b>\n\n<b>🔗 Реклама</b>\nАктивных ссылок: <b>${money(referralCodes.length)}</b>`;
  return telegram("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "← Админ-панель", callback_data: "admin:back" }]] } });
}

async function sendUserExport(chatId) {
  const ids = await members("users:active");
  const body = `${ids.sort((a, b) => Number(a) - Number(b)).join("\n")}\n`;
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("caption", `Пользователи Ghost: ${ids.length}`);
  form.set("document", new Blob([body], { type: "text/plain" }), "ghost-users.txt");
  const response = await fetch(`${API}/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: "POST", body: form });
  const data = await response.json();
  if (!data.ok) throw new Error(`sendDocument: ${data.description || "Telegram API error"}`);
}

function broadcastKeyboard(rows = []) {
  return rows.length ? { inline_keyboard: rows } : undefined;
}

function parseBroadcastButtons(value) {
  const lines = String(value || "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  if (lines.length > 20) throw new Error("Не больше 20 кнопок в одном посте.");
  return lines.map((line) => {
    const match = line.match(/^!([gbr])\s+(.+?)\s+-\s+(.+)$/i);
    if (!match) throw new Error("Не удалось прочитать строку. Используйте формат: !g Текст кнопки - ссылка");
    const [, color, rawLabel, rawTarget] = match;
    const label = rawLabel.trim();
    const target = rawTarget.trim();
    if (!label || label.length > 56) throw new Error("Текст кнопки должен быть от 1 до 56 символов.");
    const prefix = ({ g: "🟢", b: "🔵", r: "🔴" })[color.toLowerCase()];
    const text = `${prefix} ${label}`;
    if (/^(https?:\/\/|tg:\/\/)/i.test(target)) return [{ text, url: target }];
    if (/^start(?:=|:)?/i.test(target)) {
      const payload = target.replace(/^start(?:=|:)?/i, "").trim();
      return [{ text, url: `https://t.me/${BOT_USERNAME}${payload ? `?start=${encodeURIComponent(payload)}` : ""}` }];
    }
    if (target.length > 55) throw new Error("Внутреннее действие кнопки слишком длинное.");
    return [{ text, callback_data: `post:${target}` }];
  });
}

async function broadcast(draft) {
  const ids = await members("users:active");
  let sent = 0;
  let invalid = 0;
  for (const id of ids) {
    try {
      await telegram("copyMessage", {
        chat_id: Number(id),
        from_chat_id: draft.sourceChatId,
        message_id: draft.messageId,
        reply_markup: broadcastKeyboard(draft.buttons)
      });
      sent++;
    } catch (error) {
      if (/blocked|deactivated|chat not found|forbidden/i.test(String(error.message))) {
        await addToSet("users:invalid", id);
        invalid++;
      }
    }
  }
  return { sent, invalid };
}

async function sendReferralList(chatId) {
  const codes = (await members("referrals:codes")).sort();
  const stats = (await Promise.all(codes.map((code) => referralStats(code)))).filter(Boolean);
  const shown = stats.slice(0, 40);
  const list = shown.length
    ? shown.map((item) => `/ref_${item.code}: <b>${money(item.unique)}</b> 👥 (${money(item.price)} за пользователя)`).join("\n")
    : "Пока нет созданных рекламных ссылок.";
  const suffix = stats.length > shown.length ? `\n\nПоказаны первые ${shown.length} из ${stats.length}.` : "";
  return telegram("sendMessage", {
    chat_id: chatId,
    text: `<b>🔗 Реферальные ссылки</b>\n\n${list}${suffix}\n\nКоманда /ref_linkname — полная статистика.\n/refssilkacheck_linkname — публичная статистика.`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: "➕ Создать ссылку", callback_data: "admin:newref" }],
      [{ text: "← Назад", callback_data: "admin:back" }]
    ] }
  });
}

function broadcastControls(stage = "draft") {
  if (stage === "preview") return { inline_keyboard: [
    [{ text: "Изменить", callback_data: "compose:edit" }, { text: "Отправить", callback_data: "compose:send" }],
    [{ text: "Отмена", callback_data: "compose:cancel" }]
  ] };
  if (stage === "edit") return { inline_keyboard: [
    [{ text: "Текст / медиа", callback_data: "compose:replace" }, { text: "Кнопки", callback_data: "compose:buttons" }],
    [{ text: "← К предпросмотру", callback_data: "compose:preview" }, { text: "Отмена", callback_data: "compose:cancel" }]
  ] };
  return { inline_keyboard: [
    [{ text: "Добавить кнопки", callback_data: "compose:buttons" }],
    [{ text: "Предпросмотр", callback_data: "compose:preview" }, { text: "Отмена", callback_data: "compose:cancel" }]
  ] };
}

async function sendBroadcastPreview(chatId, adminId) {
  const flow = await get(`admin:flow:${adminId}`);
  if (!flow?.sourceChatId || !flow?.messageId) return telegram("sendMessage", { chat_id: chatId, text: "Черновик рассылки не найден. Начните заново через «Рассылка»." });
  const draft = { ...flow, type: "broadcast_confirm" };
  await put(`admin:flow:${adminId}`, draft, 60 * 60);
  await telegram("copyMessage", {
    chat_id: chatId,
    from_chat_id: draft.sourceChatId,
    message_id: draft.messageId,
    reply_markup: broadcastKeyboard(draft.buttons)
  });
  return telegram("sendMessage", { chat_id: chatId, text: "Проверьте превью поста.", reply_markup: broadcastControls("preview") });
}

async function sendSettingsPrompt(chatId, ownerId = chatId) {
  await beginFunnel(ownerId);
  await updateFunnel(ownerId, "settings_requested");
  return telegram("sendMessage", {
    chat_id: chatId,
    text: `Откройте <a href="tg://settings/edit">настройки профиля Telegram</a>, пролистайте вниз и найдите «Автоматизация чатов». Затем вставьте <code>@${BOT_USERNAME}</code>.`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "⚙ Открыть настройки Telegram", url: "tg://settings/edit" }]] }
  });
}

async function commandHandler(message) {
  if (message.web_app_data?.data) {
    try {
      const payload = JSON.parse(message.web_app_data.data);
      const plan = PLANS[payload.plan];
      if (payload.action === "group_invoice" && plan?.scope === "groups") {
        return sendStarsInvoice(message.chat.id, payload.plan);
      }
    } catch {
      return telegram("sendMessage", { chat_id: message.chat.id, text: "Не удалось определить выбранный пакет. Откройте раздел «Группы» ещё раз." });
    }
  }
  const text = message.text || "";
  const [rawCommand, argument] = text.split(/\s+/, 2);
  const command = rawCommand.toLowerCase().split("@")[0];
  const flow = message.from && isAdmin(message.from.id) ? await get(`admin:flow:${message.from.id}`) : null;
  if (flow && (!text || !text.startsWith("/"))) {
    if (flow.type === "broadcast_post") {
      const draft = {
        type: "broadcast_draft",
        sourceChatId: message.chat.id,
        messageId: message.message_id,
        buttons: flow.buttons || []
      };
      await put(`admin:flow:${message.from.id}`, draft, 60 * 60);
      return telegram("sendMessage", {
        chat_id: message.chat.id,
        text: "Пост сохранён. Форматирование, Premium Emoji и медиа будут скопированы без изменений.",
        reply_markup: broadcastControls()
      });
    }
    if (flow.type === "broadcast_buttons") {
      try {
        const draft = { ...flow, type: "broadcast_draft", buttons: parseBroadcastButtons(text) };
        await put(`admin:flow:${message.from.id}`, draft, 60 * 60);
        return telegram("sendMessage", {
          chat_id: message.chat.id,
          text: `Кнопки сохранены: <b>${draft.buttons.length}</b>.`,
          parse_mode: "HTML",
          reply_markup: broadcastControls()
        });
      } catch (error) {
        return telegram("sendMessage", { chat_id: message.chat.id, text: `⚠️ ${escapeHtml(error.message)}`, parse_mode: "HTML" });
      }
    }
    if (flow.type === "ref_name") {
      const code = text.trim().toLowerCase();
      if (!/^[a-z0-9_-]{3,48}$/.test(code)) return telegram("sendMessage", { chat_id: message.chat.id, text: "Введите название: 3–48 символов, латинские буквы, цифры, _ или -." });
      await put(`admin:flow:${message.from.id}`, { type: "ref_price", code }, 15 * 60);
      return telegram("sendMessage", { chat_id: message.chat.id, text: `Введите цену за одного пользователя для <b>${escapeHtml(code)}</b>.`, parse_mode: "HTML" });
    }
    if (flow.type === "ref_price") {
      try {
        const referral = await createReferral(flow.code, text.trim().replace(",", "."), message.from.id);
        await remove(`admin:flow:${message.from.id}`);
        return telegram("sendMessage", {
          chat_id: message.chat.id,
          parse_mode: "HTML",
          text: `<b>Рекламная ссылка создана</b>\n\nhttps://t.me/${BOT_USERNAME}?start=${referral.code}\n\nЦена за пользователя: <b>${money(referral.price)}</b>`,
          reply_markup: { inline_keyboard: [[{ text: "К списку ссылок", callback_data: "admin:referrals" }], [{ text: "← Админ-панель", callback_data: "admin:back" }]] }
        });
      } catch (error) {
        return telegram("sendMessage", { chat_id: message.chat.id, text: escapeHtml(error.message), parse_mode: "HTML" });
      }
    }
  }
  const fullRef = command.match(/^\/ref_([a-z0-9_-]+)$/i);
  const publicRef = command.match(/^\/refssilkacheck_([a-z0-9_-]+)$/i);
  if (fullRef && message.from && isAdmin(message.from.id)) {
    return telegram("sendMessage", { chat_id: message.chat.id, text: referralReport(await referralStats(fullRef[1].toLowerCase()), true), parse_mode: "HTML" });
  }
  if (publicRef) return telegram("sendMessage", { chat_id: message.chat.id, text: referralReport(await referralStats(publicRef[1].toLowerCase())), parse_mode: "HTML" });
  if (command === "/admin" && message.from && isAdmin(message.from.id)) return sendAdminPanel(message.chat.id);
  if (command === "/start") {
    await beginFunnel(message.from.id);
    if (argument === "settings") return sendSettingsPrompt(message.chat.id, message.from.id);
    if (argument?.startsWith("buy_")) return sendStarsInvoice(message.chat.id, argument.slice(4));
    if (argument) await registerReferralVisit(argument.toLowerCase(), message);
    const language = (await get(`language:${message.from.id}`))?.code || "ru";
    return telegram("sendMessage", {
      chat_id: message.chat.id,
      text: language === "en" ? welcomeTextEn(APP_URL || botLink) : welcomeText(APP_URL || botLink),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: keyboard(language)
    });
  }
  if (command === "/archive") {
    return telegram("sendMessage", {
      chat_id: message.chat.id,
      text: `📄 Резервные копии доступны в Mini App. Выберите тариф, затем откройте раздел «Архив» для инструкций по подключению.`,
      reply_markup: { inline_keyboard: [[{ text: "Открыть резервные копии", web_app: { url: appLink("backup") || botLink } }]] }
    });
  }
  if (command === "/my_data") {
    return telegram("sendMessage", {
      chat_id: message.chat.id,
      text: `Управляйте данными, которые ${BRAND} сохранил после подключения.`,
      reply_markup: {
        inline_keyboard: [[{ text: "Удалить мои данные", callback_data: `erase:${message.from.id}` }]]
      }
    });
  }
  if (command === "/help") {
    return telegram("sendMessage", { chat_id: message.chat.id, text: `Подробная инструкция: ${appLink("help") || "откройте меню бота"}` });
  }
}

async function callbackHandler(callback) {
  const [action, suppliedId] = (callback.data || "").split(":");
  if (action === "connect") {
    await telegram("answerCallbackQuery", { callback_query_id: callback.id });
    return sendSettingsPrompt(callback.message.chat.id, callback.from.id);
  }
  if (action === "admin") {
    if (!isAdmin(callback.from.id)) return telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Нет доступа", show_alert: true });
    await telegram("answerCallbackQuery", { callback_query_id: callback.id });
    if (suppliedId === "back") return sendAdminPanel(callback.message.chat.id);
    if (suppliedId === "stats") return sendAdminStats(callback.message.chat.id);
    if (suppliedId === "broadcast") {
      await put(`admin:flow:${callback.from.id}`, { type: "broadcast_post", buttons: [] }, 60 * 60);
      return telegram("sendMessage", {
        chat_id: callback.message.chat.id,
        text: "Отправьте готовый пост одним сообщением. Поддерживаются текст с форматированием и Premium Emoji, фото, видео, документы и подписи — получатели увидят точную копию."
      });
    }
    if (suppliedId === "referrals") return sendReferralList(callback.message.chat.id);
    if (suppliedId === "newref") {
      await put(`admin:flow:${callback.from.id}`, { type: "ref_name" }, 15 * 60);
      return telegram("sendMessage", { chat_id: callback.message.chat.id, text: "Выберите название для ссылки (linkname).\n\nРазрешены латинские буквы, цифры, _ и -; от 3 до 48 символов." });
    }
    if (suppliedId === "users") return sendUserExport(callback.message.chat.id);
    if (suppliedId === "purge") {
      const invalid = await members("users:invalid");
      await removeFromSet("users:active", ...invalid);
      await removeFromSet("users:invalid", ...invalid);
      return telegram("sendMessage", { chat_id: callback.message.chat.id, text: `Удалено из базы рассылки: <b>${invalid.length}</b>.`, parse_mode: "HTML", reply_markup: adminKeyboard() });
    }
  }
  if (action === "compose") {
    if (!isAdmin(callback.from.id)) return telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Нет доступа", show_alert: true });
    await telegram("answerCallbackQuery", { callback_query_id: callback.id });
    const flowKey = `admin:flow:${callback.from.id}`;
    const flow = await get(flowKey);
    if (suppliedId === "cancel") {
      await remove(flowKey);
      return telegram("sendMessage", { chat_id: callback.message.chat.id, text: "Рассылка отменена.", reply_markup: adminKeyboard() });
    }
    if (!flow?.sourceChatId || !flow?.messageId) {
      return telegram("sendMessage", { chat_id: callback.message.chat.id, text: "Черновик рассылки не найден. Начните заново через «Рассылка»." });
    }
    if (suppliedId === "buttons") {
      await put(flowKey, { ...flow, type: "broadcast_buttons" }, 60 * 60);
      return telegram("sendMessage", {
        chat_id: callback.message.chat.id,
        text: "Отправьте кнопки одним сообщением — по одной в строке.\n\n<b>Формат:</b>\n!g Получить доступ - https://example.com\n!b Открыть Ghost - start=settings\n!r Внутренняя команда - action_name\n\n<b>Цвет:</b> !g — зелёный, !b — синий, !r — красный. Telegram не позволяет задавать реальный цвет inline-кнопки, поэтому цвет отображается понятной меткой в её тексте.",
        parse_mode: "HTML"
      });
    }
    if (suppliedId === "preview") return sendBroadcastPreview(callback.message.chat.id, callback.from.id);
    if (suppliedId === "edit") {
      await put(flowKey, { ...flow, type: "broadcast_draft" }, 60 * 60);
      return telegram("sendMessage", { chat_id: callback.message.chat.id, text: "Что изменить в посте?", reply_markup: broadcastControls("edit") });
    }
    if (suppliedId === "replace") {
      await put(flowKey, { ...flow, type: "broadcast_post" }, 60 * 60);
      return telegram("sendMessage", { chat_id: callback.message.chat.id, text: "Отправьте новую версию поста. Его форматирование, Premium Emoji и медиа будут сохранены; уже созданные кнопки останутся." });
    }
    if (suppliedId === "send") {
      await remove(flowKey);
      const result = await broadcast(flow);
      return telegram("sendMessage", {
        chat_id: callback.message.chat.id,
        text: `Рассылка завершена.\nДоставлено: <b>${result.sent}</b>\nНевалидных: <b>${result.invalid}</b>`,
        parse_mode: "HTML",
        reply_markup: adminKeyboard()
      });
    }
  }
  if (action === "post") {
    return telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Готово" });
  }
  if (action === "language") {
    await telegram("answerCallbackQuery", { callback_query_id: callback.id });
    return telegram("sendMessage", {
      chat_id: callback.message.chat.id,
      text: "Выберите язык / Choose language",
      reply_markup: { inline_keyboard: [[{ text: "🇷🇺 Русский", callback_data: "lang:ru" }, { text: "🇬🇧 English", callback_data: "lang:en" }]] }
    });
  }
  if (action === "lang" && LOCALE[suppliedId]) {
    await put(`language:${callback.from.id}`, { code: suppliedId });
    await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: LOCALE[suppliedId].languageSaved });
    return telegram("editMessageText", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      text: suppliedId === "en" ? "✅ Language saved. Send /start to receive the welcome message in English." : "✅ Язык сохранён. Отправьте /start, чтобы получить приветствие на русском."
    });
  }
  if (action === "erase" && String(callback.from.id) === suppliedId) {
    await eraseOwnerData(callback.from.id);
    await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Данные удалены" });
    return telegram("editMessageText", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      text: "✅ Сохранённые данные удалены. При следующем подключении архив начнётся заново."
    });
  }
  if (action === "pay" && PLANS[suppliedId]) {
    await telegram("answerCallbackQuery", { callback_query_id: callback.id });
    return sendStarsInvoice(callback.message.chat.id, suppliedId);
  }
}

/**
 * Summary for the Mini App home screen. `tzOffset` is the viewer's
 * Date#getTimezoneOffset() so "today" matches their local day.
 */
export async function getDashboard(ownerId, { tzOffset = 0, limit = EVENT_LIMIT } = {}) {
  const enabled = await members("business:enabled");
  const connected = enabled.map(String).includes(String(ownerId));
  if (!connected) return { connected: false };
  const events = (await get(`events:${ownerId}`)) || [];
  const access = await getAccessState(ownerId);
  const chats = (await members(`owner:${ownerId}:chats`)).length;
  const offsetMs = (Number(tzOffset) || 0) * 60 * 1000;
  const localNow = new Date(Date.now() - offsetMs);
  const startOfDay = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) + offsetMs;
  const today = { deleted: 0, edited: 0 };
  for (const event of events) if (event.at >= startOfDay && today[event.type] !== undefined) today[event.type]++;
  const visibleEvents = access.kind === "locked"
    ? events.slice(0, limit).map(({ type, at, unknown }) => ({ type, at, unknown, locked: true }))
    : events.slice(0, limit);
  return {
    connected: true,
    chats,
    today,
    access: access.kind,
    trial: access.trial ? { status: access.trial.status, startedAt: access.trial.startedAt, endsAt: access.trial.endsAt } : null,
    events: visibleEvents
  };
}

/**
 * Read-only export for the accounting panel on the same server: Stars payments and
 * first ad-link visits since the given times (ms since epoch).
 */
export async function getLedgerExport({ paymentsSince = 0, visitsSince = 0, includeUsers = false } = {}) {
  const payments = [];
  for (const chargeId of await members("payments:ids")) {
    const payment = await get(`payment:${chargeId}`);
    const at = payment?.purchasedAt ? Date.parse(payment.purchasedAt) : NaN;
    if (!payment || !(at >= paymentsSince)) continue;
    payments.push({ chargeId, userId: payment.userId, plan: payment.plan, amount: payment.amount, currency: payment.currency, at });
  }
  const visits = [];
  for (const entry of await members("ledger:ref_visits")) {
    const [at, code, userId, price] = String(entry).split("|");
    if (Number(at) >= visitsSince) visits.push({ at: Number(at), code, userId: Number(userId), price: Number(price) || 0 });
  }
  if (!includeUsers) return { payments, visits };
  // Users for retention / activity metrics: id, join date, ad link, last activity. Blocked = users:invalid.
  const users = [];
  for (const id of await members("users:active")) {
    const user = await get(`user:${id}`);
    if (user) users.push({ id: user.id, joinedAt: user.joinedAt, lastSeenAt: user.lastSeenAt, referralCode: user.referralCode });
  }
  return { payments, visits, users, invalid: await members("users:invalid") };
}

export async function processUpdate(update) {
  if (update.message) {
    await registerUser(update.message);
    await commandHandler(update.message);
  }
  if (update.message?.successful_payment) await completeStarsPayment(update.message);
  if (update.callback_query) await callbackHandler(update.callback_query);
  if (update.pre_checkout_query) {
    const plan = planFromPayload(update.pre_checkout_query.invoice_payload);
    const valid = plan && update.pre_checkout_query.currency === "XTR" && update.pre_checkout_query.total_amount === plan.stars;
    await telegram("answerPreCheckoutQuery", valid
      ? { pre_checkout_query_id: update.pre_checkout_query.id, ok: true }
      : { pre_checkout_query_id: update.pre_checkout_query.id, ok: false, error_message: "Не удалось проверить выбранный тариф. Откройте Ghost и попробуйте ещё раз." });
  }
  if (update.business_connection) await storeConnection(update.business_connection);
  if (update.business_message) await saveBusinessMessage(update.business_message);
  if (update.edited_business_message) await processEditedBusinessMessage(update.edited_business_message);
  if (update.deleted_business_messages) await processDeletedBusinessMessages(update.deleted_business_messages);
}

export default async function handler(request, response) {
  if (request.method !== "POST") return response.status(405).json({ ok: false });
  if (request.headers["x-telegram-bot-api-secret-token"] !== process.env.WEBHOOK_SECRET) return response.status(401).json({ ok: false });
  try {
    await processUpdate(request.body);
    return response.status(200).json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook error", error);
    return response.status(500).json({ ok: false });
  }
}
