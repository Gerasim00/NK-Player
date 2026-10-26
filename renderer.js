const { ipcRenderer } = require('electron');
const Hls = require('hls.js');

const $ = (id) => document.getElementById(id);

const loginView = $('login-view');
const appView = $('app');
const bottomBar = $('bottom-bar');
const statusEl = $('status');
const qrCancelBar = $('qr-cancel-bar');

const tracksContainer = $('tracks-container');
const playlistNav = $('playlist-nav');
const searchInput = $('search-input');
const filterInput = $('filter-input');

const audio = $('audio-player');
const btnPlayPause = $('btn-play-pause');
const btnShuffle = $('btn-shuffle');
const btnRepeat = $('btn-repeat');
const btnMute = $('btn-mute');
const seekBar = $('seek-bar');
const volumeBar = $('volume-bar');
const eqPanel = $('eq-panel');
const btnEq = $('btn-eq');

// Ссылки ВК живут ограниченное время — перезапрашиваем, если старше этого срока
const URL_TTL = 60 * 60 * 1000;
// Сколько предстоящих треков сразу показывать в панели очереди
const QUEUE_WINDOW = 50;

// Сколько треков предстоят после играющего (при «повторе списка» — новый круг)
function queueUpcoming() {
  if (!state.order.length) return 0;
  let upcoming = state.pos >= 0
    ? state.order.length - (state.pos + 1)
    : state.order.length;
  if (upcoming <= 0 && state.repeat === 'all') upcoming = state.order.length;
  return Math.max(0, upcoming);
}

const state = {
  profile: null,
  myTracks: null,
  localTracks: null,
  playlists: [],
  playlistTracks: new Map(),  // "owner_id" -> tracks
  localPlaylists: [],         // свои плейлисты (playlists.json в профиле)
  localPlaylistTracks: new Map(), // id -> tracks
  search: null,               // { query, tracks, more }
  view: { type: 'my' },
  displayed: [],              // треки текущего экрана после фильтра
  prefetchActive: false,

  queue: [],
  order: [],                  // порядок воспроизведения (индексы queue)
  pos: -1,                    // позиция в order
  orderOf: null,              // трек -> позиция в order (для экрана очереди)
  current: null,
  shuffle: false,
  repeat: 'off',              // off | all | one
  playToken: 0,
  retried: false
};

let hls = null;
let isSeeking = false;
let authPollInterval = null;

// ---------------------------------------------------------------- IPC

async function vkCall(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || !res.success) throw new Error((res && res.error) || 'Неизвестная ошибка');
  return res.data;
}

function stampTracks(tracks) {
  const now = Date.now();
  tracks.forEach((t) => { if (t.url) t.urlTime = now; });
  return tracks;
}

// ВК отдаёт ограниченное число ссылок за короткое время, поэтому кэш в главном
// процессе греется заранее и мелкими порциями — так нажатие на трек почти всегда
// попадает в кэш. Как только ВК упёрся в лимит, предзагрузка засыпает.
let prefetchTimer = null;
let prefetchRunning = false;
let prefetchGen = 0;

// ----- Постоянный кэш треков (file://-мгновенный старт) -----

// Ссылки для прогрева HLS: греем только те источники, которые реально играют —
// это okcdn-HLS (t.stream) и расшифрованные cs*-ссылки с .m3u8. Прямые mp3
// прогрева не требуют: для них фоном качается файл в постоянный кэш.
function linksForWarm(t) {
  const out = [];
  if (t && t.stream && t.stream.includes('.m3u8')) out.push(t.stream);
  if (t && t.url && t.url.includes('.m3u8')) out.push(t.url);
  return out.slice(0, 2);
}

// Прямая ссылка для постоянного кэша: mp3/aac без HLS-обёртки. Для самозалитов
// это часто расшифрованная cs*-ссылка — медленная сеть, но качается в фоне,
// пока играют другие треки, и после этого трек открывается мгновенно навсегда.
function directUrlFor(t) {
  if (!t || t.local) return '';
  if (t.stream && !/\.m3u8/i.test(t.stream)) return t.stream;
  if (t.url && !/\.m3u8/i.test(t.url)) return t.url;
  return '';
}

// id трека -> file://-ссылка в кэше (наполняется ответами cacheGet/cacheStore)
const localHits = new Map();

async function cachedFileUrl(t) {
  if (!t || t.local) return '';
  const known = localHits.get(t.id);
  if (known) return known;
  try {
    const res = await vkCall('audio:cacheGet', { id: t.id });
    if (res && res.url) {
      localHits.set(t.id, res.url);
      return res.url;
    }
  } catch (e) { /* кэш просто пуст */ }
  return '';
}

// Фоново ставим треки на скачивание: текущий (чтобы после перезапуска открылся
// мгновенно) и следующие по очереди (чтобы переход был без ожидания).
function storeUpcoming(pos) {
  const wanted = {};
  const add = (t) => {
    if (!t || t.local || wanted[t.id] || localHits.has(t.id)) return;
    const u = directUrlFor(t);
    if (!u) return;
    wanted[t.id] = u;
  };
  const current = state.queue[state.order[pos]];
  add(current);
  for (let p = pos + 1; p < state.order.length && Object.keys(wanted).length < 3; p++) {
    add(state.queue[state.order[p]]);
  }
  for (const [id, url] of Object.entries(wanted)) {
    vkCall('audio:cacheStore', { id, url })
      .then((out) => { if (out && out.url) localHits.set(id, out.url); })
      .catch(() => {});
  }
}

// Прогрев самозалитов: ВК собирает HLS из залитого файла по первому запросу
// сегмента (холодный — 15-40 с). Греем заранее, тихо и дёшево (два GET по 64 КБ).
const warmedTracks = new Set();
let warmBudget = 500; // треков за сессию; запросы мелкие, трафик копеечный
let warmChain = Promise.resolve();
function warmUploads(items) {
  const batch = (items || [])
    .filter((it) => it && it.id && Array.isArray(it.urls) && it.urls.length
      && !warmedTracks.has(it.id) && warmBudget > 0);
  if (!batch.length) return;
  batch.forEach((it) => { warmedTracks.add(it.id); warmBudget--; });
  warmChain = warmChain
    .then(() => vkCall('audio:warm', batch))
    .catch(() => {});
}

function schedulePrefetch(list) {
  if (prefetchTimer) clearTimeout(prefetchTimer);
  prefetchGen++;
  const gen = prefetchGen;
  const pending = (list || [])
    .filter((t) => !t.local && t.reloadId && !t.url && !hasLiveStream(t))
    .map((t) => ({ reloadId: t.reloadId, track: t }));
  if (!pending.length) return;

  prefetchTimer = setTimeout(async () => {
    prefetchTimer = null;
    if (prefetchRunning) return;
    prefetchRunning = true;
    try {
      // У ВК жёсткая квота на выдачу ссылок (~400 за окно, потом no_audios для
      // всех запросов сразу), а списки давно отдают вообще без ссылок. Большие
      // предзагрузки съедали квоту целиком из-за чего игрок останавливался на
      // паре десятках треков. Поэтому предзагрузим только ОДИН чанк (30
      // ближайших) на открытие экрана — остальное возьмёт по требованию
      // ensureUrls при каждом переключении, он и самозалиты сразу греет.
      const chunk = pending.slice(0, 30);
      const res = await vkCall('audio:resolve', { ids: chunk.map((p) => p.reloadId), background: true });
      // Упёрлись в лимит ВК — ссылок предзагрузке не досталось; воспроизведение
      // важнее, а до нужных трека ссылки дойдут через ensureUrls.
      if (res && !res.rateLimited) {
        const now = Date.now();
        const items = [];
        for (const p of chunk) {
          const t = p.track;
          const u = res.urls && res.urls[t.id];
          const st = res.streams && res.streams[t.id];
          if (u) { t.url = u; t.urlTime = now; }
          if (st && st.url) { t.stream = st.url; t.streamExpires = st.expires; }
          const urls = linksForWarm(t);
          if (urls.length) items.push({ id: t.id, urls });
        }
        warmUploads(items);
      }
    } catch (e) {
      // тихо: предзагрузка не критична
    } finally {
      prefetchRunning = false;
    }
  }, 1500);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Окно

$('win-min').addEventListener('click', () => ipcRenderer.invoke('win:minimize'));
$('win-max').addEventListener('click', () => ipcRenderer.invoke('win:maximize'));
$('win-close').addEventListener('click', () => ipcRenderer.invoke('win:close'));

ipcRenderer.on('win:state', (_, { maximized }) => {
  $('win-max').title = maximized ? 'Восстановить' : 'Развернуть';
});

// ---------------------------------------------------------------- Авторизация

// ---------------------------------------------------------------- Соглашение

// Версия текста соглашения: если она изменится, плашку покажем заново.
const TERMS_VERSION = '1';
const TERMS_KEY = 'nk.termsVersion';

const btnOauth = $('btn-oauth');
const termsAccept = $('terms-accept');
const termsText = $('terms-text');
const termsCheck = document.querySelector('.terms-check');
const termsToggle = $('terms-toggle');

function termsAccepted() {
  try { return localStorage.getItem(TERMS_KEY) === TERMS_VERSION; } catch (e) { return false; }
}

function setTermsExpanded(expanded) {
  termsText.classList.toggle('hidden', !expanded);
  termsCheck.classList.toggle('hidden', !expanded);
  termsToggle.textContent = expanded ? 'Свернуть' : 'Показать';
}

function setTermsAccepted(on) {
  termsAccept.checked = on;
  btnOauth.disabled = !on;
  btnOauth.title = on ? 'Открыть страницу входа ВКонтакте' : 'Сначала примите пользовательское соглашение';
  try {
    if (on) localStorage.setItem(TERMS_KEY, TERMS_VERSION);
    else localStorage.removeItem(TERMS_KEY);
  } catch (e) {}
}

// При запуске соглашение уже может быть принято — тогда сразу разблокируем вход
// и сворачиваем текст, чтобы карточка входа не занимала весь экран.
function applyTermsState() {
  const accepted = termsAccepted();
  setTermsAccepted(accepted);
  setTermsExpanded(!accepted);
}

termsAccept.addEventListener('change', () => setTermsAccepted(termsAccept.checked));

termsToggle.addEventListener('click', () => {
  setTermsExpanded(termsText.classList.contains('hidden'));
});

// ---------------------------------------------------------------- Версия и обновления

let updateChecked = false;

async function showVersion() {
  try {
    const res = await ipcRenderer.invoke('app:version');
    const ver = res && res.success ? res.data : '';
    $('app-version').textContent = ver ? 'v' + ver : '';
  } catch (e) {}
}

// Тег релиза у нас называется NK-Player-1.5.0 — в интерфейсе оставляем только номер
function versionLabel(tag) {
  const m = String(tag || '').match(/\d+(?:\.\d+)*/);
  return m ? m[0] : String(tag || '').replace(/^v/i, '');
}

function showUpdateBanner(info) {
  if (!info || !info.updateAvailable) return;
  const banner = $('update-banner');
  $('ub-text').textContent = `У вас v${info.current}, на GitHub опубликована ${versionLabel(info.latest)}. Скачайте новую сборку, чтобы получить свежие исправления.`;
  banner.classList.remove('hidden');
  banner.dataset.url = info.url || '';
}

async function checkUpdates(manual) {
  const btn = $('btn-check-update');
  btn.classList.add('busy');
  if (manual) btn.textContent = 'Проверяем…';

  try {
    const res = await ipcRenderer.invoke('update:check', { force: !!manual });
    if (!res || !res.success) throw new Error((res && res.error) || 'Не удалось проверить обновления');
    const info = res.data;
    updateChecked = true;

    if (info.error) {
      if (manual) toast('Не удалось проверить: ' + info.error);
      return;
    }
    if (info.updateAvailable) {
      showUpdateBanner(info);
      if (manual) toast(`Доступна версия ${versionLabel(info.latest)}`);
      return;
    }
    if (manual) toast(`У вас последняя версия (v${info.current})`);
  } catch (e) {
    if (manual) toast('Не удалось проверить обновления: ' + e.message);
  } finally {
    btn.classList.remove('busy');
    btn.textContent = 'Проверить';
  }
}

$('btn-check-update').addEventListener('click', () => checkUpdates(true));

$('ub-later').addEventListener('click', () => $('update-banner').classList.add('hidden'));

$('ub-open').addEventListener('click', async () => {
  const url = $('update-banner').dataset.url;
  if (!url) return;
  await ipcRenderer.invoke('app:openExternal', url);
  $('update-banner').classList.add('hidden');
});

// ---------------------------------------------------------------- Запуск

window.addEventListener('DOMContentLoaded', async () => {
  restoreSettings();
  applyTermsState();
  showVersion();
  // Лимит кэша из настроек применяем сразу после старта
  ipcRenderer.invoke('cache:limit', { bytes: (settings.cacheLimitMB || DEFAULT_SETTINGS.cacheLimitMB) * 1048576 }).catch(() => {});

  const session = await ipcRenderer.invoke('auth:check');
  if (session.loggedIn) showApp();
  else loginView.classList.remove('hidden');

  // Проверку обновлений запускаем после отрисовки: ответ GitHub не должен
  // задерживать показ окна, а без сети приложение обязано работать как обычно.
  setTimeout(() => { if (!updateChecked) checkUpdates(false); }, 2000);
});

function stopAuthPoll() {
  if (authPollInterval) {
    clearInterval(authPollInterval);
    authPollInterval = null;
  }
}

btnOauth.addEventListener('click', async () => {
  if (!termsAccepted()) {
    statusEl.textContent = 'Чтобы продолжить, примите пользовательское соглашение.';
    setTermsExpanded(true);
    return;
  }
  statusEl.textContent = '';
  await ipcRenderer.invoke('auth:start');
  qrCancelBar.classList.remove('hidden');
  loginView.classList.add('hidden');

  authPollInterval = setInterval(async () => {
    const res = await ipcRenderer.invoke('auth:status');
    if (res.loggedIn) {
      stopAuthPoll();
      qrCancelBar.classList.add('hidden');
      showApp();
    }
  }, 1000);
});

$('btn-cancel-qr').addEventListener('click', async () => {
  stopAuthPoll();
  await ipcRenderer.invoke('auth:cancel');
  qrCancelBar.classList.add('hidden');
  loginView.classList.remove('hidden');
});

$('btn-logout').addEventListener('click', async () => {
  await ipcRenderer.invoke('auth:logout');
  stopPlayback();
  Object.assign(state, {
    profile: null,
    myTracks: null, playlists: [], playlistTracks: new Map(), search: null,
    localPlaylists: [], localPlaylistTracks: new Map(),
    view: { type: 'my' }, displayed: [], queue: [], order: [], pos: -1, current: null
  });
  playlistNav.textContent = '';
  updateNowPlaying();
  appView.classList.add('hidden');
  bottomBar.classList.add('hidden');
  $('nav-search').classList.add('hidden');
  searchInput.value = '';
  loginView.classList.remove('hidden');
});

// ---------------------------------------------------------------- Загрузка данных

function showApp() {
  loginView.classList.add('hidden');
  appView.classList.remove('hidden');
  bottomBar.classList.remove('hidden');
  loadAccount();
  updateLocalCount();
  loadLocalTracks().catch(() => {});
  openView({ type: 'home' });
  loadPlaylists();
}

async function loadAccount() {
  try {
    const profile = await vkCall('profile:get');
    state.profile = profile;
    $('account-name').textContent = profile.name;
    $('account-sub').textContent = profile.screenName ? '@' + profile.screenName : 'аккаунт ВКонтакте';
    $('tb-sub').textContent = profile.name;
    setCover($('account-avatar'), profile.avatar, initial(profile.name));
  } catch (e) {
    $('account-name').textContent = 'ВКонтакте';
    $('account-sub').textContent = 'профиль недоступен';
  }
}

async function loadMyTracks() {
  if (state.myTracks) return state.myTracks;
  state.myTracks = stampTracks(await vkCall('audio:get'));
  $('nav-my-count').textContent = pluralTracks(state.myTracks.length);
  return state.myTracks;
}

async function loadLocalTracks() {
  if (state.localTracks) return state.localTracks;
  state.localTracks = await vkCall('local:list');
  updateLocalCount();
  return state.localTracks;
}

function updateLocalCount() {
  const n = state.localTracks ? state.localTracks.length : 0;
  $('nav-local-count').textContent = n ? pluralTracks(n) : 'свои файлы';
}

async function loadPlaylists() {
  playlistNav.textContent = '';

  // Свои плейлисты читаются с диска мгновенно — рисуем их сразу, не дожидаясь ВК.
  try {
    state.localPlaylists = await vkCall('lib:list');
  } catch (e) {
    state.localPlaylists = [];
  }
  renderPlaylistNav();

  try {
    state.playlists = await vkCall('playlists:get');
  } catch (e) {
    state.playlists = [];
    if (!state.localPlaylists.length) {
      const ph = document.createElement('div');
      ph.className = 'nav-sub';
      ph.style.padding = '8px 12px';
      ph.textContent = e.message;
      playlistNav.appendChild(ph);
      return;
    }
  }
  renderPlaylistNav();
}

async function loadPlaylistTracks(pl) {
  const key = `${pl.ownerId}_${pl.id}`;
  if (!state.playlistTracks.has(key)) {
    const tracks = stampTracks(await vkCall('playlist:tracks', pl));

    // ВК почти не отдаёт обложки для треков внутри плейлистов. Сначала ищем
    // их в «Моей музыке» по исполнителю и названию, остальным ставим обложку
    // самого плейлиста — так же делает и веб-версия ВК.
    const known = state.myTracks;
    let byName = null;
    if (known && known.length) {
      byName = new Map();
      for (const t of known) {
        if (t.cover) byName.set(`${t.artist}\u0000${t.title}`, t.cover);
      }
    }
    for (const t of tracks) {
      if (!t.cover && byName) t.cover = byName.get(`${t.artist}\u0000${t.title}`) || '';
    }

    // У части плейлистов ВК не даёт обложку вообще — берём её у первого трека
    if (!pl.cover) {
      const first = tracks.find((t) => t.cover);
      if (first) {
        pl.cover = first.cover;
        const icon = playlistNav.querySelector(`[data-key="${CSS.escape(key)}"] .nav-icon`);
        if (icon) setCover(icon, pl.cover, '☰');
      }
    }
    if (pl.cover) {
      for (const t of tracks) if (!t.cover) t.cover = pl.cover;
    }

    state.playlistTracks.set(key, tracks);
  }
  return state.playlistTracks.get(key);
}

// ---------------------------------------------------------------- Свои плейлисты

async function loadLocalPlaylistTracks(id) {
  if (!state.localPlaylistTracks.has(id)) {
    const tracks = stampTracks(await vkCall('lib:tracks', id));
    // ВК не отдаёт обложки внутри маленьких плейлистов — подтянем из «Моей музыки»
    const known = state.myTracks;
    if (known && known.length) {
      const byName = new Map();
      for (const t of known) if (t.cover) byName.set(`${t.artist}\u0000${t.title}`, t.cover);
      for (const t of tracks) {
        if (!t.cover) t.cover = byName.get(`${t.artist}\u0000${t.title}`) || '';
      }
    }
    state.localPlaylistTracks.set(id, tracks);
  }
  // Копия: renderTracks и очередь не должны менять закэшированный массив
  return state.localPlaylistTracks.get(id).slice();
}

function invalidateLocalPlaylist(id) {
  state.localPlaylistTracks.delete(id);
}

async function refreshLocalPlaylists() {
  try {
    state.localPlaylists = await vkCall('lib:list');
  } catch (e) {
    state.localPlaylists = [];
  }
  renderPlaylistNav();
}

async function createPlaylistFlow() {
  const title = await openModal({
    title: 'Новый плейлист',
    text: 'Название можно изменить позже. Плейлисты хранятся на вашем устройстве.',
    okLabel: 'Создать',
    placeholder: 'Например: Вечернее'
  });
  if (!title) return null;

  try {
    const pl = await vkCall('lib:create', title);
    await refreshLocalPlaylists();
    toast(`Плейлист «${pl.title}» создан`);
    return pl;
  } catch (e) {
    toast('Не удалось создать плейлист: ' + e.message);
    return null;
  }
}

async function renamePlaylistFlow(pl) {
  const title = await openModal({
    title: 'Переименовать плейлист',
    text: 'Введите новое название.',
    value: pl.title,
    okLabel: 'Сохранить'
  });
  if (!title || title === pl.title) return;

  try {
    await vkCall('lib:rename', pl.id, title);
    await refreshLocalPlaylists();
    if (state.view.type === 'local-playlist' && state.view.id === pl.id) {
      state.view.playlist = { ...pl, title };
      setHeader({ kind: 'Свой плейлист', title, sub: $('view-sub').textContent, icon: '★' });
    }
    toast('Плейлист переименован');
  } catch (e) {
    toast('Не удалось переименовать: ' + e.message);
  }
}

async function deletePlaylistFlow(pl) {
  const ok = await openConfirm({
    title: 'Удалить плейлист?',
    text: `Плейлист «${pl.title}» будет удалён. Треки останутся в «Моей музыке».`,
    okLabel: 'Удалить'
  });
  if (!ok) return;

  try {
    await vkCall('lib:remove', pl.id);
    invalidateLocalPlaylist(pl.id);
    await refreshLocalPlaylists();
    if (state.view.type === 'local-playlist' && state.view.id === pl.id) openView({ type: 'my' });
    toast('Плейлист удалён');
  } catch (e) {
    toast('Не удалось удалить: ' + e.message);
  }
}

async function addTrackToPlaylist(pl, track) {
  try {
    const res = await vkCall('lib:addTrack', pl.id, track);
    invalidateLocalPlaylist(pl.id);
    await refreshLocalPlaylists();
    toast(res.added
      ? `«${track.title}» добавлен в «${pl.title}»`
      : `«${track.title}» уже есть в «${pl.title}»`);
  } catch (e) {
    toast('Не удалось добавить: ' + e.message);
  }
}

async function removeTrackFromPlaylist(pl, track) {
  try {
    await vkCall('lib:removeTrack', pl.id, track.id);
    invalidateLocalPlaylist(pl.id);
    await refreshLocalPlaylists();
    if (state.view.type === 'local-playlist' && state.view.id === pl.id) {
      const tracks = await loadLocalPlaylistTracks(pl.id);
      if (!tracks.length) {
        openView({ type: 'local-playlist', id: pl.id, playlist: pl });
      } else {
        $('view-sub').textContent = `${pluralTracks(tracks.length)} · ${formatTotal(tracks)}`;
        renderTracks();
      }
    }
    toast(`«${track.title}» убран из плейлиста`);
  } catch (e) {
    toast('Не удалось убрать трек: ' + e.message);
  }
}

// ---------------------------------------------------------------- Меню плейлиста

function openPlaylistMenu(e, pl, isLocal) {
  closeCtxMenu();
  const frag = document.createDocumentFragment();
  frag.appendChild(ctxTitle(pl.title));

  if (isLocal) {
    frag.appendChild(ctxItem('Переименовать', '✎', () => renamePlaylistFlow(pl)));
    frag.appendChild(ctxItem('Удалить плейлист', '🗑', () => deletePlaylistFlow(pl), { danger: true }));
    frag.appendChild(ctxItem('Добавить из «Моей музыки»', '＋', () => openView({ type: 'my' })));
  } else {
    frag.appendChild(ctxItem('Открыть плейлист', '▶', () => openView({ type: 'playlist', key: `${pl.ownerId}_${pl.id}`, playlist: pl })));
    frag.appendChild(ctxItem('Создать свой плейлист', '＋', createPlaylistFlow));
  }

  ctxMenu.appendChild(frag);
  placeCtxMenu(e.clientX, e.clientY);
}

$('btn-new-playlist').addEventListener('click', createPlaylistFlow);

$('btn-del-playlist').addEventListener('click', () => {
  const v = state.view;
  if (v.type === 'local-playlist') deletePlaylistFlow(v.playlist);
});

// ---------------------------------------------------------------- Навигация

function setActiveNav() {
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.remove('active'));
  const v = state.view;
  let el = null;
  if (v.type === 'home') el = $('nav-home');
  else if (v.type === 'my') el = $('nav-my');
  else if (v.type === 'local') el = $('nav-local');
  else if (v.type === 'search') el = $('nav-search');
  else if (v.type === 'artist') el = $('nav-search');
  else if (v.type === 'queue') el = $('nav-queue');
  else if (v.type === 'playlist') el = playlistNav.querySelector(`[data-key="${CSS.escape(v.key)}"]`);
  else if (v.type === 'local-playlist') el = playlistNav.querySelector(`[data-key="${CSS.escape('local:' + v.id)}"]`);
  if (el) el.classList.add('active');
}

