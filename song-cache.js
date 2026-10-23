// Постоянный кэш треков на диске. Самозалитые треки не меняются, поэтому
// один раз скачанный трек навсегда играет мгновенно — чистый file:// без сети.
// Файлы лежат в userData/song-cache (вне asar), общий лимит на объём,
// вылетевшие за лимит файлы чистим по старости (LRU по mtime).
// Скачиваем только прямые ссылки (mp3/aac): они и играют через <audio>,
// и не требуют прогрева сегментов, в отличие от HLS.

const electron = require('electron');
const fs = require('fs');
const path = require('path');
const { finished } = require('stream/promises');
const { Readable } = require('stream');

const MAX_CACHE_BYTES = 6 * 1024 * 1024 * 1024; // дефолт, меняется через setLimit
let maxBytes = MAX_CACHE_BYTES;                  // актуальный лимит (настройки)
const MAX_FILE_BYTES = 256 * 1024 * 1024;        // защита от мусора в ответе
const MAX_CONCURRENT = 3;                        // не душим сеть и не дразним ВК
const EXTS = ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wav'];
const SAFE_ID = /^-?\d+_\d+$/;

let cacheDir = '';
let index = new Map();        // id -> { file, bytes, ext }
let inflight = new Set();     // id уже в очереди/в работе
let runningJobs = 0;
let jobQueue = [];            // { id, url, ext, resolve }
const activeControllers = new Set(); // прерывание текущих загрузок

// Заголовки как у окна плеера (main.js правит headers только через webRequest,
// а session.fetch идёт мимо него) — CDN обязателен Referer и UA без Electron.
function cdnHeaders() {
  const ua = electron.session.defaultSession.getUserAgent() || '';
  return {
    'User-Agent': ua
      .replace(/\s*NK[_ -]?Player\/[\d.]+/gi, '')
      .replace(/\s*Electron\/[\d.]+/i, ''),
    'Referer': 'https://vk.ru/',
    'Accept': '*/*'
  };
}

function extFromUrl(u) {
  const m = String(u || '').split('?')[0].match(/\.(mp3|m4a|aac|mp4|ogg|opus|flac|wav)$/i);
  return m ? m[1].toLowerCase() : 'mp3';
}

// Один проход по папке при старте: собираем индекс, подметаем оборванные .part
function rebuildIndex() {
  index.clear();
  let entries;
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of entries) {
    const full = path.join(cacheDir, e.name);
    if (e.name.endsWith('.part')) {
      try { fs.unlinkSync(full); } catch (err) { /* не критично */ }
      continue;
    }
    if (!e.isFile()) continue;
    const dot = e.name.lastIndexOf('.');
    if (dot <= 0) continue;
    const id = e.name.slice(0, dot);
    const ext = e.name.slice(dot + 1).toLowerCase();
    if (!SAFE_ID.test(id) || !EXTS.includes(ext)) continue;
    let bytes = 0;
    try {
      bytes = fs.statSync(full).size;
    } catch (err) {
      continue;
    }
    if (bytes < 1024) {
      // Обрезанный при прошлом запуске файл не годится для воспроизведения
      try { fs.unlinkSync(full); } catch (err) { /* ок */ }
      continue;
    }
    index.set(id, { file: e.name, bytes, ext });
  }
}

