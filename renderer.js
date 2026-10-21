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

const state = {
  profile: null,
  myTracks: null,
  localTracks: null,
  playlists: [],
  playlistTracks: new Map(),  // "owner_id" -> tracks
  search: null,               // { query, tracks, more }
  view: { type: 'my' },
  displayed: [],              // треки текущего экрана после фильтра
  prefetchActive: false,

  queue: [],
  order: [],                  // порядок воспроизведения (индексы queue)
  pos: -1,                    // позиция в order
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

async function vkCall(channel, arg) {
  const res = await ipcRenderer.invoke(channel, arg);
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

function schedulePrefetch(list) {
  if (prefetchTimer) clearTimeout(prefetchTimer);
  prefetchGen++;
  const gen = prefetchGen;
  const pending = (list || [])
    .filter((t) => !t.local && t.reloadId && !t.url && !hasLiveStream(t))
    .map((t) => t.reloadId);
  if (!pending.length) return;

  prefetchTimer = setTimeout(async () => {
    prefetchTimer = null;
    if (prefetchRunning) return;
    prefetchRunning = true;
    try {
      const queue = pending.slice();
      while (queue.length && gen === prefetchGen) {
        const chunk = queue.splice(0, 30);
        const res = await vkCall('audio:resolve', { ids: chunk, background: true });
        // Упёрлись в лимит ВК — прекращаем греть кэш, чтобы не отнимать
        // квоту у воспроизведения. Ссылки всё равно запросятся при нажатии.
        if (res && res.rateLimited) break;
        await sleep(250);
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

window.addEventListener('DOMContentLoaded', async () => {
  restoreSettings();
  const session = await ipcRenderer.invoke('auth:check');
  if (session.loggedIn) showApp();
  else loginView.classList.remove('hidden');
});

function stopAuthPoll() {
  if (authPollInterval) {
    clearInterval(authPollInterval);
    authPollInterval = null;
  }
}

$('btn-oauth').addEventListener('click', async () => {
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
    view: { type: 'my' }, displayed: [], queue: [], order: [], pos: -1, current: null
  });
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
  openView({ type: 'my' });
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
  const ph = document.createElement('div');
  ph.className = 'nav-sub';
  ph.style.padding = '8px 12px';
  ph.textContent = 'Загрузка…';
  playlistNav.appendChild(ph);

  try {
    state.playlists = await vkCall('playlists:get');
  } catch (e) {
    ph.textContent = e.message;
    return;
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

// ---------------------------------------------------------------- Навигация

function setActiveNav() {
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.remove('active'));
  const v = state.view;
  let el = null;
  if (v.type === 'my') el = $('nav-my');
  else if (v.type === 'local') el = $('nav-local');
  else if (v.type === 'search') el = $('nav-search');
  else if (v.type === 'playlist') el = playlistNav.querySelector(`[data-key="${v.key}"]`);
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
  $('btn-import').classList.toggle('hidden', view.type !== 'local');
  const token = Symbol('view');
  state.viewToken = token;
  state.prefetchActive = false;

  try {
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
  return [];
}

$('nav-my').addEventListener('click', () => openView({ type: 'my' }));
$('nav-local').addEventListener('click', () => openView({ type: 'local' }));
$('nav-search').addEventListener('click', () => { if (state.search) openView({ type: 'search' }); });

function renderPlaylistNav() {
  playlistNav.textContent = '';
  $('playlists-count').textContent = state.playlists.length || '';

  if (!state.playlists.length) {
    const empty = document.createElement('div');
    empty.className = 'nav-sub';
    empty.style.padding = '8px 12px';
    empty.textContent = 'Плейлистов нет';
    playlistNav.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const pl of state.playlists) {
    const key = `${pl.ownerId}_${pl.id}`;
    const btn = document.createElement('button');
    btn.className = 'nav-item';
    btn.dataset.key = key;
    btn.title = pl.title;

    const icon = document.createElement('span');
    icon.className = 'nav-icon';
    icon.setAttribute('aria-hidden', 'true');
    setCover(icon, pl.cover, '☰');

    const text = document.createElement('span');
    text.className = 'nav-text';
    const label = document.createElement('span');
    label.className = 'nav-label';
    label.textContent = pl.title;
    const sub = document.createElement('span');
    sub.className = 'nav-sub';
    sub.textContent = [pl.author, pluralTracks(pl.size)].filter(Boolean).join(' · ');
    text.append(label, sub);

    btn.append(icon, text);
    btn.addEventListener('click', () => openView({ type: 'playlist', key, playlist: pl }));
    frag.appendChild(btn);
  }
  playlistNav.appendChild(frag);
  setActiveNav();
}

// ---------------------------------------------------------------- Список треков

function renderTracks() {
  const q = filterInput.value.trim().toLowerCase();
  const all = currentViewTracks();
  state.displayed = q
    ? all.filter((t) => `${t.artist} ${t.title}`.toLowerCase().includes(q))
    : all.slice();

  tracksContainer.textContent = '';
  if (!state.displayed.length) {
    showPlaceholder(q ? 'Ничего не найдено по фильтру' : 'Здесь пока пусто');
    return;
  }

  const frag = document.createDocumentFragment();
  state.displayed.forEach((track, idx) => frag.appendChild(createTrackRow(track, idx)));

  if (state.view.type === 'search' && state.search.more && !q) {
    const more = document.createElement('button');
    more.className = 'btn-ghost load-more';
    more.textContent = 'Показать ещё';
    more.addEventListener('click', () => loadMoreSearch(more));
    frag.appendChild(more);
  }

  tracksContainer.appendChild(frag);
  highlightCurrent();
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
  main.append(title, artist);

  const dur = document.createElement('div');
  dur.className = 'track-dur';
  dur.textContent = track.duration ? formatTime(track.duration) : '—:—';

  row.append(num, cover, main, dur);

  if (track.local) {
    const del = document.createElement('button');
    del.className = 'track-del';
    del.title = 'Убрать из библиотеки';
    del.setAttribute('aria-label', 'Убрать из библиотеки');
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      removeLocalTrack(track);
    });
    row.appendChild(del);
  }
  return row;
}

// Клик по уже играющему треку ставит его на паузу (или снимает с паузы),
// а не начинает воспроизведение заново.
tracksContainer.addEventListener('click', (e) => {
  if (e.target.closest('.track-del')) return;
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
  startQueue(state.displayed, firstPlayable(state.displayed));
});

$('btn-shuffle-play').addEventListener('click', () => {
  if (!state.displayed.length) return;
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
  playAt(state.pos);
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
// Прямые ссылки okcdn не требуют запроса к ВК — их используем первыми,
// чтобы не тратить лимит reload_audio.
async function ensureUrls(pos, force) {
  const track = state.queue[state.order[pos]];
  if (!track) return '';
  if (track.local) return track.url;
  if (!force && isFresh(track)) return track.url;
  if (hasLiveStream(track)) return track.stream;
  if (!track.reloadId) return track.url || '';

  const batch = [track];
  for (let p = pos + 1; p < state.order.length && batch.length < 10; p++) {
    const t = state.queue[state.order[p]];
    if (t && !t.local && t.reloadId && !isFresh(t) && !hasLiveStream(t)) batch.push(t);
  }

  let urls = {};
  let rateLimited = false;
  try {
    const res = await vkCall('audio:resolve', { ids: batch.map((t) => t.reloadId) });
    urls = res.urls || {};
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
  }
  const own = urls[track.id];
  if (own) return own;

  if (hasLiveStream(track)) return track.stream;
  if (rateLimited) throw new Error('VK_RATE_LIMIT');
  return '';
}

async function playAt(pos, { force = false, skipped = 0, waits = 0 } = {}) {
  const track = state.queue[state.order[pos]];
  if (!track) return;

  const token = ++state.playToken;
  state.pos = pos;
  state.current = track;
  if (!force) state.retried = false;
  updateNowPlaying();
  highlightCurrent();

  let url = '';
  let rateLimited = false;
  try {
    url = await ensureUrls(pos, force);
  } catch (e) {
    url = '';
    rateLimited = e.message === 'VK_RATE_LIMIT';
  }
  if (token !== state.playToken) return;

  if (!url && rateLimited && waits < 2) {
    // ВК отдаёт ссылки порциями — подождём и попробуем ещё раз, а не будем
    // пропускать трек. Так пользователь не теряет песню из-за внутреннего лимита.
    $('current-artist').textContent = 'Получаем ссылку…';
    await sleep(waits === 0 ? 6000 : 15000);
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
}

function loadSource(url) {
  if (hls) { hls.destroy(); hls = null; }

  // Граф эквалайзера собираем до старта: элемент можно подключить к Web Audio
  // только один раз, и лучше сделать это сразу, чем переключать на ходу.
  if (eq.enabled) ensureEqGraph();

  if (url.includes('.m3u8') && Hls.isSupported()) {
    hls = new Hls({ enableWorker: true });
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

// Ссылка могла протухнуть — пробуем перезапросить один раз, иначе следующий трек
function onPlaybackError() {
  if (!state.current) return;
  if (state.current.local) return;
  if (!state.retried) {
    state.retried = true;
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
  audio.paused ? audio.play().catch(() => {}) : audio.pause();
}

btnPlayPause.addEventListener('click', togglePlay);

audio.addEventListener('play', () => {
  btnPlayPause.textContent = '⏸';
  btnPlayPause.setAttribute('aria-label', 'Пауза');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  resumeEq();
});
audio.addEventListener('pause', () => {
  btnPlayPause.textContent = '▶';
  btnPlayPause.setAttribute('aria-label', 'Воспроизведение');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
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
    gain.connect(ctx.destination);

    eq.ctx = ctx;
    eq.nodes = nodes;
    eq.gain = gain;
    applyEq();
    return true;
  } catch (e) {
    // Если элемент уже был подключён к графу, звук продолжает идти через него.
    eq.ctx = null;
    eq.nodes = [];
    eq.gain = null;
    eq.failed = true;
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
}

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
});

function applyVolume() {
  audio.volume = Number(volumeBar.value);
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
