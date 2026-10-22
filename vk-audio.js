// Работа с аудио ВК через внутренний al_audio.php (тот же, что использует сайт).
// Запросы идут через session.fetch, поэтому куки сессии подставляются автоматически.

const VK_BASE = 'https://vk.ru';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0PQRSTUVWXYZO123456789+/=';

// ---------- Расшифровка ссылок audio_api_unavailable.mp3?extra=... ----------

function vkBase64Decode(e) {
  if (!e || e.length % 4 === 1) return false;
  let r = '';
  for (let t = 0, i, o = 0, a = 0; (i = e.charAt(a++));) {
    i = ALPHABET.indexOf(i);
    if (~i && ((t = o % 4 ? 64 * t + i : i), o++ % 4)) {
      r += String.fromCharCode(255 & (t >> ((-2 * o) & 6)));
    }
  }
  return r;
}

function shuffleIndexes(e, t) {
  const n = e.length;
  const res = [];
  if (n) {
    t = Math.abs(t);
    for (let o = n; o--;) {
      t = ((n * (o + 1)) ^ (t + o)) % n;
      res[o] = t;
    }
  }
  return res;
}

function makeOps(userId) {
  const ops = {
    v: (e) => e.split('').reverse().join(''),
    r: (e, t) => {
      const arr = e.split('');
      const o = ALPHABET + ALPHABET;
      for (let r = arr.length; r--;) {
        const i = o.indexOf(arr[r]);
        if (~i) arr[r] = o.substr(i - t, 1);
      }
      return arr.join('');
    },
    s: (e, t) => {
      const n = e.length;
      if (!n) return e;
      const idx = shuffleIndexes(e, t);
      const arr = e.split('');
      for (let o = 1; o < n; o++) {
        arr[o] = arr.splice(idx[n - 1 - o], 1, arr[o])[0];
      }
      return arr.join('');
    },
    i: (e, t) => ops.s(e, t ^ userId),
    x: (e, t) => {
      const code = t.charCodeAt(0);
      return e.split('').map((ch) => String.fromCharCode(ch.charCodeAt(0) ^ code)).join('');
    }
  };
  return ops;
}

function decodeVkAudioUrl(url, userId) {
  if (!url) return '';
  if (!url.includes('audio_api_unavailable')) return url;
  const extra = url.split('?extra=')[1];
  if (!extra) return '';
  const parts = extra.split('#');
  const ops = parts[1] ? vkBase64Decode(parts[1]) : '';
  let t = vkBase64Decode(parts[0]);
  if (typeof ops !== 'string' || !t) return '';

  const opList = ops ? ops.split(String.fromCharCode(9)) : [];
  const fns = makeOps(userId);
  for (let s = opList.length; s--;) {
    const args = opList[s].split(String.fromCharCode(11));
    const name = args.splice(0, 1, t)[0];
    if (!fns[name]) return '';
    t = fns[name](...args);
  }
  return t && t.startsWith('http') ? t : '';
}

// ---------- HTTP ----------

function unescapeHtml(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  return unescapeHtml(String(s || '').replace(/<[^>]*>/g, '')).trim();
}

async function readText(res) {
  const ct = res.headers.get('content-type') || '';
  const charset = (ct.match(/charset=([\w-]+)/i) || [])[1] || 'utf-8';
  const buf = await res.arrayBuffer();
  try {
    return new TextDecoder(charset).decode(buf);
  } catch (e) {
    return new TextDecoder('utf-8').decode(buf);
  }
}

// ВК иногда отдаёт не JSON, а HTML-страницу — это признак внутреннего лимита,
// а не истёкшей сессии. Повторяем запрос с паузой, прежде чем ругаться.
async function alAudio(ses, form) {
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
    const res = await ses.fetch(`${VK_BASE}/al_audio.php?act=${encodeURIComponent(form.act)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${VK_BASE}/audio`
      },
      body: new URLSearchParams(form).toString()
    });
    if (res.status !== 200) {
      lastError = `ВК ответил HTTP ${res.status}`;
      continue;
    }
    const text = (await readText(res)).replace(/^<!--/, '');
    try {
      return JSON.parse(text);
    } catch (e) {
      lastError = 'ВК ответил HTML вместо данных (временное ограничение ВК)';
    }
  }
  throw new Error(lastError || 'Не удалось получить ответ от ВК');
}