function init(userDataDir) {
  cacheDir = path.join(userDataDir, 'song-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  rebuildIndex();
}

// Возвращает { url: "file:///..." } или null. Быстро, синхронно.
function get(id) {
  const hit = index.get(String(id || ''));
  if (!hit) return null;
  const full = path.join(cacheDir, hit.file);
  // Свежий mtime = живой трек для LRU-чистки
  try {
    const now = new Date();
    fs.utimesSync(full, now, now);
  } catch (err) { /* читаем как есть */ }
  return { url: require('url').pathToFileURL(full).href };
}

function enforceLimit() {
  let total = 0;
  for (const v of index.values()) total += v.bytes;
  if (total <= maxBytes) return;

  const byAge = [...index.entries()]
    .map(([id, v]) => {
      let m = 0;
      try { m = fs.statSync(path.join(cacheDir, v.file)).mtimeMs; } catch (err) { m = 0; }
      return { id, m };
    })
    .sort((a, b) => a.m - b.m);

  for (const e of byAge) {
    if (total <= maxBytes) break;
    const v = index.get(e.id);
    if (!v) continue;
    try { fs.unlinkSync(path.join(cacheDir, v.file)); } catch (err) { /* уже нет */ }
    total -= v.bytes;
    index.delete(e.id);
  }
}

// Лимит из настроек: слайдер 50 МБ … 20 ГБ (UI ограничен 5 ГБ, запас — на будущее)
function setLimit(bytes) {
  const MIN = 50 * 1024 * 1024;
  const MAX = 20 * 1024 * 1024 * 1024;
  if (!Number.isFinite(bytes)) return;
  maxBytes = Math.min(MAX, Math.max(MIN, Math.round(bytes)));
  enforceLimit();
}

function stats() {
  let bytes = 0;
  for (const v of index.values()) bytes += v.bytes;
  return { count: index.size, bytes, limitBytes: maxBytes };
}

// Ручная очистка: глушим текущие загрузки и очередь, сносим все файлы
function clear() {
  for (const c of activeControllers) {
    try { c.abort(); } catch (err) { /* ок */ }
  }
  const pending = jobQueue;
  jobQueue = [];
  pending.forEach((j) => { try { j.resolve(null); } catch (err) { /* ок */ } });
  inflight.clear();
  index.clear();

  let files;
  try { files = fs.readdirSync(cacheDir); } catch (err) { return { count: 0 }; }
  let count = 0;
  for (const f of files) {
    try { fs.unlinkSync(path.join(cacheDir, f)); count++; } catch (err) { /* занятый файл пропустим */ }
  }
  return { count };
}

function processQueue() {
  while (runningJobs < MAX_CONCURRENT && jobQueue.length) {
    const job = jobQueue.shift();
    runningJobs++;
    runDownload(job)
      .then((res) => job.resolve(res))
      .catch(() => job.resolve(null))
      .finally(() => {
        runningJobs--;
        processQueue();
      });
  }
}

async function runDownload(job) {
  if (index.has(job.id)) return get(job.id);

  const controller = new AbortController();
  activeControllers.add(controller);
  const part = path.join(cacheDir, `${job.id}.${job.ext}.part`);
  try {
    const ses = electron.session.defaultSession;
    const res = await ses.fetch(job.url, { headers: cdnHeaders(), signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`Кач: HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_FILE_BYTES) throw new Error('Кач: файл великоват');

    await finished(Readable.fromWeb(res.body).pipe(fs.createWriteStream(part)));

    const bytes = fs.statSync(part).size;
    if (bytes < 1024) throw new Error('Кач: файл пуст');

    const file = `${job.id}.${job.ext}`;
    try { fs.unlinkSync(path.join(cacheDir, file)); } catch (err) { /* ок */ }
    fs.renameSync(part, path.join(cacheDir, file));
    index.set(job.id, { file, bytes, ext: job.ext });
    enforceLimit();
    return get(job.id);
  } finally {
    activeControllers.delete(controller);
    // Оборванная загрузка не должна оставаться мусором
    try { fs.unlinkSync(part); } catch (err) { /* переименован — ок */ }
  }
}

// Ставит трек на скачивание в фоне. Возврат Promise<{url}|null>, null — отказ.
// Повторный запрос того же id: если задача уже в очереди — ответом станет null
// (она и так докачается, дублировать не нужно).
function store(id, url) {
  id = String(id || '');
  url = String(url || '');
  if (!SAFE_ID.test(id) || !/^https:\/\//i.test(url)) return Promise.resolve(null);
  if (index.has(id)) return Promise.resolve(get(id));
  if (inflight.has(id) || jobQueue.some((j) => j.id === id)) return Promise.resolve(null);

  return new Promise((resolve) => {
    jobQueue.push({
      id, url, ext: extFromUrl(url),
      resolve: (val) => { inflight.delete(id); resolve(val); }
    });
    processQueue();
  });
}

function drop(id) {
  const hit = index.get(String(id || ''));
  if (!hit) return;
  try { fs.unlinkSync(path.join(cacheDir, hit.file)); } catch (err) { /* ок */ }
  index.delete(String(id));
}

module.exports = { init, get, store, drop, setLimit, clear, stats };
