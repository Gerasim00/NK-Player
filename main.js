const { app, BrowserWindow, WebContentsView, ipcMain, session, dialog, Menu, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const vk = require('./vk-audio');
const localMusic = require('./local-music');
const library = require('./library');
const updates = require('./updates');
const discord = require('./discord-rpc');
const songCache = require('./song-cache');
const feedback = require('./feedback');

const IS_DEV = !app.isPackaged;

// Приложение переименовано в NK Player, а Electron хранит профиль в папке с
// названием продукта. Переносим старый профиль, чтобы вход в ВК не слетел.
function migrateOldProfile() {
  const target = app.getPath('userData');
  const legacy = path.join(path.dirname(target), 'VK Music Player');
  if (path.resolve(target) === path.resolve(legacy)) return;

  const hasSession = (dir) => fs.existsSync(path.join(dir, 'Network', 'Cookies'));
  try {
    if (!fs.existsSync(legacy) || !hasSession(legacy)) return;
    if (fs.existsSync(target)) {
      if (hasSession(target)) return;
      fs.rmSync(target, { recursive: true, force: true });
    }
    fs.renameSync(legacy, target);
  } catch (e) {
    // Не удалось перенести — приложение просто начнёт с чистого профиля
  }
}

migrateOldProfile();
app.setAppUserModelId('ru.nk.player');

// Chromium кэширует те же mp3, что мы и так складываем в song-cache: на диске
// они лежали дважды, а слайдер в настройках видел только нашу копию.
// Свой кэш у нас есть, поэтому сетевой держим маленьким.
app.commandLine.appendSwitch('disk-cache-size', String(64 * 1024 * 1024));

// ---------------------------------------------------------------- CDN ВК

// Самозалитые треки лежат на отдельных серверах аудио-CDN ВК, которые
// капризнее к входящим запросам, чем треки каталога. Вопросы с Electron
// в User-Agent, без Referer и с Origin: file:///null приводят к тому, что
// часть ссылок отдаётся медленно или не отдаётся, а hls.js вообще не может
// забрать сегменты из окна file://. Делаем запросы к аудио-CDN такими же,
// как у плеера на vk.ru, и раздаём CORS для hls.js.
const VK_CDN_FILTERS = [
  '*://*.vkuseraudio.net/*',
  '*://*.userapi.com/*',
  '*://*.vkuser.net/*',
  '*://*.okcdn.ru/*',
  '*://*.vk-me.ru/*'
];

function setupVkCdnHeaders() {
  const ses = session.defaultSession;
  // Аудио-CDN ВК — кладём заголовки плеера и CORS для hls.js

  // Исходящие запросы к аудио-CDN — заголовки как у настоящего плеера
  ses.webRequest.onBeforeSendHeaders({ urls: VK_CDN_FILTERS }, (details, callback) => {
    const h = details.requestHeaders;
    h.Referer = 'https://vk.ru/';
    const ua = h['User-Agent'];
    if (ua) h['User-Agent'] = ua
      .replace(/\s*NK[_ -]?Player\/[\d.]+/gi, '')
      .replace(/\s*Electron\/[\d.]+/i, '');
    // okcdn отклоняет запросы с Origin: file:///null — убираем его совсем
    delete h.Origin;
    callback({ requestHeaders: h });
  });

  // CORS для hls.js: без этого XHR из окна file:// получит отказ на манифест
  // и сегменты, даже если сам CDN отвечает нормально
  ses.webRequest.onHeadersReceived({ urls: VK_CDN_FILTERS }, (details, callback) => {
    const h = details.responseHeaders;
    if (h) {
      h['Access-Control-Allow-Origin'] = ['*'];
      // Аудио не кэшируем в Chromium: у нас свой кэш на диске, а лишняя
      // копия в Cache_Data занимала столько же и слайдер её не видел.
      if (isMediaResponse(details)) {
        h['Cache-Control'] = ['no-store'];
        delete h['cache-control'];
        delete h['ETag'];
        delete h['etag'];
      }
    }
    callback(h ? { responseHeaders: h } : {});
  });
}

// Аудио-ответы: тип запроса от медиастека либо расширение в пути
function isMediaResponse(details) {
  if (details.resourceType === 'media') return true;
  try {
    const p = new URL(details.url).pathname.toLowerCase();
    return /\.(mp3|m4a|aac|mp4|ogg|opus|flac|wav|m3u8|ts)$/.test(p);
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------- Сетевой кэш

// Папка Cache профиля: сюда Chromium складывает ответы, в том числе аудио.
function netCacheDir() {
  return path.join(app.getPath('userData'), 'Cache');
}

function dirBytes(dir) {
  let total = 0;
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
  for (const e of list) {
    const full = path.join(dir, e.name);
    try {
      total += e.isDirectory() ? dirBytes(full) : fs.statSync(full).size;
    } catch (err) { /* файл занят — пропустим */ }
  }
  return total;
}

function netCacheBytes() {
  return dirBytes(netCacheDir());
}

async function clearNetCache() {
  try {
    await session.defaultSession.clearCache();
    return true;
  } catch (e) {
    return false;
  }
}

// Стартовая уборка: раздутый сетевой кэш от прошлых версий чистим один раз,
// чтобы у тех, кто уже успел накопить сотни мегабайт, место вернулось.
async function trimNetCacheOnStart() {
  const NET_KEEP_BYTES = 256 * 1024 * 1024;
  if (netCacheBytes() > NET_KEEP_BYTES) await clearNetCache();
}

let mainWindow;
let authView = null;

function iconPath() {
  return path.join(__dirname, 'assets', 'icon.ico');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#05060f',
    title: 'NK Player',
    icon: iconPath(),
    frame: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  Menu.setApplicationMenu(null);
  // Проброс консоли рендерера в stdout — видно логи при запуске из терминала/npm start
  mainWindow.webContents.on('console-message', (...args) => {
    const ev = args[0];
    const msg = ev && typeof ev === 'object' && 'message' in ev ? ev.message : args[2];
    if (typeof msg === 'string') console.log('[renderer]', msg);
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('maximize', () => mainWindow.webContents.send('win:state', { maximized: true }));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('win:state', { maximized: false }));

  mainWindow.on('resize', () => {
    if (authView) setAuthViewBounds();
  });
}

function setAuthViewBounds() {
  const [width, height] = mainWindow.getContentSize();
  // 44 px — своя титульная панель, 46 px — полоса с подсказкой про QR
  authView.setBounds({ x: 0, y: 90, width, height: height - 90 });
}

app.whenReady().then(() => {
  setupVkCdnHeaders();
  localMusic.init(app.getPath('userData'));
  library.init(app.getPath('userData'));
  songCache.init(app.getPath('userData')).catch(() => {});
  trimNetCacheOnStart().catch(() => {});
  createWindow();
  discord.start();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Закрываем соединение с Discord до выхода, иначе процесс висит на открытом
// named pipe и приложение не завершается. Там же дописываем индекс кэша:
// отложенная запись иначе потеряется.
app.on('will-quit', () => {
  discord.shutdown();
  songCache.flush();
});

// ---------------------------------------------------------------- Окно

ipcMain.handle('win:minimize', () => { mainWindow.minimize(); });
ipcMain.handle('win:maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return { maximized: mainWindow.isMaximized() };
});
ipcMain.handle('win:close', () => { mainWindow.close(); });

// ---------------------------------------------------------------- Авторизация

async function isLoggedIn() {
  const all = await session.defaultSession.cookies.get({});
  return all.some(c =>
    (c.name === 'remixsid' || c.name === 'remixnsid') &&
    ((c.domain || '').endsWith('vk.ru') || (c.domain || '').endsWith('vk.com'))
  );
}

ipcMain.handle('auth:check', async () => ({ loggedIn: await isLoggedIn() }));

ipcMain.handle('auth:start', () => {
  if (authView) return { success: true };
  authView = new WebContentsView();
  mainWindow.contentView.addChildView(authView);
  setAuthViewBounds();
  authView.webContents.loadURL('https://vk.ru/login');
  return { success: true };
});

ipcMain.handle('auth:cancel', () => { closeAuthView(); return { success: true }; });

ipcMain.handle('auth:status', async () => {
  const loggedIn = await isLoggedIn();
  if (loggedIn) closeAuthView();
  return { loggedIn };
});

function closeAuthView() {
  if (!authView) return;
  mainWindow.contentView.removeChildView(authView);
  authView.webContents.close();
  authView = null;
}

ipcMain.handle('auth:logout', async () => {
  closeAuthView();
  vk.resetSession();
  await session.defaultSession.clearStorageData();
  return { success: true };
});

// ---------------------------------------------------------------- Локальная музыка

ipcMain.handle('local:list', () => ({ success: true, data: localMusic.list() }));

ipcMain.handle('local:import', async (e, files) => {
  // Перетаскивание файлов из проводника передаёт пути сразу, минуя диалог
  if (Array.isArray(files) && files.length) {
    return { success: true, data: localMusic.importFiles(files) };
  }
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Добавить музыку',
    buttonLabel: 'Добавить',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Аудио', extensions: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma', 'mp4'] },
      { name: 'Все файлы', extensions: ['*'] }
    ]
  });
  if (res.canceled || !res.filePaths.length) return { success: true, data: null };
  return { success: true, data: localMusic.importFiles(res.filePaths) };
});