function setHeader({ kind, title, sub, cover, icon }) {
  $('view-kind').textContent = kind;
  $('view-title').textContent = title;
  $('view-sub').textContent = sub || '';
  setCover($('view-cover'), cover, icon || '♫');
}

function showPlaceholder(text, isError, action) {
  tracksContainer.textContent = '';
  const div = document.createElement('div');
  div.className = 'placeholder' + (isError ? ' error' : '');
  const p = document.createElement('div');
  p.textContent = text;
  div.appendChild(p);
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    div.appendChild(btn);
  }
  tracksContainer.appendChild(div);
}

async function openView(view) {
  state.view = view;
  filterInput.value = '';
  setActiveNav();
  // «Главная» перекрывает весь контент: прячем хедер и список, показываем сцену
  const homeMode = view.type === 'home';
  $('home-view').classList.toggle('hidden', !homeMode);
  document.querySelector('.main-header').classList.toggle('hidden', homeMode);
  document.querySelector('.list-head').classList.toggle('hidden', homeMode);
  tracksContainer.classList.toggle('hidden', homeMode);
  // Тяжёлый цикл голограммы живёт только пока открыта главная
  if (homeMode) startHoloCat(); else stopHoloCat();
  $('btn-import').classList.toggle('hidden', view.type !== 'local');
  // Свой плейлист можно очистить только из его же экрана — кнопка видна там
  $('btn-del-playlist').classList.toggle('hidden', view.type !== 'local-playlist');
  // В очереди перемешивать нечего: порядок уже задан; на главной кнопки хедера не нужны
  $('btn-shuffle-play').classList.toggle('hidden', view.type === 'queue' || homeMode);
  const token = Symbol('view');
  state.viewToken = token;
  state.prefetchActive = false;

  try {
    if (view.type === 'home') {
      return; // ничего загружать не нужно: сцена статична
    }
    if (view.type === 'my') {
      setHeader({ kind: 'Библиотека', title: 'Моя музыка', sub: '', icon: '♫' });
      showPlaceholder('Загрузка ваших треков…');
      const tracks = await loadMyTracks();
      if (state.viewToken !== token) return;
      $('view-sub').textContent = `${pluralTracks(tracks.length)} · ${formatTotal(tracks)}`;
      renderTracks();
      state.prefetchActive = true;
      schedulePrefetch(tracks);
    } else if (view.type === 'local') {
      setHeader({ kind: 'Свои файлы', title: 'Загруженная музыка', sub: '', icon: '▤' });
      showPlaceholder('Загрузка…');
      const tracks = await loadLocalTracks();
      if (state.viewToken !== token) return;
      if (!tracks.length) {
        showPlaceholder('Здесь появятся ваши файлы. Поддерживаются MP3, M4A, FLAC, WAV, OGG.', false, {
          label: '＋ Добавить музыку',
          onClick: importMusic
        });
        return;
      }
      $('view-sub').textContent = `${pluralTracks(tracks.length)} · ${formatTotal(tracks)}`;
      renderTracks();
    } else if (view.type === 'playlist') {
      const pl = view.playlist;
      setHeader({ kind: 'Плейлист', title: pl.title, sub: [pl.author, pluralTracks(pl.size)].filter(Boolean).join(' · '), cover: pl.cover, icon: '☰' });
      showPlaceholder('Загрузка плейлиста…');
      const tracks = await loadPlaylistTracks(pl);
      if (state.viewToken !== token) return;
      $('view-sub').textContent = [pl.author, pluralTracks(tracks.length), formatTotal(tracks)].filter(Boolean).join(' · ');
      renderTracks();
      state.prefetchActive = true;
      schedulePrefetch(tracks);
    } else if (view.type === 'search') {
      setHeader({ kind: 'Поиск', title: `«${state.search.query}»`, sub: '', icon: '⌕' });
      if (!state.search.tracks) {
        showPlaceholder('Ищем…');
        return;
      }
      $('view-sub').textContent = pluralTracks(state.search.tracks.length) + (state.search.more ? '+' : '');
      renderTracks();
      state.prefetchActive = true;
      schedulePrefetch(state.search.tracks);
    } else if (view.type === 'artist') {
      setHeader({ kind: 'Артист', title: view.name, sub: '', icon: '♪' });
      if (!view.tracks) {
        showPlaceholder(`Ищем треки ${view.name}…`);
        return;
      }
      $('view-sub').textContent = pluralTracks(view.tracks.length) + (view.more ? '+' : '');
      renderTracks();
      state.prefetchActive = true;
      schedulePrefetch(view.tracks);
    } else if (view.type === 'queue') {
      setHeader({ kind: 'Воспроизведение', title: 'Очередь', sub: '', icon: '≡' });
      if (!state.order.length) {
        showPlaceholder('Очередь пуста. Нажмите ▶ на любом треке или ≡, чтобы добавить его сюда.', false, {
          label: 'Перейти в «Мою музыку»',
          onClick: () => openView({ type: 'my' })
        });
        return;
      }
      if (!queueUpcoming()) {
        showPlaceholder('Дальше треков нет. Добавьте ≡ или включите повтор списка.', false, {
          label: 'Перейти в «Мою музыку»',
          onClick: () => openView({ type: 'my' })
        });
        return;
      }
      renderTracks(); // он же обновит подзаголовок под текущее окно
    } else if (view.type === 'local-playlist') {
      const pl = view.playlist;
      setHeader({ kind: 'Свой плейлист', title: pl.title, sub: '', icon: '★' });
      showPlaceholder('Загрузка…');
      const tracks = await loadLocalPlaylistTracks(pl.id);
      if (state.viewToken !== token) return;
      if (!tracks.length) {
        $('view-sub').textContent = 'Пока пусто';
        showPlaceholder('В этом плейлисте пока пусто. Нажмите ＋ у любого трека, чтобы добавить его сюда.', false, {
          label: 'Перейти в «Мою музыку»',
          onClick: () => openView({ type: 'my' })
        });
        return;
      }
      $('view-sub').textContent = `${pluralTracks(tracks.length)} · ${formatTotal(tracks)}`;
      renderTracks();
      state.prefetchActive = true;
      schedulePrefetch(tracks);
    }
  } catch (e) {
    if (state.viewToken === token) showPlaceholder(e.message, true);
  }
}

function currentViewTracks() {
  const v = state.view;
  if (v.type === 'my') return state.myTracks || [];
  if (v.type === 'local') return state.localTracks || [];
  if (v.type === 'playlist') return state.playlistTracks.get(v.key) || [];
  if (v.type === 'search') return (state.search && state.search.tracks) || [];
  if (v.type === 'artist') return v.tracks || [];
  // Очередь показываем в порядке воспроизведения, но не целиком: только
  // предстоящую часть — начиная со следующего за играющим трека, окном до
  // QUEUE_WINDOW позиций. Обновляется на каждое переключение трека.
  if (v.type === 'queue') {
    if (!state.order.length) return [];
    let start = state.pos >= 0 ? state.pos + 1 : 0;
    if (start >= state.order.length) {
      // Последний трек играет: при повторе списка очередь снова идёт с начала
      if (state.repeat === 'all') start = 0;
      else return [];
    }
    return state.order.slice(start, start + QUEUE_WINDOW)
      .map((i) => state.queue[i])
      .filter(Boolean);
  }
  if (v.type === 'local-playlist') return state.localPlaylistTracks.get(v.id) || [];
  return [];
}

