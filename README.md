# Ghost — `@ghostmsg_robot`

Ghost — Telegram-бот и Mini App для контроля новых разрешённых событий и резервных копий. Владелец аккаунта самостоятельно подключает бота через «Автоматизацию чатов», после чего бот получает только те новые события, которые Telegram разрешает передавать. История до подключения недоступна.

## Что уже сделано

- Приветствие `/start` на русском и английском, с Premium Emoji и нативными кнопками Telegram.
- Обработка событий Telegram Business: новое сообщение, изменение и удаление.
- Шифрование текста AES-256-GCM перед сохранением.
- Команда `/my_data` с удалением данных пользователя.
- Адаптивное Mini App в фирменной стилистике Ghost: подключение, безопасность, помощь, группы, резервные копии, тарифы, язык и темы.
- Оплата цифровых тарифов через Telegram Stars: Lite, Plus, Prime и Ultra. Доступ фиксируется только после `successful_payment`.
- Отдельный бот поддержки `@ghostmsg_support_bot` с приёмом текстов, медиа и скриншотов.

## Деплой Mini App на Vercel

1. Создайте репозиторий на GitHub и загрузите в него содержимое этой папки.
2. Откройте [vercel.com](https://vercel.com), войдите через GitHub и нажмите **Add New → Project**.
3. Выберите репозиторий `nodelete`, оставьте настройки сборки пустыми и нажмите **Deploy**. Это статический сайт, пакеты устанавливать не нужно.
4. После завершения скопируйте адрес вида `https://nodelete-robot-xxx.vercel.app`.
5. В настройках Vercel откройте **Settings → Environment Variables** и добавьте `PUBLIC_APP_URL` со скопированным адресом. Затем сделайте **Redeploy**.
6. В @BotFather откройте настройки `@ghostmsg_robot` → **Menu Button** и укажите `https://ваш-домен.vercel.app/app`.

## Запуск бота на VPS

На сервере бот работает через long polling: отдельный HTTPS-домен для бота не нужен. В `.env` на сервере должны быть:

```env
TELEGRAM_BOT_TOKEN=...
BOT_USERNAME=ghostmsg_robot
BOT_BRAND=Ghost
ARCHIVE_ENCRYPTION_KEY=... # 32-байтное значение base64
LOCAL_DATA_FILE=/root/nodelete_robot/data/store.json
PUBLIC_APP_URL=https://ваш-домен.vercel.app
SUPPORT_URL=https://t.me/ghostmsg_support_bot
SUPPORT_BOT_TOKEN=...
# Необязательно: numeric ID оператора или приватной группы поддержки
SUPPORT_ADMIN_CHAT_ID=...
ADMIN_IDS=7822690557
```

Команда запуска: `npm start`. Для постоянной работы используется процесс PM2 с именем `nodelete_robot`.

## Важные ограничения Telegram

- Бот получает и сохраняет только события после явного подключения владельцем.
- Владелец может отключить автоматизацию в Telegram и удалить данные командой `/my_data`.
- Для групп необходимы права, которые Telegram отображает при добавлении бота; старую историю бот не получает.

## Stars и поддержка

- Для Stars не нужен внешний платёжный провайдер: кнопки Mini App открывают `@ghostmsg_robot?start=buy_<тариф>`, а бот формирует инвойс в `XTR`.
- Не выдавайте доступ до события `successful_payment`; это уже реализовано в `api/telegram.js`.
- Чтобы обращения из `@ghostmsg_support_bot` автоматически приходили оператору, задайте `SUPPORT_ADMIN_CHAT_ID` и перезапустите процесс `ghost_support` в PM2. Пока ID не задан, бот подтверждает получение обращения, но не пересылает его команде.

## Админ-панель

`/admin` доступна только ID из `ADMIN_IDS`. В ней есть рассылка, актуальная статистика Stars/пользователей, выгрузка ID в `ghost-users.txt` и очистка базы рассылки от заблокировавших бота.

В разделе «Рефералы» создаётся ссылка `https://t.me/ghostmsg_robot?start=linkname`: после названия укажите цену за пользователя. Полная статистика доступна администратору по `/ref_linkname`; публичная — по `/refssilkacheck_linkname`.

## Экран статистики в Mini App

Главная Mini App показывает статус подключения, счётчики удалений и правок за сегодня и ленту последних событий. Данные отдаёт сам бот на VPS: процесс `src/runner.js` поднимает API на `127.0.0.1:8787` (`src/dashboard-api.js`), каждый запрос проверяется по подписи Telegram `initData`, поэтому пользователь видит только свои события. Vercel проксирует `/api/dashboard` на HTTPS-адрес сервера (см. `vercel.json`).

Настройка сервера одной командой (от root):

```bash
curl -fsSL https://raw.githubusercontent.com/lengotube/nodelete/main/deploy/setup-dashboard-api.sh | bash
```

Скрипт обновит код бота, поставит Caddy с автоматическим HTTPS-сертификатом для `<ip>.sslip.io`, перезапустит PM2-процесс и проверит API. Если у вас есть свой домен, передайте его: `DOMAIN=api.example.com bash setup-dashboard-api.sh` — и поменяйте адрес в `vercel.json`.

Для предпросмотра без сервера откройте `/app?demo=1`.
