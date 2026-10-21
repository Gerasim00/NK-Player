const { app, BrowserWindow, WebContentsView, ipcMain, session, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const vk = require('./vk-audio');
const localMusic = require('./local-music');

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
  localMusic.init(app.getPath('userData'));
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
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
