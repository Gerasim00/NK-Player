// Постоянный кэш треков на диске. Самозалитые треки не меняются, поэтому
// один раз скачанный трек навсегда играет мгновенно — чистый file:// без сети.
// Файлы лежат в userData/song-cache (вне asar), общий лимит на объём,
// вылетевшие за лимит файлы чистим по давности использования (LRU).
// Скачиваем только прямые ссылки (mp3/aac): они и играют через <audio>,
// и не требуют прогрева сегментов, в отличие от HLS.

const electron = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { finished } = require('stream/promises');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');

const MAX_CACHE_BYTES = 6 * 1024 * 1024 * 1024; // дефолт, меняется через setLimit
let maxBytes = MAX_CACHE_BYTES;                  // актуальный лимит (настройки)
const MAX_FILE_BYTES = 256 * 1024 * 1024;        // защита от мусора в ответе
const MAX_CONCURRENT = 3;                        // не душим сеть и не дразним ВК
// Чистим не «ровно до лимита», а до 90%: иначе каждый новый трек вытесняет
// ровно один старый — кэш начинает пилить сам себя на каждом переключении.
const TRIM_RATIO = 0.9;
const SWEEP_MS = 5 * 60 * 1000;                  // повтор для файлов, занятых плеером
const PART_TTL_MS = 60 * 60 * 1000;              // брошенный .part старше часа — мусор
const INDEX_FILE = 'index.json';
const SAFE_ID = /^-?\d+_\d+$/;

let cacheDir = '';
let index = new Map();        // id -> { file, bytes, ext, used }
let inflight = new Set();     // id уже в очереди/в работе
let runningJobs = 0;
let jobQueue = [];            // { id, url, ext, resolve }
let pinned = new Set();       // id, которые нельзя вытеснять (играет и следующие)
let sweepTimer = null;
let saveTimer = null;
let ready = null;             // промис init(): до него папки ещё нет
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

// Расширение из пути ссылки. Знакомые аудио-форматы сохраняем как есть,
// всё остальное (в том числе `audio.php?…`) считаем mp3 — по нему <audio>
// и так определит контейнер.
const KNOWN_EXTS = new Set(['mp3', 'm4a', 'aac', 'mp4', 'ogg', 'opus']);
function extFromUrl(u) {
  const m = String(u || '').split('?')[0].match(/\.([a-z0-9]{2,4})$/i);
  const ext = m ? m[1].toLowerCase() : '';
  return KNOWN_EXTS.has(ext) ? ext : 'mp3';
}

function filePath(v) {
  return path.join(cacheDir, v.file);
}

// ---------------------------------------------------------------- Индекс

// Отдельный журнал давности: mtime файла трогать больше не нужно, а после
// переустановки/копирования профиля он всё равно врёт. Пишем отложенно.
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveIndex();
  }, 3000);
}

function saveIndex() {
  if (!cacheDir) return;
  const data = { version: 1, entries: {} };
  for (const [id, v] of index) data.entries[id] = { file: v.file, bytes: v.bytes, ext: v.ext, used: v.used };
  const tmp = path.join(cacheDir, INDEX_FILE + '.tmp');
  try {
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, path.join(cacheDir, INDEX_FILE));
  } catch (err) { /* индекс пересоберётся по файлам при следующем старте */ }
}

function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveIndex();
}

function loadSavedUsed() {
  const out = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cacheDir, INDEX_FILE), 'utf8'));
    const list = raw && raw.entries;
    if (!list) return out;
    for (const [id, v] of Object.entries(list)) {
      if (v && Number.isFinite(v.used)) out.set(id, v.used);
    }
  } catch (err) { /* нет журнала — обойдёмся mtime */ }
  return out;
}