ipcMain.handle('local:remove', (e, id) => ({ success: true, data: localMusic.remove(String(id)) }));

ipcMain.handle('local:duration', (e, { id, duration }) => {
  localMusic.setDuration(String(id), duration);
  return { success: true };
});

// ---------------------------------------------------------------- ВК

// Обёртка: все запросы к ВК возвращают { success, data } или { success: false, error }
function vkHandler(channel, fn) {
  ipcMain.handle(channel, async (event, arg) => {
    try {
      return { success: true, data: await fn(session.defaultSession, arg) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

vkHandler('profile:get', (ses) => vk.getProfile(ses));
vkHandler('audio:get', (ses) => vk.getMyAudios(ses));
vkHandler('playlists:get', (ses) => vk.getPlaylists(ses));
vkHandler('playlist:tracks', (ses, pl) => vk.getPlaylistTracks(ses, pl));
vkHandler('audio:search', (ses, q) => vk.search(ses, String(q || '').slice(0, 200)));
vkHandler('audio:searchMore', (ses, more) => vk.searchMore(ses, more));
vkHandler('audio:resolve', (ses, arg) => {
  // Новый формат: { ids, background }; старый — просто массив id
  const req = Array.isArray(arg) ? { ids: arg } : (arg || {});
  const ids = Array.isArray(req.ids) ? req.ids.slice(0, 200) : [];
  return vk.resolveUrls(ses, ids, { background: !!req.background });
});

// Фоновый прогрев самозалитов: ВК конвертирует залитые файлы по первому
// запросу сегмента (до 15-30 с), поэтому заранее дёргаем начало трека.
// Формат: [{ id, urls: [...] }] — по несколько ссылок на трек (okcdn-HLS + cs*).
vkHandler('audio:warm', (ses, items) =>
  vk.warmSegments(
    ses,
    (Array.isArray(items) ? items : []).flatMap((it) =>
      (it && Array.isArray(it.urls)) ? it.urls.map((u) => ({ id: it.id, url: u })) : []
    )
  )
);

// Постоянный кэш треков: мгновенный старт уже скачанных и фоновый кач вперёд
ipcMain.handle('audio:cacheGet', (e, arg) => {
  try {
    return { success: true, data: songCache.get(String((arg && arg.id) || '')) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('audio:cacheStore', async (e, arg) => {
  const id = String((arg && arg.id) || '');
  const url = String((arg && arg.url) || '');
  try {
    const out = await songCache.store(id, url);
    return { success: true, data: out };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Настройки кэша: лимит, ручная очистка, занятое место
ipcMain.handle('cache:limit', (e, arg) => {
  try {
    songCache.setLimit(Number((arg && arg.bytes) || 0));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('cache:clear', async () => {
  try {
    const data = songCache.clear();
    // Рядом лежит HTTP-кэш Chromium с копиями тех же треков — чистим и его,
    // иначе кнопка «Очистить» освобождает место только наполовину.
    const net = await clearNetCache();
    return { success: true, data: Object.assign({}, data, { net }) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Что нельзя вытеснять из кэша: текущий трек и следующие в очереди
ipcMain.handle('cache:pin', (e, arg) => {
  songCache.setPinned(arg && Array.isArray(arg.ids) ? arg.ids : []);
  return { success: true };
});

// Размер сетевого кэша Chromium — он не входит в лимит слайдера
ipcMain.handle('cache:netStats', () => {
  try {
    return { success: true, data: { bytes: netCacheBytes() } };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('cache:stats', () => {
  try {
    return { success: true, data: songCache.stats() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ---------------------------------------------------------------- Обратная связь

// Отзыв уходит в Discord-канал разработчика. Сам webhook живёт только здесь:
// в рендерер не отдаётся, в исходниках хранится зашифрованным (feedback.key).
ipcMain.handle('feedback:send', async (e, payload) => {
  try {
    const rating = Math.round(Number(payload && payload.rating));
    const comment = String((payload && payload.comment) || '').trim();
    if (!Number.isInteger(Number(payload && payload.rating))) return { ok: false, error: 'Оценка должна быть целым числом от 1 до 5' };
    if (!(rating >= 1 && rating <= 5)) return { ok: false, error: 'Оценка должна быть от 1 до 5' };
    if (!comment) return { ok: false, error: 'Отзыв пустой' };
    if (comment.length > feedback.MAX_COMMENT) return { ok: false, error: 'Отзыв длиннее 1200 символов' };
    await feedback.sendFeedback({ rating, comment, version: app.getVersion() });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------------------------------------------------------------- Локальные плейлисты

function libHandler(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    try {
      return { success: true, data: fn(...args) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

libHandler('lib:list', () => library.list());
libHandler('lib:tracks', (id) => library.tracks(String(id || '')));
libHandler('lib:create', (title) => library.create(title));
libHandler('lib:rename', (id, title) => library.rename(String(id || ''), title));
libHandler('lib:remove', (id) => library.remove(String(id || '')));
libHandler('lib:addTrack', (id, track) => library.addTrack(String(id || ''), track));
libHandler('lib:removeTrack', (id, trackId) => library.removeTrack(String(id || ''), String(trackId || '')));

// ---------------------------------------------------------------- Версия и обновления

ipcMain.handle('app:version', () => ({ success: true, data: app.getVersion() }));

ipcMain.handle('update:check', async (e, arg) => {
  try {
    return { success: true, data: await updates.check({ force: !!(arg && arg.force) }) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ---------------------------------------------------------------- Обновление: скачивание и тихая установка

// Состояние последнего скачанного установщика; переживает закрытие окна обновлений
const upd = { filePath: '', version: '', bytes: 0 };

function updatesDir() {
  const dir = path.join(app.getPath('userData'), 'updates');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ipcMain.handle('update:download', async (e, arg) => {
  let part = '';
  try {
    const url = String((arg && arg.url) || '');
    const size = Number((arg && arg.size) || 0);
    const version = String((arg && arg.version) || '');
    if (!/^https:\/\//.test(url)) throw new Error('Некорректная ссылка');

    // Старые установщики не нужны — каждый раз качаем свежий релиз заново
    const dir = updatesDir();
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (err) { /* занят — пропустим */ }
    }

    let fileName = '';
    try {
      fileName = path.basename(new URL(url).pathname) || '';
    } catch (err) { fileName = ''; }
    if (!/\.exe$/i.test(fileName)) fileName = `NK-Player-Setup-${version || 'new'}.exe`;

    part = path.join(dir, fileName + '.part');
    const res = await net.fetch(url, {
      headers: { 'User-Agent': 'NK-Player Updater', Accept: 'application/octet-stream' },
      redirect: 'follow'
    });
    if (!res.ok || !res.body) throw new Error(`GitHub вернул HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') || 0) || size;

    // Поток качаем в файл, прогресс — в окно плеера (не чаще ~6 раз в секунду)
    let received = 0;
    let lastAt = 0;
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => {
      received += chunk.length;
      const now = Date.now();
      if (now - lastAt > 150 && !e.sender.isDestroyed()) {
        lastAt = now;
        e.sender.send('update:download-progress', {
          received,
          total,
          percent: total ? Math.min(100, Math.round(received / total * 100)) : 0
        });
      }
    });

    await pipeline(body, fs.createWriteStream(part));

    const bytes = fs.statSync(part).size;
    // Размер либо совпал, либо расходится не более чем на мегабайт/2% — защита от обрыва
    if (size && (Math.abs(bytes - size) > size * 0.02) && Math.abs(bytes - size) > 1048576) {
      throw new Error('Файл скачался не полностью, попробуйте ещё раз');
    }

    const finalPath = path.join(dir, fileName);
    fs.renameSync(part, finalPath);
    part = '';
    upd.filePath = finalPath;
    upd.version = version;
    upd.bytes = bytes;
    return { success: true, data: { filePath: finalPath, bytes } };
  } catch (err) {
    try { if (part) fs.unlinkSync(part); } catch (err2) { /* ок */ }
    return { success: false, error: err.message };
  }
});

// Тихая установка: NSIS /S, затем отдаём фокус установщику и выходим.
// Установщик при /S сам закрывает работающий экземпляр и обновляет файлы.
ipcMain.handle('update:install', async () => {
  try {
    if (!upd.filePath || !fs.existsSync(upd.filePath)) {
      return { success: false, error: 'Установщик ещё не скачан' };
    }
    spawn(upd.filePath, ['/S'], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 1000);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Ссылки из интерфейса (релизы, репозиторий, Discord) открываем в системном
// браузере, а не внутри приложения
ipcMain.handle('app:openExternal', async (e, url) => {
  const safe = String(url || '');
  if (!/^https:\/\/(github\.com|api\.github\.com|discord\.gg|discord\.com)\//.test(safe)) {
    return { success: false, error: 'Недопустимая ссылка' };
  }
  await shell.openExternal(safe);
  return { success: true };
});

// ---------------------------------------------------------------- Discord

ipcMain.handle('discord:update', (e, payload) => {
  discord.update(payload);
  return { success: true };
});

ipcMain.handle('discord:set-enabled', (e, on) => {
  discord.setEnabled(!!on);
  return { success: true, data: discord.status() };
});

ipcMain.handle('discord:status', () => ({ success: true, data: discord.status() }));
