const { app, BrowserWindow, WebContentsView, ipcMain, session, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const vk = require('./vk-audio');
const localMusic = require('./local-music');
const library = require('./library');
const updates = require('./updates');
const discord = require('./discord-rpc');
const songCache = require('./song-cache');

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
    if (h) h['Access-Control-Allow-Origin'] = ['*'];
    callback(h ? { responseHeaders: h } : {});
  });
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
  songCache.init(app.getPath('userData'));
  createWindow();
  discord.start();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Закрываем соединение с Discord до выхода, иначе процесс висит на открытом
// named pipe и приложение не завершается.
app.on('will-quit', () => discord.shutdown());

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

ipcMain.handle('cache:clear', () => {
  try {
    return { success: true, data: songCache.clear() };
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

// Ссылки на релиз открываем в системном браузере, а не внутри приложения
ipcMain.handle('app:openExternal', async (e, url) => {
  const safe = String(url || '');
  if (!/^https:\/\/(github\.com|api\.github\.com)\//.test(safe)) {
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