$('nav-my').addEventListener('click', () => openView({ type: 'my' }));
$('nav-local').addEventListener('click', () => openView({ type: 'local' }));
$('nav-search').addEventListener('click', () => {
  if (state.search) openView({ type: 'search' });
  else if (state.view.type === 'artist') openView(state.view);
});
$('nav-queue').addEventListener('click', () => openView({ type: 'queue' }));
$('nav-home').addEventListener('click', () => openView({ type: 'home' }));

// ---------------------------------------------------------------- Живая голограмма кота (NK-Wave)

// Силуэт читаем из разметки (#home-cat-body) и превращаем в поле светящихся
// частиц на canvas: они всплывают внутри тела, мерцают, ярче «искрят» на краях,
// пронизываются скан-полосой, изредка сбиваются горизонтальными помехами-срезами,
// а вся сцена чуть наклоняется за курсором (параллакс). Единицы координат —
// viewBox 420×520, в кадре рисуем прямо в них через setTransform.
const HOLO = {
  canvas: null, ctx: null, wrap: null, parts: [],
  mask: null, maskImg: null, maskParts: 0, rasterOK: true,
  inited: false, running: false, raf: 0, t0: 0,
  k: 1, glitch: null,
  tilt: { x: 0, y: 0, tx: 0, ty: 0 }
};

// Цветовые таблицы по корзинам яркости: без строковых склеек в кадре
const HOLO_COLD = [], HOLO_HOT = [], HOLO_SPARK = [];
for (let i = 0; i < 20; i++) {
  const a = (i / 19).toFixed(3);
  HOLO_COLD.push(`rgba(86,146,255,${a})`);
  HOLO_HOT.push(`rgba(168,222,255,${a})`);
  HOLO_SPARK.push(`rgba(225,245,255,${a})`);
}

// Фото-маска кота: вырезана из референса скриптом (порог яркости + морфология,
// кольца/лучи/кнопку почистили). Как только загрузилась — переключаем сэмплирование
// на неё и плавно гасим векторную подложку. Если файл недоступен — остаётся вектор.
(function preloadCatMask() {
  const im = new Image();
  im.onload = () => {
    HOLO.maskImg = im;
    HOLO.maskParts = holoSampleWithMask(im).length;
    console.log('[holo] маска загружена, сэмпл:', HOLO.maskParts);
    // если инициализация уже прошла (файл догрузился позже) — применяем маску сейчас
    if (HOLO.inited) applyHoloMaskChoice();
  };
  im.onerror = () => {
    console.warn('[holo] маска не загрузилась — остаёмся на векторном коте');
  };
  im.src = 'assets/cat-sil.png';
})();

// Сэмплирование с подменённой маской (до назначения HOLO.mask — для пробы)
function holoSampleWithMask(im) {
  const saved = HOLO.mask;
  HOLO.mask = im;
  const out = holoSample();
  HOLO.mask = saved;
  return out;
}

// Самотест растрового вывода canvas: на редких GPU-связках слой может молча
// не рисоваться — тогда показываем векторного кота (SVG)
function holoRasterTest() {
  try {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, 8, 8);
    return x.getImageData(4, 4, 1, 1).data[0] === 255;
  } catch (e) { return false; }
}

// Единая точка решения: фото-маску используем, только если она сэмплируется
// и растровый вывод работает; иначе — векторный кот
function applyHoloMaskChoice() {
  const useMask = !!HOLO.maskImg && HOLO.maskParts > 300 && HOLO.rasterOK;
  HOLO.mask = useMask ? HOLO.maskImg : null;
  const vec = document.getElementById('home-cat-vector');
  if (vec) vec.style.opacity = useMask ? '0' : '1';
  if (useMask) {
    if (HOLO.inited) HOLO.parts = holoSample();
    console.log('[holo] маска активна:', HOLO.maskParts, 'частиц');
  } else {
    console.warn('[holo] векторный кот: maskOk=' + !!HOLO.maskImg +
      ' parts=' + HOLO.maskParts + ' rasterOK=' + HOLO.rasterOK);
  }
  return useMask;
}

// Морда поверх частиц (только в режиме фото-маски): светящиеся глаза-щёлки
// с редким миганием. Синтетические усы больше не нужны — настоящие усы
// приходят вместе с маской (ИИ-генерат). Глаза — под новую маску (кот по центру)
const HOLO_EYES = [[191, 104], [242, 104]];
function drawHoloFace(ctx, t) {
  const blink = ((t * 1000) % 7200) < 140 ? 0.15 : 1;
  ctx.save();
  ctx.globalAlpha = blink;
  for (let i = 0; i < 2; i++) {
    const ex = HOLO_EYES[i][0];
    const ey = HOLO_EYES[i][1] + Math.sin(t * 0.9 + i) * 0.8;
    const g = ctx.createRadialGradient(ex, ey, 0, ex, ey, 21);
    g.addColorStop(0, 'rgba(210,240,255,.75)');
    g.addColorStop(0.45, 'rgba(130,200,255,.28)');
    g.addColorStop(1, 'rgba(130,200,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(ex, ey, 21, 13, 0, 0, 6.2832); ctx.fill();
    ctx.fillStyle = 'rgba(228,248,255,.95)';
    ctx.beginPath(); ctx.ellipse(ex, ey, 5.4, 2.6, 0, 0, 6.2832); ctx.fill();
  }
  // Нос: малый треугольный блик (координаты от генерата, под новую маску)
  const nn = 0.8 + 0.2 * Math.sin(t * 1.1);
  const nx = 216, ny = 141;
  const g2 = ctx.createRadialGradient(nx, ny, 0, nx, ny, 12);
  g2.addColorStop(0, `rgba(210,240,255,${0.62 * nn})`);
  g2.addColorStop(1, 'rgba(210,240,255,0)');
  ctx.fillStyle = g2;
  ctx.beginPath(); ctx.ellipse(nx, ny, 12, 9, 0, 0, 6.2832); ctx.fill();
  ctx.fillStyle = 'rgba(228,248,255,.9)';
  ctx.beginPath();
  ctx.moveTo(nx - 3.2, ny - 1.6);
  ctx.lineTo(nx + 3.2, ny - 1.6);
  ctx.lineTo(nx, ny + 2.6);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

function holoSample() {
  // Поле альфы 420×520: фото-маска (assets/cat-sil.png), если загрузилась,
  // иначе — векторный силуэт #home-cat-body как fallback.
  // Без ctx.filter (на части GPU-связок он отрисовывается пустотой): мягкий край
  // делаем полупрозрачной подложкой чуть большего размера — «подшёрсток».
  // Поле сэмплирования 840×1040 (2× канваса): сетка ×1 не пропускает тонкие
  // пряди и складки; координаты сжимаются ÷2 в единицы viewBox 420×520
  const off = document.createElement('canvas');
  off.width = 840; off.height = 1040;
  const octx = off.getContext('2d', { willReadFrequently: true });
  let aAt, lumAt;
  if (HOLO.mask) {
    octx.drawImage(HOLO.mask, 0, 0, 840, 1040);
    octx.globalAlpha = 0.42;
    octx.drawImage(HOLO.mask, -14, -14, 868, 1068);
    octx.globalAlpha = 1;
    const img = octx.getImageData(0, 0, 840, 1040).data;
    aAt = (x, y) => img[(y * 840 + x) * 4 + 3];
    lumAt = (x, y) => img[(y * 840 + x) * 4]; // R = запечённая яркость генерата
  } else {
    const pathEl = $('home-cat-body');
    if (!pathEl) return [];
    const path = new Path2D(pathEl.getAttribute('d'));
    octx.setTransform(2, 0, 0, 2, 0, 0);
    octx.fillStyle = '#fff';
    octx.fill(path);
    octx.globalAlpha = 0.42;
    octx.strokeStyle = '#fff';
    octx.lineWidth = 8;
    octx.lineJoin = 'round';
    octx.stroke(path); // расширенная мягкая кайма
    octx.globalAlpha = 1;
    octx.setTransform(1, 0, 0, 1, 0, 0);
    const img = octx.getImageData(0, 0, 840, 1040).data;
    aAt = (x, y) => img[(y * 840 + x) * 4 + 3];
    lumAt = null; // векторный fallback: без канала яркости
  }

  const all = [];
  for (let y = 3; y < 1037; y += 1) {
    for (let x = 3; x < 837; x += 1) {
      const a = aAt(x, y);
      if (a < 18) continue;
      const l = lumAt ? lumAt(x, y) : 115;
      // Два градиента по ±6px (маyed source-scale ±3 юнита): альфа — внешний
      // край силуэта; яркость — внутренние границы анатомии (пряди, провалы
      // между лапами, изгиб бёдер). По знаку и оси градиента — направление
      // локальной пряди: частицы контура рисуем штрихами вдоль неё
      const xa = Math.max(3, x - 6), xb = Math.min(836, x + 6);
      const ya = Math.max(3, y - 6), yb = Math.min(1036, y + 6);
      const gradA = Math.abs(aAt(xb, y) - aAt(xa, y)) + Math.abs(aAt(x, yb) - aAt(x, ya));
      const glx = lumAt ? lumAt(xb, y) - lumAt(xa, y) : 0;
      const gly = lumAt ? lumAt(x, yb) - lumAt(x, ya) : 0;
      let e = Math.max(Math.min(1, gradA / 340), Math.min(1, (Math.abs(glx) + Math.abs(gly)) / 260));
      if (a < 145) { // мягкая «пушистая» кайма силуэта — реже
        if (e < 0.5 && Math.random() > 0.32) continue;
        e = Math.max(e, 0.72);
      }
      // Плотность повторяет яркость генерата: светлые пряди — чаще,
      // тёмные провалы между лапами — реже → части тела различимы
      if (e < 0.45) {
        const keep = Math.min(1, 0.16 + l / 200);
        if (Math.random() > keep) continue;
      }
      const ly = l >= 215 ? 2 : (e >= 0.5 ? 1 : 0);
      // Особенные детали (прямоугольники в координатах 420×520 под текущий
      // генерат): передние лапы, уши, хвост с завитком. Приоритет: лапы → уши → хвост
      const ux = x * 0.5, uy = y * 0.5;
      let z = 0;
      if (ux >= 140 && ux <= 242 && uy >= 402 && uy <= 474) z = 1; // передние лапы
      else if ((ux >= 143 && ux <= 197 || ux >= 220 && ux <= 274) && uy <= 128) z = 2; // уши
      else if (uy >= 425 && ux >= 95 && ux <= 312 || uy >= 380 && ux > 255 && ux <= 312) z = 3; // хвост
      const rg = ly === 2 ? 2 + Math.random() * 7 :
        ly === 1 ? 5 + Math.random() * 15 : 8 + Math.random() * 30;
      const v = ly === 2 ? 0.05 + Math.random() * 0.13 :
        ly === 1 ? 0.10 + Math.random() * 0.20 : 0.16 + Math.random() * 0.36;
      const s = ly === 2 ? 1.9 + Math.random() * 1.4 :
        (e > 0.5 ? 1.5 : 1) + Math.random() * 1.1;
      all.push({
        x: x * 0.5, y: y * 0.5, e, ly, l, z,
        f: 0.5 + Math.random() * 1.1,
        ph: Math.random() * 6.283,
        v,
        rg, o: Math.random() * rg,
        s
      });
    }
  }
  // Квоты слоёв: тело ~5400, шерсть-контур ~2900, искры ~950
  const QUOTA = [5400, 2900, 950];
  const pools = [[], [], []];
  for (let i = 0; i < all.length; i++) pools[all[i].ly].push(all[i]);
  const out = [];
  for (let ly = 0; ly < 3; ly++) {
    const pool = pools[ly];
    if (pool.length > QUOTA[ly]) {
      const stride = pool.length / QUOTA[ly];
      for (let i = 0; i < QUOTA[ly]; i++) out.push(pool[(i * stride) | 0]);
    } else {
      for (let i = 0; i < pool.length; i++) out.push(pool[i]);
    }
  }
  return out;
}

function holoResize() {
  const el = HOLO.canvas;
  const w = el.clientWidth || el.parentElement.clientWidth;
  if (!w) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  el.width = Math.round(w * dpr);
  el.height = Math.round(w * (520 / 420) * dpr);
  HOLO.k = el.width / 420;
  HOLO.ctx.setTransform(HOLO.k, 0, 0, HOLO.k, 0, 0);
}

function initHolo() {
  if (HOLO.inited) return true;
  HOLO.canvas = $('home-cat-canvas');
  HOLO.wrap = $('holo-tilt');
  if (!HOLO.canvas || !HOLO.wrap) return false;
  HOLO.rasterOK = holoRasterTest();
  applyHoloMaskChoice();
  HOLO.ctx = HOLO.canvas.getContext('2d');
  HOLO.parts = holoSample();
  holoResize();
  HOLO.inited = !!HOLO.ctx && HOLO.parts.length > 0;
  if (HOLO.inited) {
    new ResizeObserver(() => { if (HOLO.inited) holoResize(); }).observe(HOLO.canvas);
  }
  return HOLO.inited;
}

function holoFrame(now) {
  HOLO.raf = requestAnimationFrame(holoFrame);
  const t = (now - HOLO.t0) / 1000;
  const ctx = HOLO.ctx;
  ctx.clearRect(0, 0, 420, 520);
  ctx.globalCompositeOperation = 'lighter';

  // Помехи-срезы: раз в несколько секунд полоса фигуры сдвигается вбок
  if (!HOLO.glitch && Math.random() < 0.004) {
    HOLO.glitch = {
      y: 60 + Math.random() * 380,
      h: 8 + Math.random() * 26,
      dx: (Math.random() * 2 - 1) * 7,
      until: t + 0.1 + Math.random() * 0.12
    };
  } else if (HOLO.glitch && t > HOLO.glitch.until) {
    HOLO.glitch = null;
  }

  const scan = ((t * 34) % 600) - 40;         // скан-полоса сверху вниз
  const pulse = 0.82 + 0.18 * Math.sin(t * 1.6); // общее дыхание яркости
  const parts = HOLO.parts;
  const gl = HOLO.glitch;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    // Живое течение ВНУТРИ силуэта: частица плывёт вверх в узком окне вокруг
    // своей точки — форма кота не размывается
    const y = p.y - p.rg / 2 + ((t * 12 * p.v + p.o) % p.rg);
    const x = p.x + Math.sin(t * p.f * 1.6 + p.ph) * 1.9 +
      (gl && y > gl.y && y < gl.y + gl.h ? gl.dx : 0);
    const ds = Math.abs(y - scan);
    const scanGlow = ds < 26 ? (1 - ds / 26) : 0;

    if (p.ly === 2) {
      // Искры (глаза/нос/усы/подушечки): почти не текут, дышат, вспыхивают
      const tw = 0.55 + 0.45 * Math.sin(t * 2.1 + p.ph * 3.7);
      ctx.fillStyle = HOLO_COLD[(0.38 * tw * pulse * 19) | 0];
      ctx.fillRect(x - p.s * 1.3, y - p.s * 1.3, p.s * 2.6, p.s * 2.6); // гало
      let a = 0.72 * tw * pulse + scanGlow * 0.2;
      if (a > 1) a = 1;
      ctx.fillStyle = HOLO_SPARK[(a * 19) | 0];
      ctx.fillRect(x, y, p.s, p.s);
    } else if (p.ly === 1) {
      // Контур: детали (уши/лапы/хвост) поддержаны ярче, остальной контур
      // притушен — тело читается спокойным, детали — акцентами
      const dz = p.z;
      let a = (0.12 + p.e * 0.40) * pulse * (dz ? 1.1 : 0.55);
      if (Math.random() < (dz ? 0.05 : 0.03)) a += Math.random() * 0.20;
      a += scanGlow * (dz ? 0.28 : 0.12);
      if (a > 1) a = 1;
      ctx.fillStyle = HOLO_HOT[(a * 19) | 0];
      ctx.fillRect(x, y, p.s, p.s);
    } else {
      // Тело: спокойная ровная дымка без вспышек
      let a = (0.045 + (p.l / 255) * 0.26) * pulse;
      if (Math.random() < 0.04) a += Math.random() * 0.10;
      a += scanGlow * 0.10;
      if (a > 1) a = 1;
      ctx.fillStyle = HOLO_COLD[(a * 19) | 0];
      ctx.fillRect(x, y, p.s, p.s);
    }
  }

  // Глаза и усы — поверх частиц (векторная морда уже погашена маской)
  if (HOLO.mask) drawHoloFace(ctx, t);

  // Наклон сцены за курсором (вглубь, с инерцией)
  const tl = HOLO.tilt;
  tl.x += (tl.tx - tl.x) * 0.07;
  tl.y += (tl.ty - tl.y) * 0.07;
  HOLO.wrap.style.transform = `rotateY(${tl.y.toFixed(2)}deg) rotateX(${tl.x.toFixed(2)}deg)`;
}

function startHoloCat() {
  if (!initHolo()) return;
  holoResize();
  if (HOLO.running) return;
  HOLO.running = true;
  if (!HOLO.t0) HOLO.t0 = performance.now();
  HOLO.raf = requestAnimationFrame(holoFrame);
}

function stopHoloCat() {
  if (!HOLO.running) return;
  cancelAnimationFrame(HOLO.raf);
  HOLO.running = false;
  HOLO.glitch = null;
  if (HOLO.ctx) HOLO.ctx.clearRect(0, 0, 420, 520);
  HOLO.tilt.tx = 0; HOLO.tilt.ty = 0;
}

// Параллакс: слушаем сцену целиком, амплитуды малые — эффект вглубь
$('home-view').addEventListener('pointermove', (e) => {
  if (!HOLO.running) return;
  const r = $('home-view').getBoundingClientRect();
  const nx = (e.clientX - r.left) / Math.max(1, r.width) - 0.5;
  const ny = (e.clientY - r.top) / Math.max(1, r.height) - 0.5;
  HOLO.tilt.ty = nx * 10;
  HOLO.tilt.tx = ny * 8;
});
$('home-view').addEventListener('pointerleave', () => {
  HOLO.tilt.tx = 0;
  HOLO.tilt.ty = 0;
});

// ---------------------------------------------------------------- Главная (NK-Wave)

// Большая кнопка на главной: продолжить current, если он есть, иначе начать
// очередь из текущего списка. Иконка/состояние тянется от событий audio.
function updateHomePlay() {
  const playing = !!state.current && !audio.paused && !audio.ended;
  $('home-play').classList.toggle('playing', playing);
  $('home-play-ico-play').classList.toggle('hidden', playing);
  $('home-play-ico-pause').classList.toggle('hidden', !playing);
}

$('home-play').addEventListener('click', async () => {
  // Холодный старт: очередь ещё не собрана — подтягиваем «Мою музыку» и играем
  if (!state.current && !state.displayed.length) {
    await openView({ type: 'my' });
    if (!state.displayed.length) return;
  }
  togglePlay();
});
$('home-settings').addEventListener('click', openSettings);
audio.addEventListener('play', updateHomePlay);
audio.addEventListener('pause', updateHomePlay);
audio.addEventListener('ended', updateHomePlay);
updateHomePlay();

// ---------------------------------------------------------------- Контекстное меню

const ctxMenu = $('ctx-menu');

function closeCtxMenu() {
  ctxMenu.classList.add('hidden');
  ctxMenu.textContent = '';
}

function ctxItem(label, icon, onClick, opts = {}) {
  const btn = document.createElement('button');
  btn.className = 'ctx-item' + (opts.danger ? ' danger' : '');
  btn.setAttribute('role', 'menuitem');
  if (opts.title) btn.title = opts.title;

  const ico = document.createElement('span');
  ico.className = 'ctx-ico';
  ico.textContent = icon || '';
  const text = document.createElement('span');
  text.textContent = label;
  text.style.overflow = 'hidden';
  text.style.textOverflow = 'ellipsis';
  text.style.whiteSpace = 'nowrap';

  btn.append(ico, text);
  btn.addEventListener('click', () => {
    closeCtxMenu();
    onClick();
  });
  return btn;
}

function ctxTitle(text) {
  const div = document.createElement('div');
  div.className = 'ctx-title';
  div.textContent = text;
  return div;
}

function ctxSeparator() {
  const div = document.createElement('div');
  div.className = 'ctx-sep';
  return div;
}

// Меню позиционируем по курсору, но не выпускаем за пределы окна
function placeCtxMenu(x, y) {
  ctxMenu.classList.remove('hidden');
  ctxMenu.style.left = '0px';
  ctxMenu.style.top = '0px';
  const box = ctxMenu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - box.width - 10);
  const top = Math.min(y, window.innerHeight - box.height - 10);
  ctxMenu.style.left = Math.max(10, left) + 'px';
  ctxMenu.style.top = Math.max(10, top) + 'px';
}

