/** Minimal dedicated support-bot intake. Set SUPPORT_ADMIN_CHAT_ID to enable operator forwarding. */
const token = process.env.SUPPORT_BOT_TOKEN;
if (!token) throw new Error("SUPPORT_BOT_TOKEN is not configured");
const adminChatId = process.env.SUPPORT_ADMIN_CHAT_ID;
let offset = 0;

async function call(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!data.ok) throw new Error(`${method}: ${data.description || "Telegram API error"}`);
  return data.result;
}

await call("deleteWebhook", { drop_pending_updates: false });
console.log("Ghost support intake started.");
while (true) {
  try {
    const updates = await call("getUpdates", { offset, timeout: 45, allowed_updates: ["message"] });
    for (const update of updates) {
      offset = update.update_id + 1;
      const message = update.message;
      if (!message) continue;
      if (message.text?.startsWith("/start")) {
        await call("sendMessage", { chat_id: message.chat.id, text: "👋 <b>Поддержка Ghost</b>\n\nОпишите проблему и приложите скриншот, если он поможет. Мы передадим обращение команде.", parse_mode: "HTML" });
        continue;
      }
      if (adminChatId) await call("forwardMessage", { chat_id: adminChatId, from_chat_id: message.chat.id, message_id: message.message_id });
      await call("sendMessage", { chat_id: message.chat.id, text: adminChatId ? "✓ Обращение получено. Команда Ghost ответит здесь." : "✓ Обращение получено. Поддержка Ghost подключается — ответим, как только оператор будет на связи." });
    }
  } catch (error) {
    console.error("Support polling failed", error);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
