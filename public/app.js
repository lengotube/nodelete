const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const screen = document.querySelector("#screen");
const state = { page: new URLSearchParams(location.search).get("screen") || "home", theme: localStorage.getItem("nodelete-theme") || "dark" };
const pages = new Set(["home", "connect", "backup", "groups", "help", "safety", "plans", "settings"]);

const go = (page) => {
  state.page = pages.has(page) ? page : "home";
  const url = new URL(location.href);
  url.searchParams.set("screen", state.page);
  history.replaceState({}, "", url);
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
};

const copy = async () => {
  await navigator.clipboard?.writeText("@nodelete_robot");
  const button = document.querySelector("[data-copy]");
  if (button) { button.textContent = "Скопировано ✓"; setTimeout(() => { button.textContent = "Копировать"; }, 1500); }
};

const support = () => {
  tg?.showAlert?.("Поддержка подключается. Здесь появится ссылка на аккаунт команды.");
  if (!tg?.showAlert) alert("Поддержка подключается. Здесь появится ссылка на аккаунт команды.");
};

const hero = () => `
  <section class="hero">
    <p class="eyebrow">контроль ваших чатов</p>
    <h1>Удалили или изменили сообщение?</h1>
    <p>NoDelete бережно фиксирует новые события, которые Telegram передаёт после подключения.</p>
    <div class="hero-grid"><div class="mini-stat"><strong>30 сек.</strong><span>на подключение</span></div><div class="mini-stat"><strong>90 дней</strong><span>срок хранения</span></div></div>
    <button class="primary" data-go="connect">⚙ Подключить NoDelete <span>→</span></button>
  </section>`;

const dashboard = () => `
  <section class="dashboard">
    <div class="profile"><div class="avatar-letter">N</div><div><strong>Ваш контроль</strong><small>Подключение ожидает</small></div><span class="status">●</span></div>
    <div class="dashboard-actions">
      <button class="action-row" data-go="connect"><span class="row-icon">⌁</span><span class="row-copy"><strong>Личные сообщения</strong><small>Подключите Chat automation</small></span><span class="chevron">›</span></button>
      <button class="action-row" data-go="groups"><span class="row-icon">+</span><span class="row-copy"><strong>Группы</strong><small>Инструкция для администратора</small></span><span class="chevron">›</span></button>
      <button class="action-row" data-go="backup"><span class="row-icon">▣</span><span class="row-copy"><strong>Резервные копии</strong><small>Выберите нужные переписки</small></span><span class="chevron">›</span></button>
    </div>
    <div class="statline"><span><i class="dot"></i>0 удалений</span><span><i class="dot blue"></i>0 правок</span></div>
  </section>`;

const home = () => `${hero()}
  <section class="section"><p class="section-label">Как это работает</p><h2>Не магия. Официальный доступ Telegram.</h2><p class="section-intro">После явного подключения Telegram присылает боту новые сообщения и события об их изменении. История до подключения недоступна.</p>
  <div class="feature-grid"><article class="card"><div class="feature-icon">✎</div><h3>Изменения</h3><p>Сравнивайте текст до и после редактирования.</p></article><article class="card"><div class="feature-icon">◌</div><h3>Удаления</h3><p>Получайте копию, если сообщение удалили.</p></article><article class="card"><div class="feature-icon">▣</div><h3>Архив</h3><p>Выбирайте чаты для резервного хранения.</p></article></div></section>
  <section class="section"><p class="section-label">Панель управления</p>${dashboard()}</section>
  <section class="section notice"><strong>Ваши данные — под вашим контролем.</strong><br>В Mini App доступны инструкции, управление подключением и удаление сохранённых данных.</section>
  ${supportButton()}`;

const pageHead = (title, intro) => `<button class="back" data-go="home">← На главную</button><section class="page-head"><h1>${title}</h1><p>${intro}</p></section>`;
const supportButton = () => `<button class="support-button" data-support><span class="pulse"></span> 💬 Поддержка 24/7 <span>›</span></button>`;

