/** VPS runner: receives Telegram updates by long polling; no public webhook is needed. */
import { processUpdate } from "../api/telegram.js";
import { startDashboardApi } from "./dashboard-api.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
const allowed_updates = ["message", "callback_query", "pre_checkout_query", "business_connection", "business_message", "edited_business_message", "deleted_business_messages"];
let offset = 0;
let stopping = false;
let dashboard = null;
const stop = () => { stopping = true; dashboard?.close(); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!data.ok) throw new Error(`${method}: ${data.description || "Telegram API error"}`);
  return data.result;
}

if (process.env.DASHBOARD_PORT !== "0") dashboard = startDashboardApi();

await telegram("deleteWebhook", { drop_pending_updates: false });
console.log("Ghost runner started (long polling).");
while (!stopping) {
  try {
    const updates = await telegram("getUpdates", { offset, timeout: 45, allowed_updates });
    for (const update of updates) {
      offset = update.update_id + 1;
      try { await processUpdate(update); } catch (error) { console.error("Update failed", update.update_id, error); }
    }
  } catch (error) {
    console.error("Polling failed", error);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
