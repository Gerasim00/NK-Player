const { Client } = require('@xhayper/discord-rpc');

// Публичный Application ID из Discord Developer Portal. Не секрет — его видно
// в каждом статусе, который приложение показывает в Discord.
const CLIENT_ID = '1561806948389617684';

// Discord отбрасывает статус, если обновлять его чаще 5 раз за 20 секунд.
// Держим запас и шлём не чаще раза в 4.5 с.
const MIN_INTERVAL = 4500;

// Внешние картинки в обложке статуса Discord принимает в API (эхо возвращает
// assets.large_url), но клиент их не рисует — вместо обложки показывается
// иконка приложения. Поэтому по умолчанию используем статичный логотип.
// Включайте, если Discord начнёт их отображать.
const USE_COVER_ART = false;

// Ключи картинок должны совпадать с загруженными в Rich Presence → Art Assets.
// Если ассеты не загружены, Discord молча выбрасывает эти ключи (в ответе их
// нет) — статус всё равно уходит, просто без маленького значка.
const IMG_LOGO = 'nk_logo';
const IMG_PLAY = 'nk_play';
const IMG_PAUSE = 'nk_pause';

let client = null;
let ready = false;
let enabled = true;
let pending = null;
let lastSent = 0;
let lastKey = '';
let throttleTimer = null;
let retryTimer = null;
let quitting = false;

// ---------------------------------------------------------------- Подключение

function start() {
  if (client || quitting || !enabled) return;

  client = new Client({ clientId: CLIENT_ID });

  client.on('ready', () => {
    ready = true;
    lastKey = '';       // после переподключения статус нужно отправить заново
    flush();
  });

  client.on('disconnected', () => {
    ready = false;
    client = null;
    scheduleRetry();
  });

  // Discord может быть просто не запущен — это штатная ситуация, приложение
  // обязано работать дальше, поэтому здесь только тихая попытка переподключения.
  client.login().catch(() => {
    ready = false;
    client = null;
    scheduleRetry();
  });
}

function scheduleRetry() {
  if (quitting || !enabled || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    start();
  }, 15000);
}

function stop() {
  clearTimeout(throttleTimer);
  clearTimeout(retryTimer);
  throttleTimer = null;
  retryTimer = null;
  if (client) {
    try { client.destroy().catch(() => {}); } catch (e) { /* уже отключён */ }
  }
  client = null;
  ready = false;
  lastKey = '';
}

// Полное выключение на время работы приложения — в отличие от stop() не даёт
// таймеру переподключения запустить клиент снова.
function shutdown() {
  quitting = true;
  stop();
}

// ---------------------------------------------------------------- Активность

function clamp(value, fallback) {
  const str = String(value == null ? '' : value).trim();
  // Discord отклоняет строки короче двух символов — подставляем заглушку
  if (str.length < 2) return fallback;
  return str.slice(0, 128);
}

function buildActivity(p) {
  const pos = Math.max(0, Number(p.position) || 0);
  const dur = Math.max(0, Number(p.duration) || 0);

  const act = {
    type: 2,                                  // 2 = «Слушает»
    details: clamp(p.artist, 'NK Player'),
    state: clamp(p.title, 'Слушает музыку'),
    instance: false,
    buttons: [{ label: 'Слушать в ВК', url: 'https://vk.ru/audio' }]
  };

  // Обложка альбома, если ВК отдал публичную ссылку
  if (USE_COVER_ART && /^https:\/\//.test(String(p.cover || ''))) {
    act.largeImageUrl = p.cover;
    act.largeImageText = clamp(`${p.artist} — ${p.title}`, 'NK Player');
  } else {
    act.largeImageKey = IMG_LOGO;
    act.largeImageText = 'NK Player';
  }

  act.smallImageKey = p.paused ? IMG_PAUSE : IMG_PLAY;
  act.smallImageText = p.paused ? 'Пауза' : 'Играет';

  // На паузе таймстемпы не отправляем: Discord всё равно продолжил бы считать
  // время, и полоска уезжала бы вперёд при остановленном треке.
  if (dur > 0 && !p.paused) {
    const now = Date.now();
    act.startTimestamp = now - pos * 1000;
    act.endTimestamp = now + Math.max(0, dur - pos) * 1000;
  }
  return act;
}

function update(payload) {
  pending = payload || null;
  schedule();
}

function schedule() {
  if (!ready || throttleTimer) return;
  const wait = Math.max(0, MIN_INTERVAL - (Date.now() - lastSent));
  throttleTimer = setTimeout(() => {
    throttleTimer = null;
    flush();
  }, wait);
}

function flush() {
  if (!ready || !client || !client.user) return;

  if (!pending) {
    lastKey = '';
    lastSent = Date.now();
    client.user.clearActivity().catch(() => {});
    return;
  }

  // Перемотка и смена позиции дают тот же самый статус — такие апдейты
  // не тратят лимит запросов впустую.
  const key = `${pending.artist}|${pending.title}|${pending.paused}|${pending.cover || ''}`;
  if (key === lastKey) return;
  lastKey = key;

  lastSent = Date.now();
  client.user.setActivity(buildActivity(pending)).catch(() => {});
}

// ---------------------------------------------------------------- Управление

function setEnabled(on) {
  enabled = !!on;
  if (!enabled) {
    stop();
    return;
  }
  start();
}

function status() {
  return { enabled, connected: ready };
}

module.exports = { start, stop, shutdown, update, setEnabled, status };