const connect = () => `${pageHead("Подключить за 30 секунд", "NoDelete начнёт обрабатывать события только после того, как вы сами добавите его в Автоматизацию чатов Telegram.")}
  <div class="step-list">
    <article class="step"><span class="step-num">1</span><div><strong>Скопируйте username</strong><p>Он понадобится в настройках Telegram.</p><span class="code-chip">@nodelete_robot <button data-copy>Копировать</button></span></div></article>
    <article class="step"><span class="step-num">2</span><div><strong>Откройте профиль Telegram</strong><p>Нажмите «Изменить» в верхней части своего профиля.</p></div></article>
    <article class="step"><span class="step-num">3</span><div><strong>Найдите «Автоматизация чатов»</strong><p>Прокрутите список настроек вниз до этого пункта.</p></div></article>
    <article class="step"><span class="step-num">4</span><div><strong>Добавьте @nodelete_robot</strong><p>Вставьте username, выберите доступные чаты и подтвердите подключение.</p></div></article>
  </div>
  <section class="section notice"><strong>Важно.</strong> Сообщения, отправленные до подключения, Telegram боту не передаёт. Это ограничение платформы.</section>
  <a class="primary" href="tg://settings/edit">⚙ Открыть настройки Telegram <span>›</span></a>${supportButton()}`;

const backup = () => `${pageHead("Резервные копии", "Архив сохраняет новые сообщения выбранной переписки с момента подключения.")}
  <article class="info-card"><h3><span class="number-pill">1</span>Сначала подключите NoDelete</h3><p>Архивация использует то же подключение через Автоматизацию чатов. Без него Telegram не передаёт новые сообщения боту.</p></article>
  <article class="info-card"><h3><span class="number-pill">2</span>Выберите переписку</h3><p>В будущем здесь появится выбор чата и оплата архива. Можно будет включать несколько отдельных архивов.</p><div class="placeholder">⌛ Оплата и выбор чата находятся в подготовке.</div></article>
  <article class="info-card"><h3><span class="number-pill">3</span>Что попадает в архив</h3><ul><li>Новые сообщения и доступные Telegram вложения после подключения.</li><li>История до подключения не копируется.</li><li>Срок хранения по умолчанию — до 90 дней.</li></ul></article>
  <article class="info-card"><h3><span class="number-pill">4</span>Ваши данные</h3><p>Хранение и экспорт должны быть описаны в вашей политике конфиденциальности до публичного запуска. В боте доступна команда <code>/my_data</code> для удаления данных.</p></article>${supportButton()}`;

const groups = () => `${pageHead("Работа в группах", "Для групп нужны права администратора — это требование Telegram, а не дополнительный доступ NoDelete.")}
  <article class="info-card"><h3><span class="number-pill">1</span>Подключите группу</h3><p>Добавьте @nodelete_robot в нужную группу через список администраторов. Выбирайте только группы, которыми управляете.</p></article>
  <article class="info-card"><h3><span class="number-pill">2</span>Выдайте только нужные права</h3><p>Проверьте список разрешений в Telegram перед подтверждением. Не включайте функции, которые не нужны вашему сценарию.</p></article>
  <article class="info-card"><h3><span class="number-pill">3</span>Проверьте тестовым сообщением</h3><p>Отправьте сообщение после добавления бота, отредактируйте или удалите его и убедитесь, что уведомление пришло владельцу.</p></article>
  <section class="notice"><strong>Ограничение.</strong> NoDelete не получает историю, которая существовала до добавления, и не должен использоваться для мониторинга людей без их согласия.</section>${supportButton()}`;

const help = () => `${pageHead("Не приходит уведомление?", "Проверьте эти пункты — обычно проблема решается за минуту.")}
  <article class="info-card"><h3>1. Проверьте подключение</h3><p>В настройках профиля Telegram откройте «Автоматизация чатов» и убедитесь, что @nodelete_robot активен.</p></article>
  <article class="info-card"><h3>2. Проверьте время события</h3><p>Бот реагирует только на новые события после подключения. Старые сообщения не восстановить через Bot API.</p></article>
  <article class="info-card"><h3>3. Проверьте доступ чата</h3><p>В подключении должны быть разрешены нужные чаты. Для групп бот должен быть добавлен администратором.</p></article>
  <article class="info-card"><h3>4. Нужна помощь?</h3><p>Кнопка поддержки сейчас ведёт в заглушку. Замените ссылку в проекте после создания аккаунта поддержки.</p></article>${supportButton()}`;

const safety = () => `${pageHead("Это безопасно?", "Безопасность строится на прозрачных настройках, минимальном доступе и вашем контроле.")}
  <article class="info-card"><h3><span class="number-pill">1</span>Официальная функция Telegram</h3><p>Подключение происходит через встроенную Автоматизацию чатов / Business Bot API. Не нужен модифицированный клиент и не требуется пароль от аккаунта.</p><p><a href="https://t.me/durov/519">Открыть анонс Telegram ›</a></p></article>
  <article class="info-card"><h3><span class="number-pill">2</span>Только после подключения</h3><p>Bot API присылает только новые сообщения и изменения из разрешённых вами чатов. Переписка до подключения недоступна.</p></article>
  <article class="info-card"><h3><span class="number-pill">3</span>Шифрование перед хранением</h3><p>В этой сборке текст сообщения шифруется AES‑256‑GCM до записи в Vercel KV. Ключ хранится отдельно в переменных окружения.</p></article>
  <article class="info-card"><h3><span class="number-pill">4</span>Полный контроль</h3><p>Вы можете отключить автоматизацию в Telegram и удалить сохранённые данные командой <code>/my_data</code>.</p></article>${supportButton()}`;