document.addEventListener('mousedown', (e) => {
  if (!ctxMenu.classList.contains('hidden') && !ctxMenu.contains(e.target)) closeCtxMenu();
});
window.addEventListener('blur', closeCtxMenu);
window.addEventListener('resize', closeCtxMenu);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeCtxMenu();
    if (!$('modal-backdrop').classList.contains('hidden')) closeModal();
  }
});

// ---------------------------------------------------------------- Модальное окно

let modalResolve = null;
// 'input' — обычный ввод названия, 'confirm' — вопрос да/нет (поле ввода скрыто)
let modalMode = 'input';

function closeModal() {
  $('modal-backdrop').classList.add('hidden');
  const r = modalResolve;
  modalResolve = null;
  if (r) r(modalMode === 'confirm' ? false : null);
}

function showModal() {
  const input = $('modal-input');
  input.classList.toggle('hidden', modalMode === 'confirm');
  $('modal-ok').classList.toggle('danger', modalMode === 'confirm');
  $('modal-backdrop').classList.remove('hidden');

  setTimeout(() => {
    if (modalMode === 'confirm') {
      $('modal-ok').focus();
    } else {
      input.focus();
      input.select();
    }
  }, 30);
}

function openModal({ title, text, value = '', okLabel = 'Создать', placeholder = '' }) {
  modalMode = 'input';
  $('modal-title').textContent = title;
  $('modal-text').textContent = text;
  $('modal-ok').textContent = okLabel;
  const input = $('modal-input');
  input.value = value;
  input.placeholder = placeholder;
  showModal();

  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

// Своё подтверждение вместо window.confirm: нативный диалог блокирует рендерер
// и выглядит системным окном посреди тёмного интерфейса.
function openConfirm({ title, text, okLabel = 'Удалить' }) {
  modalMode = 'confirm';
  $('modal-title').textContent = title;
  $('modal-text').textContent = text;
  $('modal-ok').textContent = okLabel;
  $('modal-input').value = '';
  showModal();

  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

function submitModal() {
  const r = modalResolve;
  if (!r) return;

  if (modalMode === 'confirm') {
    modalResolve = null;
    $('modal-backdrop').classList.add('hidden');
    r(true);
    return;
  }

  const value = $('modal-input').value.trim();
  if (!value) {
    $('modal-input').focus();
    return;
  }
  modalResolve = null;
  $('modal-backdrop').classList.add('hidden');
  r(value);
}

$('modal-ok').addEventListener('click', submitModal);
$('modal-cancel').addEventListener('click', closeModal);
$('modal-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitModal();
});
$('modal-backdrop').addEventListener('mousedown', (e) => {
  if (e.target === $('modal-backdrop')) closeModal();
});

function renderPlaylistNav() {
  playlistNav.textContent = '';

  const frag = document.createDocumentFragment();

  // Свои плейлисты — сверху: они редактируемые
  for (const pl of state.localPlaylists) {
    frag.appendChild(createPlaylistNavItem({
      key: 'local:' + pl.id,
      playlist: pl,
      title: pl.title,
      sub: pluralTracks(pl.size),
      icon: pl.cover ? null : '★',
      cover: pl.cover,
      local: true
    }));
  }

  if (state.localPlaylists.length && state.playlists.length) {
    const sep = document.createElement('div');
    sep.className = 'nav-sep';
    frag.appendChild(sep);
  }

  // Плейлисты ВК
  for (const pl of state.playlists) {
    const key = `${pl.ownerId}_${pl.id}`;
    frag.appendChild(createPlaylistNavItem({
      key,
      playlist: pl,
      title: pl.title,
      sub: [pl.author, pluralTracks(pl.size)].filter(Boolean).join(' · '),
      icon: '☰',
      cover: pl.cover,
      local: false
    }));
  }

  if (!frag.childNodes.length) {
    const empty = document.createElement('div');
    empty.className = 'nav-sub';
    empty.style.padding = '8px 12px';
    empty.textContent = 'Плейлистов нет';
    frag.appendChild(empty);
  }

  playlistNav.appendChild(frag);
  setActiveNav();
}

function createPlaylistNavItem({ key, playlist, title, sub, icon, cover, local }) {
  const btn = document.createElement('button');
  btn.className = 'nav-item';
  btn.dataset.key = key;
  btn.title = title;

  const iconEl = document.createElement('span');
  iconEl.className = 'nav-icon';
  iconEl.setAttribute('aria-hidden', 'true');
  setCover(iconEl, cover, icon);

  const text = document.createElement('span');
  text.className = 'nav-text';
  const label = document.createElement('span');
  label.className = 'nav-label';
  label.textContent = title;
  const subEl = document.createElement('span');
  subEl.className = 'nav-sub';
  subEl.textContent = sub;
  text.append(label, subEl);

  btn.append(iconEl, text);

  // Чтобы кнопка вложенных действий не открывала плейлист, живём на mousedown
  const more = document.createElement('span');
  more.className = 'nav-more';
  more.textContent = '⋯';
  more.title = 'Действия с плейлистом';
  more.setAttribute('role', 'button');
  more.tabIndex = -1;
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    openPlaylistMenu(e, playlist, local);
  });
  btn.appendChild(more);

  btn.addEventListener('click', () => {
    if (local) openLocalPlaylist(playlist);
    else openView({ type: 'playlist', key, playlist });
  });

  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openPlaylistMenu(e, playlist, local);
  });

  return btn;
}

async function openLocalPlaylist(pl) {
  await openView({ type: 'local-playlist', id: pl.id, playlist: pl });
}

// ---------------------------------------------------------------- Список треков

// Большой список (500+ строк) целиком в DOM съедает память и тормозит на
// ресайзе окна: реflow проходит по десяткам тысяч узлов. Строки фиксированной
// высоты (58px), поэтому держим в DOM только видимое окно + запас, а снаружи —
// пустые спейсеры той же высоты: прокрутка остаётся нативной и плавной.
const ROW_H = 58;
const VIRT_THRESHOLD = 300; // меньше строк — рендерим всё как раньше
const VIRT_BUFFER = 8;      // запас строк сверху/снизу, чтобы окно не мигало

let virtEls = null;                       // { top, bottom } спейсеры
let virtWindow = { first: -1, last: -1 }; // текущее отрисованное окно
const renderedRows = [];                  // DOM-ссылки строк окна

function isVirtual() {
  return !!virtEls;
}

function renderWindow(scrollOverride) {
  if (!virtEls) return;
  const len = state.displayed.length;
  if (!len) { virtWindow = { first: -1, last: -1 }; return; }
  const scrollTop = Math.max(0, scrollOverride != null ? scrollOverride : tracksContainer.scrollTop);
  const viewH = tracksContainer.clientHeight || 600;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - VIRT_BUFFER);
  const last = Math.min(len, Math.max(first + 1, Math.ceil((scrollTop + viewH) / ROW_H) + VIRT_BUFFER));
  if (first === virtWindow.first && last === virtWindow.last) return;

  for (const el of renderedRows) el.remove();
  renderedRows.length = 0;
  const frag = document.createDocumentFragment();
  for (let i = first; i < last; i++) {
    const row = createTrackRow(state.displayed[i], i);
    renderedRows.push(row);
    frag.appendChild(row);
  }
  tracksContainer.insertBefore(frag, virtEls.bottom);
  virtEls.top.style.height = `${first * ROW_H}px`;
  virtEls.bottom.style.height = `${Math.max(0, len - last) * ROW_H}px`;
  virtWindow = { first, last };
}

// Кнопка «Показать ещё» — вне окна, живёт после нижнего спейсера
function buildLoadMoreButton() {
  const more = document.createElement('button');
  more.className = 'btn-ghost load-more';
  more.textContent = 'Показать ещё';
  more.addEventListener('click', () => loadMoreSearch(more));
  return more;
}

function renderTracks() {
  const q = filterInput.value.trim().toLowerCase();
  const all = currentViewTracks();
  state.displayed = q
    ? all.filter((t) => `${t.artist} ${t.title}`.toLowerCase().includes(q))
    : all.slice();

  // В очереди номер строки не совпадает с позицией в order, если включён фильтр,
  // поэтому запоминаем настоящие позиции по самим объектам треков.
  state.orderOf = new Map();
  if (state.view.type === 'queue') {
    state.order.forEach((trackIdx, orderPos) => {
      const t = state.queue[trackIdx];
      if (t) state.orderOf.set(t, orderPos);
    });
  }

  const keepScroll = tracksContainer.scrollTop;
  tracksContainer.textContent = '';
  virtEls = null;
  virtWindow = { first: -1, last: -1 };
  renderedRows.length = 0;

  if (!state.displayed.length) {
    showPlaceholder(q ? 'Ничего не найдено по фильтру' : 'Здесь пока пусто');
    return;
  }

  const wantLoadMore = state.view.type === 'search' && state.search.more && !q;

  if (state.displayed.length > VIRT_THRESHOLD) {
    virtEls = { top: document.createElement('div'), bottom: document.createElement('div') };
    tracksContainer.appendChild(virtEls.top);
    // Окно строим по сохранённой прокрутке: нативный scrollTop живёт дальше,
    // спейсеры задают полную высоту списка
    tracksContainer.appendChild(virtEls.bottom);
    renderWindow(keepScroll);
    if (keepScroll) tracksContainer.scrollTop = Math.min(keepScroll, Math.max(0, tracksContainer.scrollHeight - tracksContainer.clientHeight));
    if (wantLoadMore) tracksContainer.appendChild(buildLoadMoreButton());
  } else {
    const frag = document.createDocumentFragment();
    state.displayed.forEach((track, idx) => frag.appendChild(createTrackRow(track, idx)));
    if (wantLoadMore) frag.appendChild(buildLoadMoreButton());
    tracksContainer.appendChild(frag);
  }
  highlightCurrent();

  // Подзаголовок очереди пересчитывается вместе с окном, а не только при входе
  if (state.view.type === 'queue') {
    const upcoming = queueUpcoming();
    const shown = Math.min(upcoming, QUEUE_WINDOW);
    const sub = [`осталось ${upcoming}`];
    if (shown < upcoming) sub.push(`показаны первые ${QUEUE_WINDOW}`);
    $('view-sub').textContent = sub.join(' · ');
  }
}

