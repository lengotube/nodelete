import { createHmac, timingSafeEqual } from "node:crypto";

const API = "https://api.telegram.org";
const BRAND = process.env.BOT_BRAND || "Ghost";
const SUPPORT_URL = process.env.SUPPORT_URL || "https://t.me/ghostmsg_support_bot?start=help";
const STARS_PLANS = {
  lite: { title: "Ghost Lite", stars: 180, description: "Доступ к Ghost на 7 дней." },
  plus: { title: "Ghost Plus", stars: 360, description: "Доступ к Ghost на 30 дней." },
  prime: { title: "Ghost Prime", stars: 1700, description: "Доступ к Ghost на 1 год." },
  ultra: { title: "Ghost Ultra", stars: 4370, description: "Постоянный доступ к Ghost." },
  group5: { title: "Ghost для 5 групп", stars: 499, groups: 5 },
  group10: { title: "Ghost для 10 групп", stars: 749, groups: 10 },
  group20: { title: "Ghost для 20 групп", stars: 1249, groups: 20 },
  group50: { title: "Ghost для 50 групп", stars: 3999, groups: 50 }
};

const settingsText = (username) => `
<tg-emoji emoji-id="5411127204857812990">⚙️</tg-emoji> <b>Подключение за 30 секунд:</b>

<tg-emoji emoji-id="5794182096603847292">1️⃣</tg-emoji> Нажми и скопируй <b>username</b>
<code>@${username}</code> <tg-emoji emoji-id="5413573223092624530">↩️</tg-emoji> тык

<tg-emoji emoji-id="5794303034292968945">2⃣</tg-emoji> Открой <a href="tg://settings/edit">настройки</a>
<a href="tg://settings/edit">Telegram-профиля</a>

<tg-emoji emoji-id="5794031944547178894">3⃣</tg-emoji> Найди пункт настроек
<tg-emoji emoji-id="5469753237865275412">✨</tg-emoji> <b>Автоматизация чатов</b>

<tg-emoji emoji-id="5793901252987330401">4⃣</tg-emoji> Вставь username <b>${BRAND}</b>
<code>@${username}</code>
и нажми <b>Добавить</b>
`.trim();

function verifiedUser(initData) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram token is not configured for Mini App actions.");
  const params = new URLSearchParams(initData || "");
  const hash = params.get("hash");
  if (!hash) throw new Error("Missing Telegram Mini App signature.");
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const provided = Buffer.from(hash, "hex");
  const calculated = Buffer.from(expected, "hex");
  if (provided.length !== calculated.length || !timingSafeEqual(provided, calculated)) throw new Error("Invalid Telegram Mini App signature.");
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate < Math.floor(Date.now() / 1000) - 24 * 60 * 60) throw new Error("Mini App session expired. Reopen Ghost and try again.");
  const user = JSON.parse(params.get("user") || "null");
  if (!user?.id) throw new Error("Telegram user was not provided.");
  return user;
}

async function telegram(method, payload) {
  const response = await fetch(`${API}/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!body.ok) throw new Error(body.description || "Telegram API error");
  return body.result;
}

function responseJson(response, status, body) {
  response.status(status).setHeader("cache-control", "no-store").json(body);
}

export default async function handler(request, response) {
  if (request.method !== "POST") return responseJson(response, 405, { ok: false });
  try {
    const { action, initData } = request.body || {};
    const user = verifiedUser(initData);
    if (action === "settings") {
      await telegram("sendMessage", {
        chat_id: user.id,
        text: settingsText(process.env.BOT_USERNAME || "ghostmsg_robot"),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[{ text: "⚙ Открыть настройки Telegram", url: "tg://settings/edit" }]] }
      });
    } else if (action === "support") {
      await telegram("sendMessage", {
        chat_id: user.id,
        text: `Поддержка ${BRAND} готова помочь. Откройте чат — команда увидит ваше сообщение.`,
        reply_markup: { inline_keyboard: [[{ text: "💬 Написать в поддержку", url: SUPPORT_URL }]] }
      });
    } else if (action === "stars_invoice") {
      const plan = STARS_PLANS[request.body?.plan];
      if (!plan) return responseJson(response, 400, { ok: false, message: "Выбранный пакет не найден." });
      const description = plan.description || `Доступ к мониторингу до ${plan.groups} групп на 30 дней.`;
      const label = plan.groups ? `${plan.groups} групп — Ghost` : `${plan.title} — Ghost`;
      const invoiceUrl = await telegram("createInvoiceLink", {
        title: plan.title,
        description,
        payload: `ghost-plan:${request.body.plan}:${plan.stars}`,
        currency: "XTR",
        prices: [{ label, amount: plan.stars }]
      });
      return responseJson(response, 200, { ok: true, invoiceUrl });
    } else {
      return responseJson(response, 400, { ok: false, message: "Unknown Mini App action." });
    }
    return responseJson(response, 200, { ok: true });
  } catch (error) {
    console.error("Mini App action error", error);
    return responseJson(response, 401, { ok: false, message: error.message || "Unable to process Mini App action." });
  }
}
