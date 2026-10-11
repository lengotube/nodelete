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
await call("setMyCommands", {
  language_code: "ru",
  commands: [
    { command: "start", description: "Открыть Ghost" },
    { command: "archive", description: "Резервные копии" },
    { command: "my_data", description: "Управление моими данными" },
    { command: "help", description: "Помощь" }
  ]
});

const me = await call("getMe", {});
console.log(JSON.stringify({ username: me.username, firstName: me.first_name }));