// Проход по папке: собираем индекс, подметаем оборванные .part и мелочь.
// Файл узнаём по имени, а не по белому списку расширений: иначе mp4 из
// .mp4-ссылки (extFromUrl его умеет) навсегда выпадал из учёта.
async function rebuildIndex() {
  index.clear();
  const saved = loadSavedUsed();
  let entries;
  try {
    entries = await fsp.readdir(cacheDir, { withFileTypes: true });
  } catch (err) {
    return;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name === INDEX_FILE || e.name === INDEX_FILE + '.tmp') continue;
    const full = path.join(cacheDir, e.name);
    const dot = e.name.lastIndexOf('.');
    const ext = dot > 0 ? e.name.slice(dot + 1).toLowerCase() : '';
    if (ext === 'part') {
      await prunePart(full);
      continue;
    }
    const id = dot > 0 ? e.name.slice(0, dot) : '';
    if (!SAFE_ID.test(id)) continue;
    let st;
    try {
      st = await fsp.stat(full);
    } catch (err) {
      continue;
    }
    if (st.size < 1024) {
      // Обрезанный при прошлом запуске файл не годится для воспроизведения
      try { await fsp.unlink(full); } catch (err) { /* занят — уберёт sweep */ }
      continue;
    }
    index.set(id, {
      file: e.name,
      bytes: st.size,
      ext: ext || 'mp3',
      // Журнал важнее mtime: после копирования профиля mtime у всех файлов
      // одинаково свежий и порядок вытеснения теряется.
      used: saved.has(id) ? saved.get(id) : st.mtimeMs
    });
  }
}

// Брошенный .part (загрузка оборвалась) — мусор, но не раньше TTL:
// свежий файл может принадлежать идущей загрузке.
async function prunePart(full) {
  try {
    const st = await fsp.stat(full);
    if (Date.now() - st.mtimeMs > PART_TTL_MS) await fsp.unlink(full);
  } catch (err) { /* уже нет или занят */ }
}

// Сверка с диском: размеры, пропавшие файлы, забытые записи.
async function reconcile() {
  let entries;
  try {
    entries = await fsp.readdir(cacheDir, { withFileTypes: true });
  } catch (err) {
    return;
  }
  const onDisk = new Set();
  for (const e of entries) {
    if (!e.isFile() || e.name === INDEX_FILE || e.name === INDEX_FILE + '.tmp') continue;
    if (e.name.endsWith('.part')) {
      await prunePart(path.join(cacheDir, e.name));
      continue;
    }
    const dot = e.name.lastIndexOf('.');
    if (dot <= 0) continue;
    const id = e.name.slice(0, dot);
    if (!SAFE_ID.test(id)) continue;
    onDisk.add(id);
    let st;
    try { st = await fsp.stat(path.join(cacheDir, e.name)); } catch (err) { continue; }
    if (st.size < 1024) {
      // Обрезанный файл не сыграть — убираем, если не занят
      try { await fsp.unlink(path.join(cacheDir, e.name)); } catch (err) { /* занят */ }
      onDisk.delete(id);
      continue;
    }
    const known = index.get(id);
    if (known) {
      known.bytes = st.size;
      known.file = e.name;
    } else {
      // Файл есть, а в индексе его нет (индекс потеряли, расширение было
      // незнакомым) — принимаем в учёт по mtime, иначе он вечный сирота.
      index.set(id, { file: e.name, bytes: st.size, ext: e.name.slice(dot + 1).toLowerCase(), used: st.mtimeMs });
    }
  }
  for (const id of [...index.keys()]) {
    if (!onDisk.has(id)) index.delete(id);
  }
  scheduleSave();
}

// ---------------------------------------------------------------- Чтение

// Возвращает { url: "file:///..." } или null.
function get(id) {
  id = String(id || '');
  const hit = index.get(id);
  if (!hit) return null;
  const full = filePath(hit);
  if (!fs.existsSync(full)) {
    index.delete(id);
    scheduleSave();
    return null;
  }
  hit.used = Date.now();
  scheduleSave();
  return { url: pathToFileURL(full).href };
}

// ---------------------------------------------------------------- Вытеснение

function totalBytes() {
  let total = 0;
  for (const v of index.values()) total += v.bytes;
  return total;
}

// Удаляем самое давнее, пока не влезем в 90% лимита. Запись из индекса
// снимаем ТОЛЬКО после успешного удаления: на Windows файл, который сейчас
// читает медиастек, отдаёт EBUSY, и раньше он выпадал из учёта, оставаясь
// на диске — то есть занимал место, которое кэш считал свободным.
function enforceLimit() {
  let total = totalBytes();
  if (total <= maxBytes || !index.size) return;
  const target = maxBytes * TRIM_RATIO;

  const byAge = [...index.entries()].sort((a, b) => a[1].used - b[1].used);
  for (const [id, v] of byAge) {
    if (total <= target) break;
    if (pinned.has(id)) continue;
    try {
      fs.unlinkSync(filePath(v));
    } catch (err) {
      if (err.code === 'ENOENT') {
        total -= v.bytes;
        index.delete(id);
      }
      // Занят плеером — оставляем в индексе, повторим на sweep
      continue;
    }
    total -= v.bytes;
    index.delete(id);
  }
  scheduleSave();
}

