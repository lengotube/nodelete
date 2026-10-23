#!/usr/bin/env bash
# Sets up the Mini App dashboard API on the bot VPS:
#   1. updates the bot code (git pull, or downloads the changed files from GitHub),
#   2. installs Caddy and serves the Ghost Mini App and payment callback routes,
#   3. restarts the bot in PM2 and checks the endpoint.
#
# Usage (as root on the server):
#   curl -fsSL https://raw.githubusercontent.com/lengotube/nodelete/main/deploy/setup-dashboard-api.sh | bash
#
# Optional variables: BOT_DIR, PM2_NAME, DOMAIN, PORT, BRANCH.
set -euo pipefail

BOT_DIR="${BOT_DIR:-/root/nodelete_robot}"
PM2_NAME="${PM2_NAME:-nodelete_robot}"
PORT="${PORT:-8787}"
BRANCH="${BRANCH:-main}"
RAW="https://raw.githubusercontent.com/lengotube/nodelete/${BRANCH}"

say() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" = "0" ] || { echo "Запустите от root."; exit 1; }
[ -d "$BOT_DIR" ] || { echo "Папка бота $BOT_DIR не найдена. Укажите её: BOT_DIR=/путь/к/боту bash setup-dashboard-api.sh"; exit 1; }

if [ -z "${DOMAIN:-}" ]; then
  IP="$(curl -fsS4 https://api.ipify.org || hostname -I | awk '{print $1}')"
  DOMAIN="${IP//./-}.sslip.io"
fi
say "Домен API: $DOMAIN"

say "Обновляю код бота в $BOT_DIR"
if [ -d "$BOT_DIR/.git" ]; then
  git -C "$BOT_DIR" pull --ff-only
else
  STAMP="$(date +%Y%m%d-%H%M%S)"
  for file in api/telegram.js src/runner.js src/dashboard-api.js package.json; do
    mkdir -p "$BOT_DIR/$(dirname "$file")"
    [ -f "$BOT_DIR/$file" ] && cp "$BOT_DIR/$file" "$BOT_DIR/$file.bak-$STAMP"
    curl -fsSL "$RAW/$file" -o "$BOT_DIR/$file"
  done
  echo "Старые версии файлов сохранены с суффиксом .bak-$STAMP"
fi
(cd "$BOT_DIR" && node --check api/telegram.js && node --check src/runner.js && node --check src/dashboard-api.js)

if ! command -v caddy >/dev/null 2>&1; then
  say "Устанавливаю Caddy (HTTPS-прокси с автоматическим сертификатом)"
  apt-get update -y
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

say "Настраиваю Caddy"
CADDYFILE=/etc/caddy/Caddyfile
BLOCK="# ghost-dashboard-api
$DOMAIN {
	@api path /api/dashboard /api/funnel /api/crypto /api/platega-callback /health
	handle @api {
		reverse_proxy 127.0.0.1:$PORT
	}
	handle {
		respond 404
	}
}"
if [ -f "$CADDYFILE" ] && grep -q "ghost-dashboard-api" "$CADDYFILE"; then
  echo "Блок для Ghost уже есть в $CADDYFILE — оставляю как есть."
elif [ -f "$CADDYFILE" ] && grep -qE '^\s*:80\s*\{' "$CADDYFILE" && [ "$(grep -cvE '^\s*(#.*)?$' "$CADDYFILE")" -lt 10 ]; then
  cp "$CADDYFILE" "$CADDYFILE.bak"
  printf '%s\n' "$BLOCK" > "$CADDYFILE"   # стандартный файл-заглушка Caddy заменяем
else
  [ -f "$CADDYFILE" ] && cp "$CADDYFILE" "$CADDYFILE.bak"
  printf '\n%s\n' "$BLOCK" >> "$CADDYFILE"
fi
caddy validate --config "$CADDYFILE" --adapter caddyfile
systemctl enable --now caddy
systemctl reload caddy

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  say "Открываю порты 80 и 443 в ufw"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

say "Перезапускаю бота ($PM2_NAME)"
pm2 restart "$PM2_NAME" --update-env
sleep 3

say "Проверяю"
curl -fsS "http://127.0.0.1:$PORT/health" && echo "  ← API внутри сервера работает"
for i in 1 2 3 4 5 6; do
  if curl -fsS "https://$DOMAIN/health" >/dev/null 2>&1; then
    echo "https://$DOMAIN/health работает — готово!"
    exit 0
  fi
  echo "Жду выпуска HTTPS-сертификата... ($i/6)"
  sleep 10
done
echo "HTTPS пока не отвечает. Проверьте, что порты 80 и 443 открыты у хостинга, и посмотрите: journalctl -u caddy -n 50"
exit 1
