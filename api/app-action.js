import { createHmac, timingSafeEqual } from "node:crypto";

const API = "https://api.telegram.org";
const BRAND = process.env.BOT_BRAND || "Ghost";
const SUPPORT_URL = process.env.SUPPORT_URL || "https://t.me/ghostmsg_support_bot?start=help";

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
        text: `Откройте <a href="tg://settings/edit">настройки профиля Telegram</a>, найдите «Автоматизация чатов» и добавьте <code>@${process.env.BOT_USERNAME || "ghostmsg_robot"}</code>.`,
        parse_mode: "HTML"
      });
    } else if (action === "support") {
      await telegram("sendMessage", {
        chat_id: user.id,
        text: `Поддержка ${BRAND} готова помочь. Откройте чат — команда увидит ваше сообщение.`,
        reply_markup: { inline_keyboard: [[{ text: "💬 Написать в поддержку", url: SUPPORT_URL }]] }
      });
    } else {
      return responseJson(response, 400, { ok: false, message: "Unknown Mini App action." });
    }
    return responseJson(response, 200, { ok: true });
  } catch (error) {
    console.error("Mini App action error", error);
    return responseJson(response, 401, { ok: false, message: error.message || "Unable to process Mini App action." });
  }
}