function createTrackRow(track, idx) {
  const row = document.createElement('div');
  row.className = 'track';
  row.dataset.index = idx;
  row.dataset.id = track.id;
  row.setAttribute('role', 'listitem');
  row.tabIndex = 0;
  if (!track.local && !track.reloadId && !track.url && !track.stream) {
    row.classList.add('unavailable');
    row.title = 'Трек недоступен';
  }
  if (state.current && state.current.id === track.id) row.classList.add('active');

  const num = document.createElement('div');
  num.className = 'track-num';
  const numIndex = document.createElement('span');
  numIndex.className = 'num-index';
  numIndex.textContent = idx + 1;
  const numPlay = document.createElement('span');
  numPlay.className = 'num-play';
  numPlay.textContent = '▶';
  num.append(numIndex, numPlay);

  const cover = document.createElement('div');
  cover.className = 'track-cover';
  setCover(cover, track.cover, coverLetter(track.title), true);

  const main = document.createElement('div');
  main.className = 'track-main';
  const title = document.createElement('div');
  title.className = 'track-title';
  title.textContent = track.title;

  const artist = document.createElement('div');
  artist.className = 'track-artist';
  artist.textContent = track.artist;
  // По исполнителю можно перейти к его трекам; локальные файлы ищем в ВК так же
  if (track.artist && track.artist !== '—') {
    artist.classList.add('link');
    artist.title = `Все треки: ${track.artist}`;
    artist.addEventListener('click', (e) => {
      e.stopPropagation();
      openArtist(track.artist);
    });
  }
  main.append(title, artist);

  const dur = document.createElement('div');
  dur.className = 'track-dur';
  dur.textContent = track.duration ? formatTime(track.duration) : '—:—';

  row.append(num, cover, main, dur);

  // ---- Действия при наведении: в очередь, в плейлист, (в плейлисте) убрать
  const actions = document.createElement('div');
  actions.className = 'track-actions';

  const queueBtn = document.createElement('button');
  queueBtn.className = 'track-act';
  queueBtn.title = 'Добавить в очередь';
  queueBtn.setAttribute('aria-label', 'Добавить в очередь');
  queueBtn.textContent = '≡';
  queueBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    addToQueue(track);
  });
  actions.appendChild(queueBtn);

  const plBtn = document.createElement('button');
  plBtn.className = 'track-act';
  plBtn.title = 'Добавить в плейлист';
  plBtn.setAttribute('aria-label', 'Добавить в плейлист');
  plBtn.textContent = '＋';
  plBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openAddToPlaylist(e, track);
  });
  actions.appendChild(plBtn);

  // Удаление из конкретного плейлиста — только когда он открыт
  const cur = state.view;
  if (cur.type === 'local-playlist') {
    const pl = cur.playlist;
    const del = document.createElement('button');
    del.className = 'track-act danger';
    del.title = 'Убрать из плейлиста';
    del.setAttribute('aria-label', 'Убрать из плейлиста');
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      removeTrackFromPlaylist(pl, track);
    });
    actions.appendChild(del);
  }

  // Из очереди убираем по реальной позиции, а не по номеру строки
  if (cur.type === 'queue') {
    const orderPos = state.orderOf && state.orderOf.get(track);
    const del = document.createElement('button');
    del.className = 'track-act danger';
    del.title = 'Убрать из очереди';
    del.setAttribute('aria-label', 'Убрать из очереди');
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromQueue(orderPos);
    });
    actions.appendChild(del);
  }

  // Локальный файл убираем из библиотеки целиком
  if (track.local) {
    const del = document.createElement('button');
    del.className = 'track-act danger';
    del.title = 'Убрать из библиотеки';
    del.setAttribute('aria-label', 'Убрать из библиотеки');
    del.textContent = '🗑';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      removeLocalTrack(track);
    });
    actions.appendChild(del);
  }

  row.appendChild(actions);

  // Правая кнопка мыши — то же меню, что и по кнопке «＋»
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openTrackMenu(e, track);
  });

  return row;
}

// Меню по правому клику на треке
function openTrackMenu(e, track) {
  closeCtxMenu();
  const frag = document.createDocumentFragment();
  frag.appendChild(ctxTitle(`${track.artist} — ${track.title}`));

  frag.appendChild(ctxItem('Добавить в очередь', '≡', () => addToQueue(track)));
  frag.appendChild(ctxItem('Воспроизвести следующим', '⏭', () => playNextInQueue(track)));
  frag.appendChild(ctxItem('Добавить в плейлист…', '＋', () => openAddToPlaylist(e, track)));
  if (track.artist && track.artist !== '—') {
    frag.appendChild(ctxItem(`Все треки: ${track.artist}`, '♪', () => openArtist(track.artist)));
  }

  const cur = state.view;
  if (cur.type === 'local-playlist') {
    frag.appendChild(ctxSeparator());
    frag.appendChild(ctxItem('Убрать из плейлиста', '✕',
      () => removeTrackFromPlaylist(cur.playlist, track), { danger: true }));
  }

  ctxMenu.appendChild(frag);
  placeCtxMenu(e.clientX, e.clientY);
}

function openAddToPlaylist(e, track) {
  closeCtxMenu();
  const frag = document.createDocumentFragment();
  frag.appendChild(ctxTitle(`В плейлист: ${track.title}`));

  if (state.localPlaylists.length) {
    for (const pl of state.localPlaylists) {
      frag.appendChild(ctxItem(pl.title, '★', () => addTrackToPlaylist(pl, track)));
    }
    frag.appendChild(ctxSeparator());
  } else {
    const empty = document.createElement('div');
    empty.className = 'ctx-empty';
    empty.textContent = 'Своих плейлистов пока нет';
    frag.appendChild(empty);
  }

  frag.appendChild(ctxItem('Создать плейлист…', '＋', async () => {
    const pl = await createPlaylistFlow();
    if (pl) await addTrackToPlaylist(pl, track);
  }));

  ctxMenu.appendChild(frag);
  placeCtxMenu(e.clientX, e.clientY);
}

// Клик по уже играющему треку ставит его на паузу (или снимает с паузы),
// а не начинает воспроизведение заново.
// Пересчёт окна виртуализированного списка: только когда прокрутка/размер окна
// реально уходят за текущие границы, ре-render не происходит вообще.
let scrollFrame = 0;
let resizeFrame = 0;
tracksContainer.addEventListener('scroll', () => {
  if (!isVirtual() || scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    renderWindow();
  });
}, { passive: true });

// Ресайз окна: меняется высота контейнера → границы потолка окна сдвигаются,
// пересчитываем с rAF-троттлингом. Малые списки (без виртуализации) не трогаем.
window.addEventListener('resize', () => {
  if (!isVirtual() || resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    if (isVirtual()) {
      virtWindow = { first: -1, last: -1 };
      renderWindow();
    }
  });
});
tracksContainer.addEventListener('click', (e) => {
  if (e.target.closest('.track-act') || e.target.closest('.track-artist.link')) return;
  const row = e.target.closest('.track');
  if (!row || row.classList.contains('unavailable')) return;
  activateTrack(Number(row.dataset.index));
});

tracksContainer.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const row = e.target.closest('.track');
  if (!row || row.classList.contains('unavailable')) return;
  activateTrack(Number(row.dataset.index));
});

function activateTrack(index) {
  const track = state.displayed[index];
  if (!track) return;

  // В экране очереди клик перескакивает по уже собранной очереди,
  // а не пересобирает её заново из списка. Показанное окно начинается
  // с pos+1, поэтому настоящую позицию берём из карты orderOf.
  if (state.view.type === 'queue') {
    const orderIndex = state.orderOf && state.orderOf.get(track);
    if (orderIndex == null) return;
    const isSame = state.current && state.pos === orderIndex && (state.current.id === track.id);
    if (isSame) {
      togglePlay();
      return;
    }
    playAt(orderIndex);
    return;
  }

  const isSame = state.current && state.current.id === track.id;
  const inQueue = isSame && state.queue[state.order[state.pos]] && state.queue[state.order[state.pos]].id === track.id;

  if (isSame && inQueue) {
    togglePlay();
    return;
  }
  startQueue(state.displayed, index);
}

function highlightCurrent() {
  tracksContainer.querySelectorAll('.track.active').forEach((el) => el.classList.remove('active'));
  if (!state.current) return;
  tracksContainer.querySelectorAll(`.track[data-id="${CSS.escape(state.current.id)}"]`)
    .forEach((el) => el.classList.add('active'));
}

let filterTimer = null;
filterInput.addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(renderTracks, 150);
});

$('btn-play-view').addEventListener('click', () => {
  if (!state.displayed.length) return;
  if (state.current) {
    togglePlay();
    return;
  }
  // В очереди ничего не пересобираем — просто продолжаем от следующего трека
  if (state.view.type === 'queue') {
    const target = state.pos + 1 < state.order.length ? state.pos + 1 : 0;
    playAt(target);
    return;
  }
  startQueue(state.displayed, firstPlayable(state.displayed));
});

$('btn-shuffle-play').addEventListener('click', () => {
  if (!state.displayed.length) return;
  // Перемешивание в панели очереди тасует уже собранную очередь на месте,
  // а не собирает новую из показанного окна
  if (state.view.type === 'queue') {
    setShuffle(true);
    if (state.queue.length) {
      if (state.current) {
        highlightCurrent();
        renderTracks();
      } else {
        // Плеер стоит — просто перемешиваем существующую очередь и стартуем
        startQueue(state.queue, null);
      }
    }
    return;
  }
  setShuffle(true);
  startQueue(state.displayed, null);
});

$('btn-import').addEventListener('click', () => importMusic());

// Перетаскивание аудиофайлов из проводника прямо в окно.
// В Electron 32+ у File больше нет .path — путь берём через webUtils.
const { webUtils } = require('electron');

document.addEventListener('dragover', (e) => {
  if (!appView.classList.contains('hidden')) e.preventDefault();
});
document.addEventListener('drop', async (e) => {
  if (appView.classList.contains('hidden')) return;
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])]
    .map((f) => {
      try { return webUtils.getPathForFile(f); } catch (err) { return f.path || ''; }
    })
    .filter(Boolean);
  if (files.length) await importMusic(files);
});

