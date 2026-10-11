import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const API = "https://api.telegram.org";
const APP_URL = (process.env.PUBLIC_APP_URL || "").replace(/\/$/, "");
const BRAND = process.env.BOT_BRAND || "Ghost";
const BOT_USERNAME = process.env.BOT_USERNAME || "ghostmsg_robot";
const SUPPORT_URL = process.env.SUPPORT_URL || "";
const RETENTION_SECONDS = 90 * 24 * 60 * 60;
const PLANS = {
  lite: { title: "Lite", stars: 180, days: 7 },
  plus: { title: "Plus", stars: 360, days: 30 },
  prime: { title: "Prime", stars: 1700, days: 365 },
  ultra: { title: "Ultra", stars: 4370, days: null }
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
&#x20;      @${BOT_USERNAME} <tg-emoji emoji-id="5413573223092624530">↩️</tg-emoji> нажми
<tg-emoji emoji-id="5794303034292968945">2⃣</tg-emoji> Открой <a href="tg://settings/edit">настройки</a>
&#x20;      <a href="tg://settings/edit">Telegram-профиля</a>
<tg-emoji emoji-id="5794031944547178894">3⃣</tg-emoji> Найди пункт настроек
&#x20;     <tg-emoji emoji-id="5469753237865275412">✨</tg-emoji> <b>Автоматизация чатов</b>
<tg-emoji emoji-id="5793901252987330401">4⃣</tg-emoji> Вставь username <b>${BRAND}</b>
&#x20;      @${BOT_USERNAME}
&#x20;      и нажми <b>Добавить</b>

<b>Частые вопросы:</b>
<a href="${appUrl}/app?screen=safety">Насколько это безопасно? ›</a>
<a href="${appUrl}/app?screen=help">У меня не работает ›</a>
<a href="${appUrl}/app?screen=groups">Как настроить в группах ›</a>
<a href="${appUrl}/app?screen=backup">Как настроить резервную копию переписок ›</a>
`.trim();

const welcomeTextEn = (appUrl) => `
<b><tg-emoji emoji-id="5413857558517553804">💬</tg-emoji></b><b> Keeps copies of new private messages</b>
<b><tg-emoji emoji-id="5413822103562524971">📢</tg-emoji></b><b> Tracks permitted group events</b>
<b><tg-emoji emoji-id="5411515199318431537">📄</tg-emoji></b><b> Creates backups of selected chats</b>

This works through an <b>official Telegram feature</b> — <a href="https://t.me/durov/519">Pavel Durov's post</a>.
<tg-emoji emoji-id="5411510242926172833">👮</tg-emoji> Read more <a href="${appUrl}/app?screen=safety">about safety ›</a>

<b>Connect in 30 seconds:</b>
<tg-emoji emoji-id="5794182096603847292">1️⃣</tg-emoji> Copy the <b>${BRAND}</b> username
&#x20;      @${BOT_USERNAME} <tg-emoji emoji-id="5413573223092624530">↩️</tg-emoji> tap it
<tg-emoji emoji-id="5794303034292968945">2⃣</tg-emoji> Open <a href="tg://settings/edit">Telegram profile settings</a>
<tg-emoji emoji-id="5794031944547178894">3⃣</tg-emoji> Find <tg-emoji emoji-id="5469753237865275412">✨</tg-emoji> <b>Chat automation</b>
<tg-emoji emoji-id="5793901252987330401">4⃣</tg-emoji> Paste @${BOT_USERNAME} and tap <b>Add</b>

<b>Frequently asked questions:</b>
<a href="${appUrl}/app?screen=safety">Is it safe? ›</a>
<a href="${appUrl}/app?screen=help">It doesn't work ›</a>
<a href="${appUrl}/app?screen=groups">How do groups work? ›</a>
<a href="${appUrl}/app?screen=backup">How do backups work? ›</a>
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

const localStore = async (command) => {
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
  else if (verb === "SMEMBERS") result = store.sets[args[0]]?.members || [];
  else if (verb === "EXPIRE") { const [key, seconds] = args; const record = store.strings[key] || store.sets[key]; if (record) record.expiresAt = now + Number(seconds) * 1000; result = record ? 1 : 0; }
  else throw new Error(`Unsupported local storage command: ${verb}`);
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(store), { mode: 0o600 });
  await rename(temporary, file);
  return result;
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

const senderName = (message) => [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || "Собеседник";
const notifyOwner = (chatId, text) => telegram("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });

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
  const record = { plan: plan.id, expiresAt, chargeId: payment.telegram_payment_charge_id, purchasedAt: new Date().toISOString() };
  await put(`subscription:${message.from.id}`, record, plan.days ? plan.days * 24 * 60 * 60 : null);
  const language = (await get(`language:${message.from.id}`))?.code || "ru";
  const copy = LOCALE[language] || LOCALE.ru;
  await telegram("sendMessage", {
    chat_id: message.chat.id,
    text: language === "en"
      ? `✅ <b>${copy.payment}.</b>\n\nYour <b>${plan.title}</b> plan is ${copy.activated}${plan.days ? ` until ${new Date(expiresAt).toLocaleDateString("en-GB")}` : " forever"}.`
      : `✅ <b>${copy.payment}.</b>\n\nТариф <b>${plan.title}</b> ${copy.activated}${plan.days ? ` до ${new Date(expiresAt).toLocaleDateString("ru-RU")}` : " навсегда"}.`,
    parse_mode: "HTML"
  });
}

async function saveBusinessMessage(message) {
  if (!message.business_connection_id) return;
  const connection = await get(`connection:${message.business_connection_id}`);
  if (!connection?.enabled) return;
  const key = messageKey(message.business_connection_id, message.chat.id, message.message_id);
  const snapshot = {
    ownerId: connection.ownerId,
    connectionId: message.business_connection_id,
    chatId: message.chat.id,
    messageId: message.message_id,
    sender: senderName(message),
    username: message.from?.username || null,
    text: messagePreview(message),
    timestamp: message.date,
    savedAt: new Date().toISOString()
  };
  await put(key, snapshot);
  await addOwnerKey(connection.ownerId, key);
}

async function processEditedBusinessMessage(message) {
  const key = messageKey(message.business_connection_id, message.chat.id, message.message_id);
  const previous = await get(key);
  await saveBusinessMessage(message);
  if (!previous) return;
  const connection = await get(`connection:${message.business_connection_id}`);
  if (!connection?.enabled) return;
  const oldText = escapeHtml(previous.text);
  const newText = escapeHtml(messagePreview(message));
  await notifyOwner(connection.userChatId,
    `<b>✏️ ${escapeHtml(senderName(message))} изменил(а) сообщение</b>\n\n` +
    `<b>Новое:</b>\n<blockquote>${newText}</blockquote>\n` +
    `<b>Было:</b>\n<blockquote><s>${oldText}</s></blockquote>`
  );
}

async function processDeletedBusinessMessages(deleted) {
  const connection = await get(`connection:${deleted.business_connection_id}`);
  if (!connection?.enabled) return;
  for (const id of deleted.message_ids || []) {
    const key = messageKey(deleted.business_connection_id, deleted.chat_id, id);
    const previous = await get(key);
    if (!previous) continue;
    await notifyOwner(connection.userChatId,
      `<b>🗑 Сообщение удалено</b>\n\n` +
      `<b>${escapeHtml(previous.sender)}:</b>\n<blockquote>${escapeHtml(previous.text)}</blockquote>\n` +
      `<i>Сохранено после подключения ${escapeHtml(BRAND)}.</i>`
    );
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
    await notifyOwner(connection.user_chat_id,
      `✅ <b>${escapeHtml(BRAND)} подключён и готов к работе.</b>\n\nЯ буду присылать уведомления, если Telegram передаст мне событие удаления или изменения в чатах, которые вы разрешили. Старые сообщения до подключения недоступны.`
    );
  } else {
    await eraseOwnerData(ownerId);
  }
}

async function eraseOwnerData(ownerId) {
  const keys = (await kvRequest(["SMEMBERS", `owner:${ownerId}:keys`])) || [];
  await remove(...keys, `owner:${ownerId}:keys`);
}

const escapeHtml = (value) => String(value || "").replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]);

async function commandHandler(message) {
  const text = message.text || "";
  const [rawCommand, argument] = text.split(/\s+/, 2);
  const command = rawCommand.toLowerCase().split("@")[0];
  if (command === "/start") {
    if (argument?.startsWith("buy_")) return sendStarsInvoice(message.chat.id, argument.slice(4));
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

export async function processUpdate(update) {
  if (update.message) await commandHandler(update.message);
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
