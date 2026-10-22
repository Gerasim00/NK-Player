// Локальные плейлисты NK Player.
// ВК не даёт создавать плейлисты без OAuth-токена: внутренний al_audio.php на
// act=save_playlist отвечает «Ошибка доступа», а api.vk.ru/method требует
// access_token, которого у сессии на куках нет. Поэтому свои плейлисты храним
// в профиле приложения — они не зависят от ссылок ВК и переживают перезапуск.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let filePath = '';

function init(userDataDir) {
  filePath = path.join(userDataDir, 'playlists.json');
}

function read() {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function write(list) {
  fs.writeFileSync(filePath, JSON.stringify(list, null, 2), 'utf8');
}

// В списке нужны только поля для сайдбара — треки отдаём отдельным запросом
function brief(p) {
  return {
    id: p.id,
    title: p.title,
    size: Array.isArray(p.tracks) ? p.tracks.length : 0,
    cover: p.cover || '',
    created: p.created || 0
  };
}

function list() {
  return read().map(brief).sort((a, b) => (a.created || 0) - (b.created || 0));
}

function get(id) {
  const p = read().find((x) => x.id === id);
  return p || null;
}

function create(title) {
  const clean = String(title || '').trim().slice(0, 100);
  if (!clean) throw new Error('Название плейлиста не может быть пустым');

  const all = read();
  const id = 'lpl_' + crypto.randomBytes(6).toString('hex');
  const playlist = { id, title: clean, created: Date.now(), tracks: [] };
  all.push(playlist);
  write(all);
  return brief(playlist);
}

function rename(id, title) {
  const clean = String(title || '').trim().slice(0, 100);
  if (!clean) throw new Error('Название плейлиста не может быть пустым');

  const all = read();
  const p = all.find((x) => x.id === id);
  if (!p) throw new Error('Плейлист не найден');
  p.title = clean;
  write(all);
  return brief(p);
}

function remove(id) {
  write(read().filter((x) => x.id !== id));
  return { id };
}

// Снимок трека: id, ссылка на перезапрос (reloadId), название, исполнитель,
// длительность и обложка. Прямые ссылки не сохраняем — они живут час.
function snapshot(track) {
  return {
    id: track.id,
    reloadId: track.reloadId || null,
    local: !!track.local,
    title: track.title,
    artist: track.artist,
    duration: track.duration || 0,
    cover: /^https:\/\//.test(track.cover || '') ? track.cover : ''
  };
}

function addTrack(id, track) {
  const all = read();
  const p = all.find((x) => x.id === id);
  if (!p) throw new Error('Плейлист не найден');
  if (!track || !track.id) throw new Error('Трек не распознан');

  if (p.tracks.some((t) => t.id === track.id)) {
    return { added: false, size: p.tracks.length };
  }

  p.tracks.push(snapshot(track));
  if (!p.cover && track.cover) p.cover = snapshot(track).cover;
  write(all);
  return { added: true, size: p.tracks.length };
}

function removeTrack(id, trackId) {
  const all = read();
  const p = all.find((x) => x.id === id);
  if (!p) throw new Error('Плейлист не найден');

  const before = p.tracks.length;
  p.tracks = p.tracks.filter((t) => t.id !== trackId);
  write(all);
  return { removed: before !== p.tracks.length, size: p.tracks.length };
}

function tracks(id) {
  const p = get(id);
  return p ? p.tracks : [];
}

module.exports = { init, list, get, create, rename, remove, addTrack, removeTrack, tracks };