const plans = () => `${pageHead("Тарифы", "Выберите формат доступа. Подключение оплаты будет добавлено отдельным этапом.")}
  <section class="plan-grid">
    <article class="card plan"><h3>Lite</h3><strong>180 ⭐</strong><small>Неделя</small><button class="secondary" data-payment>Выбрать</button></article>
    <article class="card plan"><h3>Plus</h3><strong>360 ⭐</strong><small>Месяц</small><button class="secondary" data-payment>Выбрать</button></article>
    <article class="card plan selected"><span class="badge">выгодно</span><h3>Prime</h3><strong>1700 ⭐</strong><small>Год</small><button class="secondary" data-payment>Выбрать</button></article>
    <article class="card plan"><h3>Ultra</h3><strong>4370 ⭐</strong><small>Навсегда</small><button class="secondary" data-payment>Выбрать</button></article>
  </section><section class="section placeholder">💳 Платёжный провайдер пока не подключён. Карточки показаны как интерфейсная заготовка и не создают списаний.</section>${supportButton()}`;

const settings = () => `${pageHead("Настройки", "Управляйте интерфейсом и переходами в сервисе.")}
  <section class="dashboard-actions"><button class="setting-row" data-support><span class="row-icon">◌</span><span class="row-copy"><strong>Поддержка</strong><small>Ссылка будет добавлена позже</small></span><span class="chevron">›</span></button><button class="setting-row" data-language><span class="row-icon">◎</span><span class="row-copy"><strong>Язык</strong><small>Русский</small></span><span class="chevron">›</span></button><button class="setting-row" id="theme-setting"><span class="row-icon">☾</span><span class="row-copy"><strong>Тема</strong><small>${state.theme === "light" ? "Светлая" : "Тёмная"}</small></span><span class="chevron">›</span></button></section>
  <section class="section"><p class="section-label">Данные</p><button class="setting-row" data-go="safety"><span class="row-icon">⌁</span><span class="row-copy"><strong>О безопасности</strong><small>Доступ, хранение и удаление</small></span><span class="chevron">›</span></button></section>${supportButton()}`;

const languages = () => `<section class="section"><p class="section-label">Язык</p><div class="language-list">${["🇷🇺 Русский", "🇬🇧 English", "🇺🇦 Українська", "🇪🇸 Español", "🇺🇿 O‘zbek"].map((name, index) => `<button class="action-row language ${index === 0 ? "selected" : ""}" data-language><span>${name}</span><span class="check">${index === 0 ? "✓" : ""}</span></button>`).join("")}</div></section>`;

const templates = { home, connect, backup, groups, help, safety, plans, settings };
function render() {
  document.body.classList.toggle("light", state.theme === "light");
  screen.innerHTML = templates[state.page]();
  document.querySelectorAll("[data-go]").forEach((element) => element.addEventListener("click", () => go(element.dataset.go)));
  document.querySelectorAll("[data-copy]").forEach((element) => element.addEventListener("click", copy));
  document.querySelectorAll("[data-support]").forEach((element) => element.addEventListener("click", support));
  document.querySelectorAll("[data-payment]").forEach((element) => element.addEventListener("click", () => tg?.showAlert?.("Оплата в разработке.") || alert("Оплата в разработке.")));
  document.querySelectorAll("[data-language]").forEach((element) => element.addEventListener("click", () => { const existing = document.querySelector(".language-list"); if (existing) return; screen.insertAdjacentHTML("beforeend", languages()); document.querySelectorAll("[data-language]").forEach((button) => button.addEventListener("click", () => {})); }));
  document.querySelector("#theme-setting")?.addEventListener("click", toggleTheme);
  document.querySelectorAll(".bottom-nav [data-go]").forEach((element) => element.classList.toggle("active", element.dataset.go === state.page || (state.page === "connect" && element.dataset.go === "home")));
}
function toggleTheme() { state.theme = state.theme === "light" ? "dark" : "light"; localStorage.setItem("nodelete-theme", state.theme); render(); }
document.querySelector("#theme-toggle").addEventListener("click", toggleTheme);
document.querySelectorAll(".bottom-nav [data-go]").forEach((element) => element.addEventListener("click", () => go(element.dataset.go)));
render();