async function importMusic(files) {
  const btn = $('btn-import');
  btn.disabled = true;
  try {
    const res = await vkCall('local:import', files);
    if (!res) return;
    const first = !state.localTracks || state.localTracks.length === 0;
    state.localTracks = res.tracks;
    updateLocalCount();
    if (state.view.type === 'local') await openView({ type: 'local' });
    else if (res.added && first) await openView({ type: 'local' });
    toast(res.added
      ? `Добавлено файлов: ${res.added}`
      : 'Новых файлов не найдено (возможно, они уже в библиотеке)');
  } catch (e) {
    toast('Не удалось добавить файлы: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

async function removeLocalTrack(track) {
  try {
    state.localTracks = await vkCall('local:remove', track.id);
    updateLocalCount();
    if (state.current && state.current.id === track.id) stopPlayback();
    await openView({ type: 'local' });
    toast(`«${track.title}» убрано из библиотеки`);
  } catch (e) {
    toast('Не удалось удалить файл: ' + e.message);
  }
}

function firstPlayable(list) {
  const i = list.findIndex((t) => t.local || t.reloadId || t.url || t.stream);
  return i === -1 ? 0 : i;
}

// ---------------------------------------------------------------- Поиск

searchInput.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const query = searchInput.value.trim();
  if (!query) return;

  state.search = { query, tracks: null, more: null };
  $('nav-search').classList.remove('hidden');
  $('nav-search-q').textContent = query;
  openView({ type: 'search' });

  try {
    const res = await vkCall('audio:search', query);
    if (!state.search || state.search.query !== query) return;
    state.search.tracks = stampTracks(res.tracks);
    state.search.more = res.more;
    if (state.view.type === 'search') openView({ type: 'search' });
  } catch (err) {
    if (state.view.type === 'search') showPlaceholder(err.message, true);
  }
});

async function loadMoreSearch(button) {
  const s = state.search;
  if (!s || !s.more) return;
  button.disabled = true;
  button.textContent = 'Загрузка…';
  try {
    const res = await vkCall('audio:searchMore', s.more);
    if (state.search !== s) return;
    const known = new Set(s.tracks.map((t) => t.id));
    s.tracks = s.tracks.concat(stampTracks(res.tracks).filter((t) => !known.has(t.id)));
    s.more = res.more;
    if (state.view.type === 'search') {
      const scroll = tracksContainer.scrollTop;
      $('view-sub').textContent = pluralTracks(s.tracks.length) + (s.more ? '+' : '');
      renderTracks();
      tracksContainer.scrollTop = scroll;
    }
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Ошибка, повторить';
  }
}

// ---------------------------------------------------------------- Артист

// Отдельного метода «треки артиста» в al_audio.php нет, а поиск по имени даёт
// как самого артиста, так и каверы. Поэтому ищем по имени и оставляем только
// совпадения по исполнителю, дополнительно подмешивая треки из своей библиотеки.
function normalizeArtist(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function sameArtist(a, b) {
  const x = normalizeArtist(a);
  const y = normalizeArtist(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // «Исполнитель feat. Кто-то» и «Исполнитель & Кто-то» считаем тем же артистом
  const cut = (s) => s.split(' feat')[0].split(' ft ')[0].split(' & ')[0].split(',')[0].trim();
  return cut(x) === cut(y);
}

async function openArtist(name) {
  const clean = String(name || '').trim();
  if (!clean) return;

  const view = { type: 'artist', name: clean, tracks: null, more: null };
  openView(view);
  setActiveNav();

  try {
    const res = await vkCall('audio:search', clean);
    if (state.view !== view) return;

    const seen = new Set();
    // Один и тот же трек ВК отдаёт с разными id (например, из разных плейлистов),
    // поэтому дубликаты ловим ещё и по паре «исполнитель + название».
    const seenNames = new Set();
    const keyOf = (t) => `${normalizeArtist(t.artist)}\u0000${String(t.title || '').toLowerCase().trim()}`;
    const out = [];

    const push = (t) => {
      if (seen.has(t.id) || seenNames.has(keyOf(t))) return;
      seen.add(t.id);
      seenNames.add(keyOf(t));
      out.push(t);
    };

    // Сначала — треки из своей библиотеки: они уже с обложками и не тратят лимит ВК
    for (const t of state.myTracks || []) {
      if (sameArtist(t.artist, clean)) push(t);
    }
    for (const t of stampTracks(res.tracks || [])) {
      if (sameArtist(t.artist, clean)) push(t);
    }

    view.tracks = out;
    view.more = res.more || null;

    if (state.view === view) {
      if (!out.length) {
        setHeader({ kind: 'Артист', title: clean, sub: '', icon: '♪' });
        showPlaceholder(`Треков в исполнении «${clean}» не найдено. Попробуйте поиск по названию.`, false, {
          label: 'Открыть поиск',
          onClick: () => {
            searchInput.value = clean;
            searchInput.focus();
          }
        });
        return;
      }
      // Плюс здесь не нужен: список уже отфильтрован по исполнителю
      $('view-sub').textContent = pluralTracks(out.length);
      renderTracks();
      state.prefetchActive = true;
      schedulePrefetch(out);
    }
  } catch (err) {
    if (state.view === view) showPlaceholder('Не удалось загрузить треки артиста: ' + err.message, true);
  }
}

// ---------------------------------------------------------------- Очередь

function buildOrder(startIndex) {
  const n = state.queue.length;
  const order = [...Array(n).keys()];
  if (state.shuffle) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    if (startIndex != null) {
      const at = order.indexOf(startIndex);
      [order[0], order[at]] = [order[at], order[0]];
    }
    state.pos = 0;
  } else {
    state.pos = startIndex == null ? 0 : startIndex;
  }
  state.order = order;
}

// startIndex === null — начать со случайного трека (для перемешивания)
function startQueue(list, startIndex) {
  state.queue = list.slice();
  buildOrder(startIndex);
  updateQueueNav();
  playAt(state.pos);
}

// ---------------------------------------------------------------- Очередь: добавление

// Счётчик у «Очереди» в сайдбаре: равен окну предстоящих треков в панели
// (с потолком QUEUE_WINDOW) и уменьшается по мере отыгрывания треков
function updateQueueNav() {
  const el = $('nav-queue-count');
  if (!el) return;
  const shown = Math.min(queueUpcoming(), QUEUE_WINDOW);
  el.textContent = shown ? pluralTracks(shown) : '';
}

// Кладём копию трека: у одного и того же трека могут быть разные ссылки,
// и объект из «Моей музыки» нельзя переиспользовать в очереди напрямую.
function enqueueTrack(track) {
  const item = { ...track };
  state.queue.push(item);
  const idx = state.queue.length - 1;

  // Новый трек встаёт в начало очереди — сразу после играющего
  if (state.pos >= 0) {
    state.order.splice(state.pos + 1, 0, idx);
  } else {
    state.order.push(idx);
  }
  updateQueueNav();
  // Открытая панель очереди сразу показывает новый состав
  if (state.view.type === 'queue') renderTracks();
  return idx;
}

// Удаление из очереди. Текущий трек не трогаем: сначала нужно переключиться,
// иначе плеер останется без источника.
// state.queue — сами треки, state.order — порядок воспроизведения (индексы в queue),
// state.pos — позиция в order. Удаляем запись из order и сдвигаем pos.
function removeFromQueue(orderIndex) {
  if (orderIndex === state.pos) {
    toast('Нельзя убрать трек, который играет прямо сейчас');
    return;
  }
  const track = state.queue[state.order[orderIndex]];
  if (!track) return;

  state.order.splice(orderIndex, 1);
  if (orderIndex < state.pos) state.pos -= 1;
  updateQueueNav();
  if (state.view.type === 'queue') openView({ type: 'queue' });
  toast(`«${track.title}» убрана из очереди`);
}

function addToQueue(track) {
  if (!track) return;

  // Если ничего не играет — добавление в очередь логично начать сразу
  if (!state.current || !state.order.length) {
    startQueue([track], 0);
    toast(`«${track.title}» — играет`);
    return;
  }

  enqueueTrack(track);
  const left = state.order.length - state.pos - 1;
  toast(`«${track.title}» в очереди · ${left > 1 ? `далее ${pluralTracks(left)}` : 'следующим'}`);
}

function playNextInQueue(track) {
  if (!track) return;
  if (!state.current || !state.order.length) {
    startQueue([track], 0);
    return;
  }
  enqueueTrack(track);
  toast(`«${track.title}» заиграет следующим`);
}

function setShuffle(on) {
  state.shuffle = on;
  btnShuffle.classList.toggle('on', on);
  btnShuffle.setAttribute('aria-pressed', String(on));
  localStorage.setItem('shuffle', on ? '1' : '0');
  if (state.current && state.queue.length) {
    buildOrder(state.order[state.pos]);
  }
}

function setRepeat(mode) {
  state.repeat = mode;
  btnRepeat.classList.toggle('on', mode !== 'off');
  btnRepeat.textContent = mode === 'one' ? '↻1' : '↻';
  btnRepeat.title = { off: 'Повтор выключен', all: 'Повтор списка', one: 'Повтор трека' }[mode];
  btnRepeat.setAttribute('aria-pressed', String(mode !== 'off'));
  localStorage.setItem('repeat', mode);
}

btnShuffle.addEventListener('click', () => setShuffle(!state.shuffle));
btnRepeat.addEventListener('click', () => {
  setRepeat({ off: 'all', all: 'one', one: 'off' }[state.repeat]);
});

function isFresh(t) {
  return t.url && Date.now() - (t.urlTime || 0) < URL_TTL;
}

function hasLiveStream(t) {
  return t.stream && (!t.streamExpires || t.streamExpires > Date.now() + 60 * 1000);
}

// Запрашивает ссылки для трека и нескольких следующих в очереди.
// Прямая ссылка okcdn (audio_streams — та же, что у веб-плеера vk.ru) всегда
// свежая и не тратит лимит reload_audio, поэтому берём её первой. Для
// самозалитов это главный источник: расшифрованная ссылка почти всегда
// ведёт на старый медленный cs*-хост.
async function ensureUrls(pos, force) {
  const track = state.queue[state.order[pos]];
  if (!track) return '';
  if (track.local) return track.url;
  if (hasLiveStream(track)) return track.stream;
  if (!force && isFresh(track)) return track.url;
  if (!track.reloadId) return track.url || '';

  const batch = [track];
  for (let p = pos + 1; p < state.order.length && batch.length < 10; p++) {
    const t = state.queue[state.order[p]];
    if (t && !t.local && t.reloadId && !isFresh(t) && !hasLiveStream(t)) batch.push(t);
  }

  let urls = {};
  let streams = {};
  let rateLimited = false;
  try {
    const res = await vkCall('audio:resolve', { ids: batch.map((t) => t.reloadId) });
    urls = res.urls || {};
    streams = res.streams || {};
    rateLimited = !!res.rateLimited;
  } catch (e) {
    urls = {};
  }
  const now = Date.now();
  for (const t of batch) {
    if (urls[t.id]) {
      t.url = urls[t.id];
      t.urlTime = now;
    }
    if (streams[t.id]) {
      t.stream = streams[t.id].url;
      t.streamExpires = streams[t.id].expires;
    }
  }
  // Пока резолвим треки рядом с играющим — сразу греем их HLS-ссылки, иначе
  // холодный самозалит при переходе будет тянуть сегмент 15-30 секунд
  warmUploads(batch.map((t) => ({ id: t.id, urls: linksForWarm(t) })));

  // После обновления сначала пробуем свежую ссылку okcdn, старую — в запас
  if (hasLiveStream(track)) return track.stream;
  const own = urls[track.id];
  if (own) return own;
  if (rateLimited) throw new Error('VK_RATE_LIMIT');
  return '';
}

async function playAt(pos, { force = false, skipped = 0, waits = 0 } = {}) {
  const track = state.queue[state.order[pos]];
  if (!track) return;

  const token = ++state.playToken;
  // Кроссфейд: это целевой переход — теневой хвост продолжает дотягивать старый
  // трек, иначе переход (например, ручной клик) просто гасит его.
  if (!(cf.blend && cf.blendPos === pos)) cfCleanup();
  state.pos = pos;
  state.current = track;
  if (!force) state.retried = false;
  updateNowPlaying();
  highlightCurrent();
  updateQueueNav();
  // Панель очереди показывает предстоящие треки — на новом треке окно сдвигается
  if (state.view.type === 'queue') renderTracks();

  // Постоянный кэш: файл уже на диске — стартуем мгновенно, без ссылок и сети
  if (!force && !track.local) {
    const cached = await cachedFileUrl(track);
    if (token === state.playToken && cached) {
      loadSource(cached);
      storeUpcoming(pos);
      return;
    }
  }

  let url = '';
  let rateLimited = false;
  try {
    url = await ensureUrls(pos, force);
  } catch (e) {
    url = '';
    rateLimited = e.message === 'VK_RATE_LIMIT';
  }
  if (token !== state.playToken) return;

  if (!url && rateLimited && waits < 5) {
    // ВК упирается в собственную квоту (~400 ссылок за окно, потом no_audios
    // «через минуту»). Ждём нарастающими паузами и продолжаем сами: очередь
    // должна сдвинуться, как только окно квоты откроется снова, — без
    // перезапуска приложения и без участия пользователя.
    $('current-artist').textContent = 'Получаем ссылку…';
    await sleep([6000, 15000, 30000, 60000, 60000][waits]);
    if (token !== state.playToken) return;
    return playAt(pos, { force: true, skipped, waits: waits + 1 });
  }

  if (!url) {
    if (rateLimited) {
      stopPlayback();
      $('current-artist').textContent = 'ВК не выдал ссылку. Нажмите ▶ ещё раз через минуту';
      return;
    }
    // Недоступный трек — переходим к следующему, но не бесконечно
    if (skipped < 20) {
      const next = nextPos();
      if (next !== -1 && next !== pos) return playAt(next, { skipped: skipped + 1 });
    }
    stopPlayback();
    $('current-artist').textContent = 'Трек недоступен';
    return;
  }

  loadSource(url);
  // Текущий и ближайшие треки фоном попадают в постоянный кэш
  storeUpcoming(pos);
}

function loadSource(url) {
  if (hls) { hls.destroy(); hls = null; }

  // Граф эквалайзера собираем до старта: элемент можно подключить к Web Audio
  // только один раз, и лучше сделать это сразу, чем переключать на ходу.
  // Граф собираем до старта: элемент подключается к Web Audio один раз, здесь
  // же вся цепочка эффектов (бас/surround/нормализация/фейд).
  ensureEqGraph();

  // Уровень нового трека: обычный переход — сразу полная громкость, кроссфейд —
  // нарастание из нуля за время смешения, пока теневой хвост затихает.
  if (fx.ctx && fx.fadeGain && !eq.failed) {
    const t = fx.ctx.currentTime;
    fx.fadeGain.gain.cancelScheduledValues(t);
    if (cf.blend && settings.crossfade > 0) {
      fx.fadeGain.gain.setValueAtTime(0.0001, t);
      fx.fadeGain.gain.exponentialRampToValueAtTime(1, t + Math.max(0.4, settings.crossfade));
    } else {
      fx.fadeGain.gain.setValueAtTime(1, t);
    }
  }

  if (url.includes('.m3u8') && Hls.isSupported()) {
    // startFragPrefetch качает первый сегмент параллельно манифесту — экономит
    // секунду-другую на старте. fragLoadingTimeOut поднят: холодный сегмент
    // самозалита ВК собирает до 40 с, дефолтные 20 с рвали его на ретраи.
    hls = new Hls({
      enableWorker: true,
      startFragPrefetch: true,
      fragLoadingTimeOut: 45000,
      fragLoadingMaxRetry: 4,
      maxBufferLength: 12,
      maxMaxBufferLength: 90,
      backBufferLength: 30
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) onPlaybackError();
    });
    hls.loadSource(url);
    hls.attachMedia(audio);
    hls.on(Hls.Events.MANIFEST_PARSED, () => audio.play().catch(() => {}));
  } else {
    audio.src = url;
    audio.play().catch(() => {});
  }
}

// Ссылка могла протухнуть или okcdn-стрим не заиграл — сбрасываем источник и
// перезапрашиваем один раз, иначе следующий трек
function onPlaybackError() {
  if (!state.current) return;
  if (state.current.local) return;
  if (!state.retried) {
    state.retried = true;
    // Стрим не сыгрался: сбрасываем кеш ссылок, чтобы force-запрос выдал новые
    state.current.stream = '';
    state.current.streamExpires = 0;
    state.current.urlTime = 0;
    playAt(state.pos, { force: true });
    return;
  }
  const next = nextPos();
  if (next !== -1 && next !== state.pos) playAt(next);
}

audio.addEventListener('error', () => {
  if (!hls && audio.src) onPlaybackError();
});

function stopPlayback() {
  state.playToken++;
  cfCleanup();
  if (hls) { hls.destroy(); hls = null; }
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  state.current = null;
  updateNowPlaying();
  highlightCurrent();
}

function nextPos() {
  if (!state.order.length) return -1;
  if (state.pos + 1 < state.order.length) return state.pos + 1;
  return state.repeat === 'all' ? 0 : -1;
}

function playNext() {
  const next = nextPos();
  if (next !== -1) playAt(next);
}

function playPrev() {
  if (audio.currentTime > 3 || state.pos <= 0) {
    audio.currentTime = 0;
    return;
  }
  playAt(state.pos - 1);
}

$('btn-next').addEventListener('click', playNext);
$('btn-prev').addEventListener('click', playPrev);

audio.addEventListener('loadedmetadata', () => {
  // Длительность локального файла узнаём только после загрузки — запоминаем
  if (state.current && state.current.local && isFinite(audio.duration)) {
    const dur = Math.round(audio.duration);
    if (dur && Math.abs(dur - (state.current.duration || 0)) > 1) {
      state.current.duration = dur;
      ipcRenderer.invoke('local:duration', { id: state.current.id, duration: dur });
      const row = tracksContainer.querySelector(`.track[data-id="${CSS.escape(state.current.id)}"] .track-dur`);
      if (row) row.textContent = formatTime(dur);
      $('time-total').textContent = formatTime(dur);
    }
  }
});

audio.addEventListener('ended', () => {
  if (state.repeat === 'one') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  playNext();
});

function togglePlay() {
  if (!state.current) {
    if (state.displayed.length) startQueue(state.displayed, firstPlayable(state.displayed));
    return;
  }
  if (audio.paused) {
    audio.play().catch(() => {});
  } else {
    pauseWithFade();
  }
}

btnPlayPause.addEventListener('click', togglePlay);

audio.addEventListener('play', () => {
  btnPlayPause.textContent = '⏸';
  btnPlayPause.setAttribute('aria-label', 'Пауза');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  resumeEq();
  pushDiscordPresence();
});
audio.addEventListener('pause', () => {
  btnPlayPause.textContent = '▶';
  btnPlayPause.setAttribute('aria-label', 'Воспроизведение');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  pushDiscordPresence();
});
// Перемотка меняет только таймстемпы — обновляем статус, чтобы полоска в
// Discord встала на новое место
audio.addEventListener('seeked', () => {
  if (state.current) pushDiscordPresence();
});

// ---------------------------------------------------------------- Эквалайзер

// Web Audio подключается к <audio> один раз; дальше только меняем коэффициенты.
const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
  'Плоско': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Бас': [7, 6, 5, 3, 1, 0, 0, 0, 0, 0],
  'Бас+': [10, 8, 6, 4, 1, 0, -1, 0, 1, 2],
  'Вокал': [-2, -1, 0, 2, 4, 5, 4, 2, 0, -1],
  'Рок': [5, 4, 2, 0, -1, -1, 1, 3, 5, 6],
  'Поп': [-1, 0, 1, 3, 4, 4, 2, 0, -1, -1],
  'Тише ночью': [-6, -5, -4, -3, -2, -2, -3, -4, -5, -6]
};

// ---------------------------------------------------------------- Настройки

// Перечень пользовательских настроек:Playback (кроссфейд, нормализация, бас,
// surround, фейд-пауза) и служебное (лимит кэша). Хранятся в localStorage.
const SETTINGS_KEY = 'nk.settings.v1';
const DEFAULT_SETTINGS = {
  crossfade: 0,        // сек, 0..12
  normalize: false,    // подравнивание громкости
  bassBoost: 0,        // дБ, 0..12
  surround: false,     // расширение стереобазы
  fadePause: true,     // плавное затухание при паузе
  cacheLimitMB: 2048   // 50..5120 МБ
};
let settings = (() => {
  try {
    return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {});
  } catch (e) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
})();

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ок */ }
}

// ---------------------------------------------------------------- Цепочка эффектов

// Цепочка эффектов поверх эквалайзера: бас → surround → нормализация → фейд.
// Все узлы всегда в графе, но прозрачны, пока соответствующая опция выключена.
const fx = {
  ctx: null, bass: null, bypass: null, haasMix: null,
  normGain: null, analyser: null, fadeGain: null, agcTimer: 0
};

const eq = {
  ctx: null,
  nodes: [],
  gain: null,
  enabled: true,
  gains: EQ_FREQS.map(() => 0),
  preset: 'Плоско',
  preamp: 0,
  failed: false
};

// Web Audio требует создать граф ровно один раз на элемент: повторный
// createMediaElementSource бросает исключение и глушит звук. Если граф
// собрать не удалось, снимаем всё и отдаём звук обратно элементу напрямую.
function ensureEqGraph() {
  if (eq.ctx || eq.failed) return !!eq.ctx;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { eq.failed = true; return false; }

    const ctx = new Ctx();
    const src = ctx.createMediaElementSource(audio);
    const nodes = EQ_FREQS.map((freq) => {
      const node = ctx.createBiquadFilter();
      node.type = 'peaking';
      node.frequency.value = freq;
      node.Q.value = 1.1;
      node.gain.value = 0;
      return node;
    });
    const gain = ctx.createGain();
    let prev = src;
    for (const node of nodes) {
      prev.connect(node);
      prev = node;
    }
    prev.connect(gain);

    // Далее общий граф эффектов (всегда в цепочке, прозрачный пока выключено):
    // бас → surround(вход) → нормализация → затухание → выход.
    const bass = ctx.createBiquadFilter();
    bass.type = 'lowshelf';
    bass.frequency.value = 90;
    bass.gain.value = 0;

    const wideIn = ctx.createGain();
    const bypass = ctx.createGain();   // прямая дорожка, когда surround выключен
    const haasMix = ctx.createGain();  // дорожка расширения стереобазы
    haasMix.gain.value = 0;

    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const directL = ctx.createGain(); directL.gain.value = 0.8;
    const directR = ctx.createGain(); directR.gain.value = 0.8;
    const crossL = ctx.createDelay(0.05); crossL.delayTime.value = 0.011;
    const crossR = ctx.createDelay(0.05); crossR.delayTime.value = 0.011;
    const xGainL = ctx.createGain(); xGainL.gain.value = 0.35;
    const xGainR = ctx.createGain(); xGainR.gain.value = 0.35;

    wideIn.connect(bypass);
    wideIn.connect(splitter);
    splitter.connect(directL, 0); directL.connect(merger, 0, 0);
    splitter.connect(directR, 1); directR.connect(merger, 0, 1);
    // Чуть задержанные перекрёстные копии каналов — классическое расширение базы
    splitter.connect(crossL, 0); crossL.connect(xGainL); xGainL.connect(merger, 0, 1);
    splitter.connect(crossR, 1); crossR.connect(xGainR); xGainR.connect(merger, 0, 0);
    merger.connect(haasMix);

    // Нормализация громкости: авто-гейн по измеренному уровню потока
    const normGain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.6;
    bypass.connect(analyser);    // уровень меряем до нормализации
    haasMix.connect(analyser);
    bypass.connect(normGain);
    haasMix.connect(normGain);

    // Затухание при паузе и кроссфейд: мастер-гейн плеера
    const fadeGain = ctx.createGain();
    normGain.connect(fadeGain);
    fadeGain.connect(ctx.destination);

    gain.connect(bass);
    bass.connect(wideIn);

    eq.ctx = ctx;
    eq.nodes = nodes;
    eq.gain = gain;

    fx.ctx = ctx;
    fx.bass = bass;
    fx.bypass = bypass;
    fx.haasMix = haasMix;
    fx.normGain = normGain;
    fx.analyser = analyser;
    fx.fadeGain = fadeGain;

    applyEq();
    applyFx();
    return true;
  } catch (e) {
    // Если элемент уже был подключён к графу, звук продолжает идти через него.
    eq.ctx = null;
    eq.nodes = [];
    eq.gain = null;
    eq.failed = true;
    fx.ctx = null;
    fx.agcTimer = 0;
    return false;
  }
}