async function sweep() {
  await reconcile();
  enforceLimit();
  saveIndex();
}

// ---------------------------------------------------------------- API

async function init(userDataDir) {
  cacheDir = path.join(userDataDir, 'song-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  ready = rebuildIndex().then(() => {
    enforceLimit(); // лимит мог уменьшиться, пока приложение было закрыто
    scheduleSave();
  });
  await ready;
  if (!sweepTimer) {
    sweepTimer = setInterval(() => { sweep().catch(() => {}); }, SWEEP_MS);
    if (sweepTimer.unref) sweepTimer.unref();
  }
}

// Лимит из настроек: слайдер 50 МБ … 20 ГБ (UI ограничен 5 ГБ, запас — на будущее)
function setLimit(bytes) {
  const MIN = 50 * 1024 * 1024;
  const MAX = 20 * 1024 * 1024 * 1024;
  if (!Number.isFinite(bytes)) return;
  maxBytes = Math.min(MAX, Math.max(MIN, Math.round(bytes)));
  enforceLimit();
  scheduleSave();
}

// Что нельзя вытеснять: текущий трек и ближайшие в очереди.
function setPinned(ids) {
  pinned = new Set((Array.isArray(ids) ? ids : []).map(String));
}

// Статистика честная — по факту на диске, а не по индексу: расхождение
// (занятый файл, потерянная запись) должно быть видно сразу.
function stats() {
  let bytes = 0;
  let count = 0;
  let diskBytes = 0;
  let entries = [];
  try { entries = fs.readdirSync(cacheDir, { withFileTypes: true }); } catch (err) { entries = []; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    let st;
    try { st = fs.statSync(path.join(cacheDir, e.name)); } catch (err) { continue; }
    diskBytes += st.size;
    if (e.name === INDEX_FILE || e.name === INDEX_FILE + '.tmp' || e.name.endsWith('.part')) continue;
    const dot = e.name.lastIndexOf('.');
    if (dot <= 0) continue;
    const id = e.name.slice(0, dot);
    if (!SAFE_ID.test(id)) continue;
    bytes += st.size;
    count++;
  }
  return { count, bytes, diskBytes, limitBytes: maxBytes, pinned: pinned.size };
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
  pinned.clear();

  let files;
  try { files = fs.readdirSync(cacheDir); } catch (err) { return { count: 0 }; }
  let count = 0;
  for (const f of files) {
    try { fs.unlinkSync(path.join(cacheDir, f)); count++; } catch (err) { /* занятый файл пропустим */ }
  }
  scheduleSave();
  return { count };
}

// ---------------------------------------------------------------- Загрузка

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
    index.set(job.id, { file, bytes, ext: job.ext, used: Date.now() });
    enforceLimit();
    scheduleSave();
    return get(job.id);
  } finally {
    activeControllers.delete(controller);
    // Оборванная загрузка не должна оставаться мусором
    try { fs.unlinkSync(part); } catch (err) { /* переименован — ок */ }
  }
}

// Ставит трек на скачивание в фоне. Возврат Promise<{url}|null>, null — отказ.
// Повторный запрос того же id, пока задача в очереди или уже качается, тоже
// даёт null: она и так докачается, дублировать не нужно.
function store(id, url) {
  id = String(id || '');
  url = String(url || '');
  if (!SAFE_ID.test(id) || !/^https:\/\//i.test(url)) return Promise.resolve(null);

  // Окно могло попросить кэш раньше, чем init() соберёт индекс: без ожидания
  // уже скачанный файл пошёл бы качаться заново.
  return (ready || Promise.resolve()).then(() => {
    if (index.has(id)) return get(id);
    if (inflight.has(id) || jobQueue.some((j) => j.id === id)) return null;

    return new Promise((resolve) => {
      // Без этого флага повторный store() во время уже начатой загрузки
      // запускал вторую в тот же .part.
      inflight.add(id);
      jobQueue.push({
        id, url, ext: extFromUrl(url),
        resolve: (val) => { inflight.delete(id); resolve(val); }
      });
      processQueue();
    });
  });
}

function drop(id) {
  id = String(id || '');
  const hit = index.get(id);
  if (!hit) return;
  try {
    fs.unlinkSync(filePath(hit));
  } catch (err) {
    if (err.code !== 'ENOENT') return; // занят — снесём позже
  }
  index.delete(id);
  scheduleSave();
}

module.exports = { init, get, store, drop, setLimit, setPinned, clear, stats, sweep, flush };