// ---------- Пользователь ----------

let cachedUserId = 0;

function resetSession() {
  cachedUserId = 0;
  cachedProfile = null;
}

// Страница /audio содержит и id, и профиль (имя + аватар) в windows-1251 —
// это тот же запрос, который всё равно нужен для getUserId.
let cachedProfile = null;

async function getProfile(ses) {
  if (cachedProfile) return cachedProfile;
  const res = await ses.fetch(`${VK_BASE}/audio`);
  const html = await readText(res);

  const uid = (html.match(/"uid":(\d+)/) || html.match(/window\.vk\s*=\s*\{"id":(\d+)/) || [])[1];
  if (!uid) throw new Error('Сессия не распознана. Выйдите и войдите снова.');

  const first = unescapeJson((html.match(/"first_name":"((?:[^"\\]|\\.)*)"/) || [])[1] || '');
  const last = unescapeJson((html.match(/"last_name":"((?:[^"\\]|\\.)*)"/) || [])[1] || '');
  const avatar = unescapeJson((html.match(/"photo_base":"((?:[^"\\]|\\.)*)"/) || [])[1] || '')
    || unescapeJson((html.match(/"photo_200":"((?:[^"\\]|\\.)*)"/) || [])[1] || '')
    || unescapeJson((html.match(/"photo_100":"((?:[^"\\]|\\.)*)"/) || [])[1] || '');
  const screen = unescapeJson((html.match(/"screen_name":"((?:[^"\\]|\\.)*)"/) || [])[1] || '');

  cachedUserId = Number(uid);
  cachedProfile = {
    id: Number(uid),
    name: [first, last].filter(Boolean).join(' ') || screen || 'ВКонтакте',
    screenName: screen,
    avatar
  };
  return cachedProfile;
}

// В JSON ВК слеши экранированы: "https:\/\/sun9-1.vkuserphoto.ru\/..."
function unescapeJson(s) {
  return String(s || '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"');
}

async function getUserId(ses) {
  if (cachedUserId) return cachedUserId;
  return (await getProfile(ses)).id;
}

// ---------- Разбор ответов ----------

// Часть треков ВК отдаёт не через reload_audio, а прямыми ссылками okcdn
// в поле audio_streams объекта флагов [12] — именно их играет веб-плеер vk.ru.
// Для самозалитов это часто единственный быстрый источник: расшифрованные
// ссылки ведут на старые медленные cs*-хосты. Приоритет: mp3 (играет напрямую
// через <audio>), затем aac, затем HLS-варианты (заголовки и CORS для CDN
// поправлены в main.js, поэтому hls.js теперь тоже достаёт сегменты).
// Ссылки живут до expires — протухшую отдавать бессмысленно.
function pickStream(a) {
  let flags = {};
  try {
    flags = typeof a[12] === 'string' ? JSON.parse(a[12]) : (a[12] || {});
  } catch (e) {
    return { url: '', expires: 0 };
  }
  const streams = Array.isArray(flags.audio_streams) ? flags.audio_streams : [];
  for (const type of ['mp3', 'aac', 'hls_ts', 'hls']) {
    const stream = streams.find((s) => s.type === type);
    if (!stream || typeof stream.url !== 'string' || !stream.url.startsWith('https://')) continue;
    const m = stream.url.match(/[?&]expires=(\d+)/) || stream.url.match(/\/expires\/(\d+)/);
    const expires = m ? Number(m[1]) : 0;
    if (expires && expires < Date.now() + 60 * 1000) continue;
    return { url: stream.url, expires };
  }
  return { url: '', expires: 0 };
}

// Трек в ответах ВК — массив: [id, owner_id, url, title, artist, duration, ..., hashes(13), covers(14), ...]
function parseTrack(a, userId) {
  const h = String(a[13] || '').split('/');
  const cover = unescapeHtml(String(a[14] || '').split(',')[0] || '');
  const stream = pickStream(a);
  return {
    id: `${a[1]}_${a[0]}`,
    reloadId: h[2] && h[5] ? `${a[1]}_${a[0]}_${h[2]}_${h[5]}` : null,
    title: unescapeHtml(a[3]),
    artist: unescapeHtml(a[4]),
    duration: Number(a[5]) || 0,
    cover: cover.startsWith('https://') ? cover : '',
    url: decodeVkAudioUrl(a[2], userId),
    stream: stream.url,
    streamExpires: stream.expires
  };
}

function parseTrackList(list, userId) {
  const seen = new Set();
  const out = [];
  for (const a of list || []) {
    if (!Array.isArray(a)) continue;
    const t = parseTrack(a, userId);
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

function parsePlaylist(p) {
  const gridCover = (String(p.grid_covers || '').match(/url\('?([^')]+)'?\)/) || [])[1] || '';
  const cover = unescapeHtml(p.thumb || gridCover);
  const orig = p.original_identity || {};
  // У подписанных альбомов сообществ access_hash пустой, но он есть в href.
  const hrefHash = (String(p.href || '').match(/\/(?:album|playlist)\/-?\d+_\d+_([0-9a-f]+)/) || [])[1] || '';
  return {
    ownerId: Number(p.owner_id),
    id: Number(p.id),
    accessHash: p.access_hash || hrefHash,
    // Для подписанных плейлистов копия может не отдавать треки — тогда идём к оригиналу
    originalOwnerId: orig.owner_id ? Number(orig.owner_id) : null,
    originalId: orig.playlist_id ? Number(orig.playlist_id) : null,
    title: stripTags(p.title),
    author: stripTags(p.author_name),
    size: Number(p.size) || 0,
    cover: cover.startsWith('https://') ? cover : ''
  };
}

// ---------- Загрузка списков ----------

// Загружает плейлист целиком (ВК отдаёт до 2000 треков за запрос, дальше — по nextOffset)
async function loadPlaylistSection(ses, userId, ownerId, playlistId, accessHash) {
  const context = ownerId === userId ? 'my' : (ownerId < 0 ? 'group_list' : 'user_playlists');
  let offset = 0;
  let list = [];

  for (let guard = 0; guard < 100; guard++) {
    const res = await alAudio(ses, {
      act: 'load_section', al: 1, claim: 0, context, from_id: userId,
      is_loading_all: 1, is_preload: 0, offset, owner_id: ownerId,
      playlist_id: playlistId, type: 'playlist', access_hash: accessHash || ''
    });
    const pl = res?.payload?.[1]?.[0];
    if (!pl || !Array.isArray(pl.list)) {
      if (guard === 0) throw new Error('Не удалось загрузить список треков. Возможно, доступ к нему ограничен.');
      break;
    }
    list = list.concat(pl.list);
    const next = Number(pl.nextOffset);
    if (!pl.hasMore || !next || next <= offset) break;
    offset = next;
  }

  return parseTrackList(list, userId);
}

async function getMyAudios(ses) {
  const userId = await getUserId(ses);
  return loadPlaylistSection(ses, userId, userId, -1, '');
}

async function getPlaylists(ses) {
  const userId = await getUserId(ses);
  const out = [];
  let offset = 0;

  for (let guard = 0; guard < 100; guard++) {
    const res = await alAudio(ses, {
      act: 'owner_playlists', al: 1, is_attach: 0, offset, owner_id: userId, access_hash: ''
    });
    const [items, count] = res?.payload?.[1] || [];
    if (!Array.isArray(items)) {
      if (guard === 0) throw new Error('Не удалось загрузить плейлисты.');
      break;
    }
    out.push(...items.map(parsePlaylist));
    offset += items.length;
    if (!items.length || offset >= Number(count)) break;
  }

  return out;
}

async function getPlaylistTracks(ses, { ownerId, id, accessHash, originalOwnerId, originalId }) {
  const userId = await getUserId(ses);
  const hash = String(accessHash || '');
  const targets = [{ ownerId: Number(ownerId), id: Number(id), accessHash: '' }];
  if (hash) targets.push({ ownerId: Number(ownerId), id: Number(id), accessHash: hash });
  if (originalOwnerId && originalId && (Number(originalOwnerId) !== Number(ownerId) || Number(originalId) !== Number(id))) {
    targets.push({ ownerId: Number(originalOwnerId), id: Number(originalId), accessHash: hash });
  }

  let lastError;
  for (const t of targets) {
    try {
      const tracks = await loadPlaylistSection(ses, userId, t.ownerId, t.id, t.accessHash);
      if (tracks.length) return tracks;
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError) throw lastError;
  return [];
}

// ---------- Поиск ----------

function pickSearchBlock(data) {
  const blocks = (data?.playlists || []).filter((p) => Array.isArray(p.list) && p.list.length);
  return blocks.find((p) => p.title === 'Все треки')
    || blocks.filter((p) => p.title !== 'Мои треки').sort((a, b) => b.list.length - a.list.length)[0]
    || data?.playlist
    || null;
}

function searchResult(block, userId) {
  if (!block) return { tracks: [], more: null };
  return {
    tracks: parseTrackList(block.list, userId),
    more: block.hasMore && block.nextOffset
      ? { sectionId: block.blockId || block.id, nextFrom: block.nextOffset }
      : null
  };
}

async function search(ses, query) {
  const userId = await getUserId(ses);
  const res = await alAudio(ses, {
    act: 'section', al: 1, claim: 0, is_layer: 0, owner_id: userId, section: 'search', q: query
  });
  return searchResult(pickSearchBlock(res?.payload?.[1]?.[1]), userId);
}

async function searchMore(ses, { sectionId, nextFrom }) {
  const userId = await getUserId(ses);
  const res = await alAudio(ses, {
    act: 'load_catalog_section', al: 1, section_id: sectionId, start_from: nextFrom
  });
  const data = res?.payload?.[1]?.[1];
  const block = data?.playlists?.[0] || data?.playlist || null;
  return searchResult(block, userId);
}

// ---------- Ссылки на воспроизведение ----------

// ВК отдаёт не больше ~400 ссылок за короткое окно, после чего reload_audio
// начинает отвечать "no_audios" на любые запросы. Держим кэш и умеем ждать.
const urlCache = new Map(); // reloadId -> { url, time }
const URL_CACHE_TTL = 50 * 60 * 1000;

let resolveChain = Promise.resolve();
function enqueue(task) {
  const run = resolveChain.then(task, task);
  resolveChain = run.then(() => {}, () => {});
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trackIdOf = (reloadId) => String(reloadId).split('_').slice(0, 2).join('_');

// Фоновая предзагрузка не должна отнимать ссылки у воспроизведения.
let playRequests = 0;
async function waitForPlayRequests() {
  while (playRequests > 0) await sleep(150);
}

function cacheGet(id) {
  const hit = urlCache.get(id);
  if (!hit) return '';
  if (Date.now() - hit.time > URL_CACHE_TTL) {
    urlCache.delete(id);
    return '';
  }
  return hit.url;
}

// Возвращает { urls, streams, rateLimited }. rateLimited — ВК отказал целиком, стоит повторить.
async function reloadBatch(ses, userId, ids) {
  const res = await alAudio(ses, { act: 'reload_audio', al: 1, ids: ids.join(',') });
  const tracks = res?.payload?.[1]?.[0];
  const urls = {};
  const streams = {};
  if (!Array.isArray(tracks)) return { urls, streams, rateLimited: true };
  for (const t of tracks) {
    const id = `${t[1]}_${t[0]}`;
    const url = decodeVkAudioUrl(t[2], userId);
    if (url) {
      urls[id] = url;
      const h = String(t[13] || '').split('/');
      if (h[2] && h[5]) urlCache.set(`${id}_${h[2]}_${h[5]}`, { url, time: Date.now() });
    }
    // reload_audio заодно выдаёт свежие ссылки okcdn — обновляем их тоже
    const stream = pickStream(t);
    if (stream.url) streams[id] = stream;
  }
  return { urls, streams, rateLimited: false };
}

// reload_audio отдаёт ссылки пачками до 10 треков.
// background — предзагрузка: она уступает воспроизведению и идёт размеренно.
// Возвращает { urls: { "owner_id": url }, rateLimited }
async function resolveUrls(ses, reloadIds, { background = false } = {}) {
  const userId = await getUserId(ses);
  const urls = {};
  const streams = {};
  const missing = [];

  for (const id of new Set((reloadIds || []).filter(Boolean))) {
    const cached = cacheGet(id);
    if (cached) urls[trackIdOf(id)] = cached;
    else missing.push(id);
  }

  let rateLimited = false;
  for (let i = 0; i < missing.length; i += 10) {
    const chunk = missing.slice(i, i + 10);

    // Пользователь нажал трек — сначала обслуживаем его, предзагрузка ждёт
    if (background) {
      await waitForPlayRequests();
      await sleep(120);
    }

    if (!background) playRequests++;
    let got;
    try {
      got = await enqueue(async () => {
        const first = await reloadBatch(ses, userId, chunk);
        if (!first.rateLimited) return { urls: first.urls, streams: first.streams, limited: false };
        // ВК ограничивает выдачу ссылок — одна короткая пауза, чтобы не тормозить плеер
        await sleep(3000);
        const second = await reloadBatch(ses, userId, chunk);
        return { urls: second.urls, streams: second.streams, limited: second.rateLimited };
      });
    } finally {
      if (!background) playRequests--;
    }

    Object.assign(urls, got.urls);
    if (got.streams) Object.assign(streams, got.streams);
    if (got.limited) {
      rateLimited = true;
      if (background) break;
    }
  }

  // Не даём кэшу расти бесконечно
  if (urlCache.size > 4000) {
    const now = Date.now();
    for (const [k, v] of urlCache) if (now - v.time > URL_CACHE_TTL) urlCache.delete(k);
  }
  return { urls, streams, rateLimited };
}

// ---------- Прогрев самозалитов ----------

// Самозалитые треки ВК конвертирует в HLS по первому запросу: первый холодный
// сегмент занимает 15-40 секунд (очередь транскода), повторный — миллисекунды.
// Фоновая загрузка начала трека заставляет ВК подготовить сегменты заранее.
async function warmSegments(ses, urls, { timeout = 45000 } = {}) {
  let warmed = 0;
  const details = [];
  for (const url of urls) {
    if (typeof url !== 'string' || !url.startsWith('https://')) continue;
    try {
      const res = await ses.fetch(url, { signal: AbortSignal.timeout(timeout) });
      if (!res.ok) { details.push({ status: res.status }); continue; }
      const text = await res.text();
      if (!text.includes('#EXTM3U')) { details.push({ status: 'not-m3u8' }); continue; }
      const base = url.split('/').slice(0, -1).join('/');
      const segs = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).slice(0, 2);
      // Сегменты ждём до готовности, стартовые байты — дёшево (<64 КБ),
      // зато после этого ВК отдаёт их мгновенно в плеере
      let segsOk = 0;
      for (const s of segs) {
        const segUrl = /^https?:/.test(s) ? s : `${base}/${s}`;
        try {
          const sr = await ses.fetch(segUrl, { headers: { Range: 'bytes=0-65535' }, signal: AbortSignal.timeout(timeout) });
          if (sr.ok) segsOk++;
          if (sr.body && sr.body.cancel) sr.body.cancel().catch(() => {});
        } catch (e) { /* холодный сегмент не успел — прогреется в фоне или при нажатии */ }
      }
      warmed++;
      details.push({ segsOk });
    } catch (e) {
      details.push({ err: String((e && e.message) || e).slice(0, 60) });
    }
  }
  return { warmed, details };
}

module.exports = {
  getMyAudios,
  getPlaylists,
  getPlaylistTracks,
  search,
  searchMore,
  resolveUrls,
  warmSegments,
  resetSession,
  getProfile,
  decodeVkAudioUrl
};