function applyEq() {
  if (!eq.ctx) return;
  const active = eq.enabled;
  eq.nodes.forEach((node, i) => {
    const db = active ? eq.gains[i] : 0;
    node.gain.setTargetAtTime(db, eq.ctx.currentTime, 0.02);
  });
  // Выключенный эквалайзер не должен менять уровень: фильтры в 0 дБ прозрачны,
  // поэтому усиление возвращаем ровно к единице.
  const linear = Math.pow(10, eq.preamp / 20);
  eq.gain.gain.setTargetAtTime(active ? linear : 1, eq.ctx.currentTime, 0.03);
}

function resumeEq() {
  if (eq.ctx && eq.ctx.state === 'suspended') eq.ctx.resume().catch(() => {});
}

// Перекладываем настройки в узлы графа (бас, surround, нормализация)
function applyFx() {
  if (!fx.ctx) return;
  const t = fx.ctx.currentTime;
  if (fx.bass) fx.bass.gain.setTargetAtTime(settings.bassBoost, t, 0.08);
  if (fx.bypass) fx.bypass.gain.setTargetAtTime(settings.surround ? 0 : 1, t, 0.05);
  if (fx.haasMix) fx.haasMix.gain.setTargetAtTime(settings.surround ? 1 : 0, t, 0.05);
  if (!settings.normalize && fx.normGain) fx.normGain.gain.setTargetAtTime(1, t, 0.3);
  restartAgc();
}

// Авто-гейн: держим средний уровень потока около −18 dBFS, чтобы треки
// «не прыгали» громкостью. Медленно и с ограничениями, без агрессии.
const AGC_BUF = new Float32Array(2048);
function agcTick() {
  if (!fx.analyser || !fx.ctx || audio.paused) return;
  try { fx.analyser.getFloatTimeDomainData(AGC_BUF); } catch (e) { return; }
  let sum = 0;
  for (let i = 0; i < AGC_BUF.length; i++) sum += AGC_BUF[i] * AGC_BUF[i];
  const rms = Math.sqrt(sum / AGC_BUF.length);
  if (rms < 0.004) return; // тишина/ пауза — не «поднимаем» пустоту
  const target = 0.125;    // ≈ −18 dBFS
  const want = Math.min(3.0, Math.max(0.5, target / rms));
  const cur = fx.normGain.gain.value;
  const next = cur + (want - cur) * 0.22;
  fx.normGain.gain.setTargetAtTime(next, fx.ctx.currentTime, 0.4);
}

function restartAgc() {
  if (fx.agcTimer) { clearInterval(fx.agcTimer); fx.agcTimer = 0; }
  if (!fx.ctx) return;
  if (settings.normalize && fx.analyser && fx.normGain) {
    fx.agcTimer = setInterval(agcTick, 400);
  }
}

// Мастер-гейн возвращаем в единицу (после затухания/кроссфейда)
function restoreFadeGain() {
  if (!fx.ctx || !fx.fadeGain) return;
  const t = fx.ctx.currentTime;
  fx.fadeGain.gain.cancelScheduledValues(t);
  fx.fadeGain.gain.setValueAtTime(1, t);
}

// Плавное затухание при паузе: сначала гейн в ноль, потом элемент на паузу.
// Кроссфейд-смешение не трогаем — под ним своя логика уровней.
function pauseWithFade() {
  if (!fx.ctx || eq.failed || !settings.fadePause) { audio.pause(); return; }
  const t = fx.ctx.currentTime;
  if (!cf.blend) {
    fx.fadeGain.gain.cancelScheduledValues(t);
    fx.fadeGain.gain.setTargetAtTime(0.0001, t, 0.08); // ~240 мс
  }
  setTimeout(() => {
    audio.pause();
    // Пока пауза — возвращаем гейн к единице: после снятия паузы звук сразу полный
    if (fx.ctx && !cf.blend) restoreFadeGain();
  }, 220);
}

// ---------------------------------------------------------------- Кроссфейд

// Схема: за CF-секунды до конца текущего трека переключаем главный <audio> на
// следующий трек сразу (он нарастает из нуля за CF), а хвост старого дотягивает
// теневой элемент audio2 через собственный гейн, затухающий параллельно.
// Состояние, прогресс и очередь остаются на главном элементе — рисков минимум.
const cf = { blend: false, blendPos: -1, audio2: null, source: null, gain: null, timer: 0 };

function cfCleanup() {
  if (cf.timer) { clearTimeout(cf.timer); cf.timer = 0; }
  cf.blend = false;
  cf.blendPos = -1;
  if (cf.audio2) {
    try {
      cf.audio2.pause();
      cf.audio2.removeAttribute('src');
      cf.audio2.load();
    } catch (e) { /* ок */ }
  }
  if (cf.gain && fx.ctx) {
    const t = fx.ctx.currentTime;
    cf.gain.gain.cancelScheduledValues(t);
    cf.gain.gain.setValueAtTime(0, t);
  }
}

// Запускает теневой хвост старого трека; вызывает ПЕРЕД playAt(next),
// чтобы основной элемент мгновенно освободился под новый источник.
function cfStartTail() {
  if (!fx.ctx || eq.failed) return false;
  const played = audio.currentSrc || audio.src || '';
  if (!played) return false;
  if (!cf.audio2) {
    cf.audio2 = document.createElement('audio');
    cf.audio2.preload = 'auto';
  }
  const t = fx.ctx.currentTime;
  cf.audio2.src = played;
  try { cf.audio2.currentTime = audio.currentTime || 0; } catch (e) { /* ещё не готово */ }
  if (!cf.source) {
    cf.source = fx.ctx.createMediaElementSource(cf.audio2);
    cf.gain = fx.ctx.createGain();
    cf.gain.gain.value = 0;
    cf.source.connect(cf.gain);
    cf.gain.connect(fx.ctx.destination);
  }
  cf.blend = true;
  // Позиция целевого трека в order — её использует playAt; заодно guard в playAt
  cf.blendPos = state.pos + 1 < state.order.length ? state.pos + 1 : -1;
  // Хвост играет на полном уровне, пока основной уже escalate на новый трек
  const span = Math.max(0.4, settings.crossfade);
  cf.gain.gain.cancelScheduledValues(t);
  cf.gain.gain.setValueAtTime(1, t);
  cf.gain.gain.linearRampToValueAtTime(0.0001, t + span);
  // Хостинг: главный элемент мгновенно переходит на новый источник — его гейном
  // мы управляем из loadSource (fade-in). Хвост сам заглушится: убираем следы.
  cf.timer = setTimeout(() => {
    if (cf.blend) { cf.blend = false; cf.blendPos = -1; }
    if (cf.audio2) { try { cf.audio2.pause(); } catch (e) {} }
    restoreFadeGain();
  }, (span + 0.6) * 1000);
  return true;
}

function crossfadeTick() {
  const CF = Number(settings.crossfade) || 0;
  if (CF <= 0 || cf.blend || isSeeking) return;
  if (!state.current || state.repeat === 'one') return;
  const remain = audio.duration - audio.currentTime;
  if (!isFinite(remain) || remain <= 0) return;
  if (remain > CF) return;
  // Перекрытие имеет смысл только когда есть куда переходить
  const next = nextPos();
  if (next === -1 || next === state.pos) return;
  // Момент переключения: хвостовой гейн продолжает старый трек, основной
  // элемент сразу уходит под новый источник (fade-in делает loadSource)
  if (!cfStartTail()) return; // нет Web Audio — остаётся обычный ended-переход
  playAt(next);
}

// ---------------------------------------------------------------- Настройки UI

function fmtCacheValue(mb) {
  return mb >= 1024 ? `${Math.round(mb / 102) / 10} ГБ` : `${mb} МБ`;
}

async function refreshCacheStats() {
  try {
    const res = await ipcRenderer.invoke('cache:stats');
    const used = res && res.success ? res.data : null;
    if (used && typeof used.bytes === 'number') {
      const mb = Math.round(used.bytes / 1048576);
      const limitMb = Math.round((used.limitBytes || 0) / 1048576);
      $('s-cache-used').textContent = used.count
        ? `Занято ${mb >= 1024 ? Math.round(mb / 102) / 10 + ' ГБ' : mb + ' МБ'} из ${fmtCacheValue(limitMb)} · треков: ${used.count}`
        : `Пусто · лимит ${fmtCacheValue(limitMb)}`;
    }
  } catch (e) { /* панель работает и без статистики */ }
}

function fillSettingsUI() {
  $('s-crossfade').value = settings.crossfade;
  $('s-crossfade-v').textContent = settings.crossfade > 0 ? `${settings.crossfade} с` : 'Выкл';
  $('s-normalize').checked = settings.normalize;
  $('s-bass').value = settings.bassBoost;
  $('s-bass-v').textContent = `${settings.bassBoost} дБ`;
  $('s-surround').checked = settings.surround;
  $('s-fade').checked = settings.fadePause;
  $('s-cache').value = settings.cacheLimitMB;
  $('s-cache-v').textContent = fmtCacheValue(settings.cacheLimitMB);
  refreshCacheStats();
}

function openSettings() {
  fillSettingsUI();
  $('settings-backdrop').classList.remove('hidden');
}

function closeSettings() {
  $('settings-backdrop').classList.add('hidden');
}

function applyAllSettings() {
  applyFx();
  saveSettings();
}

function bindSettingsUI() {
  $('btn-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-done').addEventListener('click', closeSettings);
  $('settings-backdrop').addEventListener('mousedown', (e) => {
    if (e.target === $('settings-backdrop')) closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('settings-backdrop').classList.contains('hidden')) closeSettings();
  });

  // Воспроизведение
  $('s-crossfade').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    settings.crossfade = v;
    $('s-crossfade-v').textContent = v > 0 ? `${v} с` : 'Выкл';
    applyAllSettings();
  });

  $('s-normalize').addEventListener('change', (e) => {
    settings.normalize = e.target.checked;
    applyAllSettings();
    toast(settings.normalize ? 'Нормализация громкости включена' : 'Нормализация громкости выключена');
  });

  $('s-bass').addEventListener('input', (e) => {
    settings.bassBoost = Number(e.target.value);
    $('s-bass-v').textContent = `${settings.bassBoost} дБ`;
    applyAllSettings();
  });

  $('s-surround').addEventListener('change', (e) => {
    settings.surround = e.target.checked;
    applyAllSettings();
    toast(settings.surround ? 'Surround включён' : 'Surround выключен');
  });

  $('s-fade').addEventListener('change', (e) => {
    settings.fadePause = e.target.checked;
    applyAllSettings();
  });

  // Служебное
  $('s-cache').addEventListener('input', (e) => {
    const mb = Number(e.target.value);
    settings.cacheLimitMB = mb;
    $('s-cache-v').textContent = fmtCacheValue(mb);
    saveSettings();
  });
  $('s-cache').addEventListener('change', (e) => {
    ipcRenderer.invoke('cache:limit', { bytes: Number(e.target.value) * 1048576 });
    refreshCacheStats();
  });

  $('s-cache-clear').addEventListener('click', async () => {
    const res = await ipcRenderer.invoke('cache:clear');
    if (res && res.success) toast(`Кэш очищен (удалено: ${res.data && res.data.count || 0})`);
    else toast('Не удалось очистить кэш');
    localHits.clear(); //Скачать файлы больше нет — кэш-хиты непинную очистить
    refreshCacheStats();
  });

  $('s-update').addEventListener('click', async () => {
    const btn = $('s-update');
    const out = $('s-update-state');
    btn.disabled = true;
    btn.textContent = 'Проверяем…';
    try {
      const res = await ipcRenderer.invoke('update:check', { force: true });
      const info = res && res.success ? res.data : null;
      if (!info) throw new Error((res && res.error) || 'Нет ответа');
      if (info.error) out.textContent = 'Ошибка: ' + info.error;
      else if (info.updateAvailable) out.textContent = `Доступна версия ${info.latest} — баннер вверху`;
      else out.textContent = `Установлена последняя (v${info.current})`;
    } catch (err) {
      out.textContent = 'Ошибка: ' + err.message;
    }
    btn.disabled = false;
    btn.textContent = 'Проверить';
  });

  $('s-reset').addEventListener('click', () => {
    settings = Object.assign({}, DEFAULT_SETTINGS);
    saveSettings();
    applyFx();
    ipcRenderer.invoke('cache:limit', { bytes: settings.cacheLimitMB * 1048576 }).catch(() => {});
    fillSettingsUI();
    toast('Настройки сброшены');
  });
}

bindSettingsUI();

// ---------------------------------------------------------------- Окно обновлений

// Кнопка ⬇ в титульной панели: проверка релиза, фоновое скачивание с прогрессом
// и тихая установка через NSIS /S (установщик сам подменяет файлы и перезапускает).
let updApply = null;  // { asset, latest, current, pageUrl } — когда доступна новая версия
let updBusy = false;  // идёт скачивание
let updFile = null;   // { done, error } — результат скачивания, переживает закрытие окна

function updSetStatus(text) {
  $('upd-status').textContent = text;
}

function updShow({ open = false, install = false, apply = false, check = true } = {}) {
  $('upd-open').classList.toggle('hidden', !open);
  $('upd-install-btn').classList.toggle('hidden', !install);
  $('upd-apply').classList.toggle('hidden', !apply);
  $('upd-check').classList.toggle('hidden', !check);
}

function updProgress(on, percent, received, total) {
  $('upd-progress').classList.toggle('hidden', !on);
  if (on) {
    $('upd-bar').style.width = `${Math.max(3, percent || 0)}%`;
    $('upd-pct').textContent = `${percent || 0}%`;
    updSetStatus(`Скачиваем обновление… ${fmtSize(received)} из ${fmtSize(total)}`);
  }
}

function openUpdateModal() {
  $('upd-current').textContent = $('app-version').textContent || '';
  if (updBusy) {
    updSetStatus('Скачивание идёт в фоне — прогресс появится, как только придёт следующий пакет данных.');
    updShow({});
  } else if (!updFile) {
    updSetStatus('Проверим наличие новой версии на GitHub. Если она есть — скачаем и установим тихо.');
    updShow({});
  } else if (updFile.done) {
    updSetStatus('Установщик уже скачан и готов. Тихая установка закроет плеер и откроет его обновлённым.');
    updShow({ apply: true });
  } else if (updFile.error) {
    updSetStatus('Предыдущая попытка не удалась: ' + updFile.error);
    updShow({ install: updApply ? true : false, open: !!updApply });
  }
  $('update-backdrop').classList.remove('hidden');
}

function closeUpdateModal() {
  $('update-backdrop').classList.add('hidden');
}

