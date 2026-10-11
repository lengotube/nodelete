/**
 * One-off, local configuration for Telegram. Do not run this in Vercel.
 * Required environment: TELEGRAM_BOT_TOKEN, PUBLIC_APP_URL, WEBHOOK_SECRET.
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
const appUrl = process.env.PUBLIC_APP_URL?.replace(/\/$/, "");
const secret = process.env.WEBHOOK_SECRET;

if (!token || !appUrl || !secret) {
  throw new Error("Set TELEGRAM_BOT_TOKEN, PUBLIC_APP_URL and WEBHOOK_SECRET before running setup.");
}

const call = async (method, payload) => {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!data.ok) throw new Error(`${method}: ${data.description || "Telegram API error"}`);
  return data.result;
};

await call("setWebhook", {
  url: `${appUrl}/api/telegram`,
  secret_token: secret,
  allowed_updates: [
    "message",
    "callback_query",
    "business_connection",
    "business_message",
    "edited_business_message",
    "deleted_business_messages"
  ],
  drop_pending_updates: false
});

await call("setChatMenuButton", {
  menu_button: { type: "web_app", text: "NoDelete", web_app: { url: `${appUrl}/app` } }
});

console.log("Webhook and Mini App menu button configured successfully.");
