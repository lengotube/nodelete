/** One-time Telegram profile configuration for the production Ghost bot. */
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");

async function call(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!data.ok) throw new Error(`${method}: ${data.description || "Telegram API error"}`);
  return data.result;
}

await call("setMyName", { name: "Ghost | Удаленные сообщения", language_code: "ru" });
await call("setMyDescription", {
  language_code: "ru",
  description: "Ghost помогает отслеживать новые изменения в разрешённых чатах и создавать резервные копии. Подключение — через официальную Автоматизацию чатов Telegram."
});
await call("setMyShortDescription", { language_code: "ru", short_description: "Контроль изменений и резервные копии чатов." });
await call("setMyName", { name: "Ghost | Deleted messages", language_code: "en" });
await call("setMyDescription", {
  language_code: "en",
  description: "Ghost helps track new changes in allowed chats and create backups. Connect it through Telegram's official Chat Automation."
});
await call("setMyShortDescription", { language_code: "en", short_description: "Chat change tracking and backups." });
await call("setMyCommands", {
  language_code: "ru",
  commands: [
    { command: "start", description: "Открыть Ghost" },
    { command: "archive", description: "Резервные копии" },
    { command: "my_data", description: "Управление моими данными" },
    { command: "help", description: "Помощь" }
  ]
});
await call("setMyCommands", {
  language_code: "en",
  commands: [
    { command: "start", description: "Open Ghost" },
    { command: "archive", description: "Backups" },
    { command: "my_data", description: "Manage my data" },
    { command: "help", description: "Help" }
  ]
});

if (process.env.PUBLIC_APP_URL) {
  await call("setChatMenuButton", {
    menu_button: { type: "web_app", text: "Ghost", web_app: { url: `${process.env.PUBLIC_APP_URL.replace(/\/$/, "")}/app` } }
  });
}

const me = await call("getMe", {});
console.log(JSON.stringify({ username: me.username, firstName: me.first_name }));