// Проверка релиза (кнопка «Проверить»)
async function updCheckFlow() {
  const btn = $('upd-check');
  btn.disabled = true;
  btn.textContent = 'Проверяем…';
  updSetStatus('Смотрим последний релиз на GitHub…');
  try {
    const res = await ipcRenderer.invoke('update:check', { force: true });
    const info = res && res.success ? res.data : null;
    if (!info) throw new Error((res && res.error) || 'Нет ответа');
    if (info.error) {
      updSetStatus('Ошибка проверки: ' + info.error);
      updShow({});
    } else if (info.updateAvailable && info.asset && info.asset.url) {
      updApply = { asset: info.asset, latest: info.latest, current: info.current, pageUrl: info.url };
      updFile = null;
      const notes = info.notes ? ' ' + String(info.notes).split('\n')[0].slice(0, 120) : '';
      updSetStatus(`Доступна версия ${versionLabel(info.latest)} · ${fmtSize(info.asset.size)}.${notes}`);
      updShow({ install: true, open: true });
      showUpdateBanner(info);
    } else if (info.updateAvailable) {
      updSetStatus(`Доступна версия ${versionLabel(info.latest)}, но у релиза нет exe-файла — откройте страницу и скачайте вручную.`);
      updShow({ open: true });
    } else {
      updSetStatus(`У вас самая свежая версия (v${info.current}).`);
      updShow({});
    }
  } catch (err) {
    updSetStatus('Не удалось проверить: ' + (err.message || 'нет связи'));
    updShow({});
  }
  btn.disabled = false;
  btn.textContent = 'Проверить';
}

// Скачивание установщика с прогрессом; закрытие окна загрузку не прерывает
async function updInstallFlow() {
  const info = updApply;
  if (!info || !info.asset || !info.asset.url) return;
  const btn = $('upd-install-btn');
  btn.disabled = true;
  updBusy = true;
  updProgress(true, 0, 0, info.asset.size);
  try {
    const res = await ipcRenderer.invoke('update:download', {
      url: info.asset.url,
      size: info.asset.size,
      version: info.latest
    });
    if (!res || !res.success) throw new Error((res && res.error) || 'Скачивание не удалось');
    updFile = { done: true, path: res.data.filePath };
    updSetStatus('Готово. Запуск тихой установки закроет плеер и обновит его до ' + versionLabel(info.latest) + '.');
    updShow({ apply: true, open: true });
    toast('Обновление скачано — можно устанавливать');
  } catch (err) {
    updFile = { done: false, error: err.message || 'нет связи' };
    updSetStatus('Не получилось скачать: ' + updFile.error);
    updShow({ install: true, open: true });
  }
  updProgress(false);
  updBusy = false;
  btn.disabled = false;
}

$('btn-update').addEventListener('click', openUpdateModal);
$('upd-close').addEventListener('click', closeUpdateModal);
$('update-backdrop').addEventListener('mousedown', (e) => {
  if (e.target === $('update-backdrop')) closeUpdateModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('update-backdrop').classList.contains('hidden')) closeUpdateModal();
});

$('upd-check').addEventListener('click', updCheckFlow);
$('upd-install-btn').addEventListener('click', updInstallFlow);

$('upd-apply').addEventListener('click', async () => {
  if (!updFile || !updFile.done) return;
  updSetStatus('Запускаю тихую установку — плеер сейчас закроется…');
  $('upd-apply').disabled = true;
  const res = await ipcRenderer.invoke('update:install');
  if (!res || !res.success) {
    $('upd-apply').disabled = false;
    updSetStatus('Не удалось запустить установщик: ' + ((res && res.error) || 'неизвестная ошибка'));
  }
  // Прогресс-бар больше не нужен, но окно оставляем: пока приложение живёт, видно статус
});

$('upd-open').addEventListener('click', () => {
  if (updApply && updApply.pageUrl) ipcRenderer.invoke('app:openExternal', updApply.pageUrl);
});

// Прогресс скачивания шлёт main-процесс
ipcRenderer.on('update:download-progress', (e, p) => {
  if (!updBusy || !p) return;
  updProgress(true, p.percent, p.received, p.total);
});

function buildEqUI() {
  const bands = $('eq-bands');
  bands.textContent = '';
  EQ_FREQS.forEach((freq, i) => {
    const band = document.createElement('div');
    band.className = 'eq-band';
    const slot = document.createElement('div');
    slot.className = 'eq-slot';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '-12';
    input.max = '12';
    input.step = '1';
    input.value = String(eq.gains[i]);
    input.dataset.index = String(i);
    input.setAttribute('aria-label', `${freq >= 1000 ? freq / 1000 + ' кГц' : freq + ' Гц'}`);
    const val = document.createElement('div');
    val.className = 'eq-val';
    val.textContent = fmtDb(eq.gains[i]);
    const name = document.createElement('div');
    name.className = 'eq-freq';
    name.textContent = freq >= 1000 ? (freq / 1000) + 'k' : String(freq);

    input.addEventListener('input', () => {
      eq.gains[i] = Number(input.value);
      val.textContent = fmtDb(eq.gains[i]);
      eq.preset = '';
      applyEq();
      syncPresetChips();
      saveEq();
    });

    slot.appendChild(input);
    band.append(slot, val, name);
    bands.appendChild(band);
  });

  const presets = $('eq-presets');
  presets.textContent = '';
  for (const name of Object.keys(EQ_PRESETS)) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.dataset.preset = name;
    chip.textContent = name;
    chip.addEventListener('click', () => applyPreset(name));
    presets.appendChild(chip);
  }
  syncPresetChips();
}

function fmtDb(v) {
  return (v > 0 ? '+' : '') + v;
}

function syncPresetChips() {
  document.querySelectorAll('#eq-presets .chip').forEach((chip) => {
    chip.classList.toggle('on', chip.dataset.preset === eq.preset);
  });
}

function syncEqInputs() {
  document.querySelectorAll('#eq-bands input').forEach((input) => {
    const i = Number(input.dataset.index);
    input.value = String(eq.gains[i]);
    const val = input.parentElement.parentElement.querySelector('.eq-val');
    if (val) val.textContent = fmtDb(eq.gains[i]);
  });
  syncPresetChips();
}

function applyPreset(name) {
  const values = EQ_PRESETS[name];
  if (!values) return;
  eq.gains = values.slice();
  eq.preset = name;
  applyEq();
  syncEqInputs();
  saveEq();
}

function setEqEnabled(on) {
  eq.enabled = on;
  const sw = $('eq-power');
  sw.classList.toggle('on', on);
  sw.setAttribute('aria-pressed', String(on));
  applyEq();
  saveEq();
}

$('eq-power').addEventListener('click', () => setEqEnabled(!eq.enabled));
$('eq-reset').addEventListener('click', () => applyPreset('Плоско'));
$('eq-close').addEventListener('click', () => toggleEqPanel(false));

btnEq.addEventListener('click', () => toggleEqPanel(eqPanel.classList.contains('hidden')));

function toggleEqPanel(open) {
  eqPanel.classList.toggle('hidden', !open);
  btnEq.classList.toggle('on', open);
  btnEq.setAttribute('aria-expanded', String(open));
  if (open) ensureEqGraph();
}

// Объём — общий для всех ползунков эквалайзера (предусиление, дБ)
const eqPreamp = $('eq-preamp');
if (eqPreamp) {
  eqPreamp.addEventListener('input', () => {
    eq.preamp = Number(eqPreamp.value);
    setPreampLabel();
    applyEq();
    saveEq();
  });
}

function setPreampLabel() {
  const el = $('eq-preamp-val');
  if (el) el.textContent = fmtDb(eq.preamp) + ' дБ';
}

function saveEq() {
  localStorage.setItem('eq', JSON.stringify({
    enabled: eq.enabled,
    gains: eq.gains,
    preset: eq.preset,
    preamp: eq.preamp
  }));
}

function restoreEq() {
  try {
    const saved = JSON.parse(localStorage.getItem('eq') || 'null');
    if (saved) {
      if (Array.isArray(saved.gains) && saved.gains.length === EQ_FREQS.length) {
        eq.gains = saved.gains.map((v) => Math.max(-12, Math.min(12, Number(v) || 0)));
      }
      if (typeof saved.enabled === 'boolean') eq.enabled = saved.enabled;
      if (typeof saved.preset === 'string') eq.preset = saved.preset;
      if (typeof saved.preamp === 'number') eq.preamp = Math.max(-12, Math.min(6, saved.preamp));
    }
  } catch (e) {}
  buildEqUI();
  const sw = $('eq-power');
  sw.classList.toggle('on', eq.enabled);
  sw.setAttribute('aria-pressed', String(eq.enabled));
  if (eqPreamp) eqPreamp.value = String(eq.preamp);
  setPreampLabel();
}

// ---------------------------------------------------------------- Панель «Сейчас играет»

function updateNowPlaying() {
  const t = state.current;
  $('current-title').textContent = t ? t.title : 'Ничего не играет';
  $('current-artist').textContent = t ? t.artist : 'Выберите трек';
  setCover($('current-cover'), t ? t.cover : '', '♫');
  document.title = t ? `${t.artist} — ${t.title}` : 'NK Player';
  seekBar.value = 0;
  $('time-current').textContent = '0:00';
  $('time-total').textContent = t ? formatTime(t.duration) : '0:00';

  if ('mediaSession' in navigator) {
    // MediaImage принимает только http/https/data/blob — локальные обложки пропускаем
    const art = t && t.cover && /^(https?:|data:|blob:)/.test(t.cover)
      ? [{ src: t.cover, sizes: '300x300' }]
      : [];
    navigator.mediaSession.metadata = t
      ? new MediaMetadata({ title: t.title, artist: t.artist, artwork: art })
      : null;
  }

  pushDiscordPresence();
}

// ---------------------------------------------------------------- Discord RPC

// Статус в Discord живёт в главном процессе (там named pipe), сюда только
// отправляем, что играет. Троттлинг и проверка лимитов — на той стороне.
function pushDiscordPresence() {
  const t = state.current;
  if (!t) {
    ipcRenderer.invoke('discord:update', null);
    return;
  }
  ipcRenderer.invoke('discord:update', {
    artist: t.artist,
    title: t.title,
    cover: /^https:\/\//.test(t.cover || '') ? t.cover : '',
    paused: audio.paused,
    position: audio.currentTime || 0,
    duration: t.duration || 0
  });
}

// ---------------------------------------------------------------- Кнопка Discord

const btnDiscord = $('btn-discord');
const DISCORD_KEY = 'nk.discordEnabled';

function applyDiscordEnabled(on) {
  btnDiscord.classList.toggle('on', on);
  btnDiscord.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem(DISCORD_KEY, on ? '1' : '0'); } catch (e) {}
}

btnDiscord.addEventListener('click', async () => {
  const on = !btnDiscord.classList.contains('on');
  applyDiscordEnabled(on);
  const res = await ipcRenderer.invoke('discord:set-enabled', on);
  if (!on) {
    toast('Статус в Discord отключён');
    return;
  }
  const connected = res && res.data && res.data.connected;
  toast(connected ? 'Статус в Discord включён' : 'Discord не запущен — включится автоматически');
  if (state.current) pushDiscordPresence();
});

// Настройка переживает перезапуск: главный процесс стартует с включённым
// статусом, поэтому при выключенном флаге гасим его сразу после загрузки.
(() => {
  let on = true;
  try { on = localStorage.getItem(DISCORD_KEY) !== '0'; } catch (e) {}
  applyDiscordEnabled(on);
  if (!on) ipcRenderer.invoke('discord:set-enabled', false);
})();

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => audio.play().catch(() => {}));
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('nexttrack', playNext);
  navigator.mediaSession.setActionHandler('previoustrack', playPrev);
}

// ---------------------------------------------------------------- Прогресс и громкость

seekBar.addEventListener('mousedown', () => (isSeeking = true));
seekBar.addEventListener('touchstart', () => (isSeeking = true), { passive: true });
seekBar.addEventListener('input', () => {
  if (audio.duration) {
    $('time-current').textContent = formatTime(Math.floor((seekBar.value / 1000) * audio.duration));
  }
});
seekBar.addEventListener('change', () => {
  if (audio.duration) audio.currentTime = (seekBar.value / 1000) * audio.duration;
  isSeeking = false;
});

audio.addEventListener('timeupdate', () => {
  if (!audio.duration || isSeeking) return;
  seekBar.value = (audio.currentTime / audio.duration) * 1000;
  $('time-current').textContent = formatTime(Math.floor(audio.currentTime));
  $('time-total').textContent = formatTime(Math.floor(audio.duration));
  // Кроссфейд-переход по времени: незадолго до конца трека
  crossfadeTick();
});

function applyVolume() {
  audio.volume = Number(volumeBar.value);
  // Теневой хвост кроссфейда слышен вне графа EQ — держим его на той же громкости
  if (cf.audio2) {
    cf.audio2.volume = audio.volume;
    cf.audio2.muted = audio.muted;
  }
  const muted = audio.muted || audio.volume === 0;
  btnMute.textContent = muted ? '🔇' : audio.volume < 0.5 ? '🔉' : '🔊';
  btnMute.setAttribute('aria-label', audio.muted ? 'Включить звук' : 'Выключить звук');
}

volumeBar.addEventListener('input', () => {
  audio.muted = false;
  applyVolume();
  localStorage.setItem('volume', volumeBar.value);
});

btnMute.addEventListener('click', () => {
  audio.muted = !audio.muted;
  applyVolume();
});

function restoreSettings() {
  const vol = localStorage.getItem('volume');
  if (vol !== null) volumeBar.value = vol;
  applyVolume();
  setShuffle(localStorage.getItem('shuffle') === '1');
  setRepeat(localStorage.getItem('repeat') || 'off');
  restoreEq();
}

// ---------------------------------------------------------------- Горячие клавиши

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (appView.classList.contains('hidden')) return;

  if (e.key === 'Escape' && !eqPanel.classList.contains('hidden')) {
    toggleEqPanel(false);
  } else if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.ctrlKey && e.key === 'ArrowRight') {
    playNext();
  } else if (e.ctrlKey && e.key === 'ArrowLeft') {
    playPrev();
  } else if (e.key === 'ArrowRight' && audio.duration) {
    audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
  } else if (e.key === 'ArrowLeft' && audio.duration) {
    audio.currentTime = Math.max(0, audio.currentTime - 5);
  } else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    searchInput.focus();
  } else if (e.ctrlKey && e.key.toLowerCase() === 'e') {
    e.preventDefault();
    toggleEqPanel(eqPanel.classList.contains('hidden'));
  }
});

// ---------------------------------------------------------------- Тост

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// ---------------------------------------------------------------- Утилиты

// Обложка может не загрузиться (504 у ВК, картинки для трека просто нет).
// Под <img> остаётся заглушка, поэтому сломанного значка в списке не видно.
// Один повтор — ВК иногда отвечает 504 на первую попытку.
function setCover(el, url, placeholder, lazy) {
  el.textContent = placeholder || '';
  el.classList.remove('has-cover');
  const old = el.querySelector('img');
  if (old) old.remove();
  if (!url) return;

  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  if (lazy) img.loading = 'lazy';
  img.addEventListener('load', () => el.classList.add('has-cover'));
  img.addEventListener('error', () => {
    if (!img.dataset.retried) {
      img.dataset.retried = '1';
      setTimeout(() => { img.src = url; }, 1200);
      return;
    }
    img.remove();
  });
  img.src = url;
  el.appendChild(img);
}

function coverLetter(text) {
  return String(text || '').trim().charAt(0).toUpperCase();
}

function initial(name) {
  return String(name || '').trim().charAt(0).toUpperCase() || '?';
}

function formatTime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function formatTotal(tracks) {
  const total = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  if (total < 60) return 'меньше минуты';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h ? `${h} ч ${m} мин` : `${m} мин`;
}

function pluralTracks(n) {
  n = Number(n) || 0;
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11 ? 'трек'
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'трека'
      : 'треков';
  return `${n} ${word}`;
}

// Только для отладки из тестовых скриптов
window.__nk = { state, eq, audio, ensureEqGraph };
