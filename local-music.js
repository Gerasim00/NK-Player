// Локальные файлы пользователя: копируем в профиль приложения, читаем ID3-теги
// (название, исполнитель, обложка) и держим небольшой index.json со списком.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.wma', '.mp4']);

let root = '';
let mediaDir = '';
let coverDir = '';

function init(userDataDir) {
  root = path.join(userDataDir, 'local-music');
  mediaDir = path.join(root, 'files');
  coverDir = path.join(root, 'covers');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(coverDir, { recursive: true });
}

const indexPath = () => path.join(root, 'index.json');

function readIndex() {
  try {
    const data = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function writeIndex(list) {
  fs.writeFileSync(indexPath(), JSON.stringify(list, null, 2), 'utf8');
}

// ------------------------------------------------------------ ID3

function syncsafe(buf, offset) {
  return ((buf[offset] & 0x7f) << 21) | ((buf[offset + 1] & 0x7f) << 14)
    | ((buf[offset + 2] & 0x7f) << 7) | (buf[offset + 3] & 0x7f);
}

function decodeText(buf, encoding) {
  let label = 'latin1';
  let start = 0;
  if (encoding === 1) {
    label = 'utf-16le';
    // BOM определяет порядок байтов
    if (buf[0] === 0xfe && buf[1] === 0xff) {
      label = 'utf-16be';
      start = 2;
    } else if (buf[0] === 0xff && buf[1] === 0xfe) {
      start = 2;
    }
  } else if (encoding === 2) {
    label = 'utf-16be';
  } else if (encoding === 3) {
    label = 'utf-8';
  }
  try {
    return new TextDecoder(label).decode(buf.subarray(start)).replace(/\0+$/g, '').trim();
  } catch (e) {
    return buf.subarray(start).toString('utf8').replace(/\0+$/g, '').trim();
  }
}

// Разбираем только нужные кадры: TIT2 (название), TPE1 (исполнитель), TALB, APIC (обложка)
function readId3(file) {
  const out = { title: '', artist: '', album: '', picture: null };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(10);
    fs.readSync(fd, head, 0, 10, 0);
    if (head.toString('latin1', 0, 3) !== 'ID3') return out;

    const version = head[3];
    const tagSize = syncsafe(head, 6);
    const size = Math.min(tagSize, 24 * 1024 * 1024);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 10);

    let pos = 0;
    while (pos + 10 < buf.length) {
      const id = buf.toString('latin1', pos, pos + 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const frameSize = version >= 4 ? syncsafe(buf, pos + 4) : buf.readUInt32BE(pos + 4);
      if (frameSize <= 0 || pos + 10 + frameSize > buf.length) break;
      const body = buf.subarray(pos + 10, pos + 10 + frameSize);

      if (id === 'TIT2' && !out.title) out.title = decodeText(body.subarray(1), body[0]);
      else if (id === 'TPE1' && !out.artist) out.artist = decodeText(body.subarray(1), body[0]);
      else if (id === 'TALB' && !out.album) out.album = decodeText(body.subarray(1), body[0]);
      else if (id === 'APIC' && !out.picture) {
        const enc = body[0];
        let p = 1;
        const mimeEnd = body.indexOf(0, p);
        if (mimeEnd > -1) {
          const mime = body.toString('latin1', p, mimeEnd);
          p = mimeEnd + 1;
          p += 1; // picture type
          // Описание тоже заканчивается нулём (в UTF-16 — двумя)
          if (enc === 1 || enc === 2) {
            while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2;
            p += 2;
          } else {
            const descEnd = body.indexOf(0, p);
            p = descEnd > -1 ? descEnd + 1 : p;
          }
          const data = body.subarray(p);
          if (data.length > 1024) {
            out.picture = { mime: mime || 'image/jpeg', data };
          }
        }
      }
      pos += 10 + frameSize;
    }
  } catch (e) {
    // битый тег — не повод ронять импорт
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (e) {}
  }
  return out;
}

function splitName(base) {
  const clean = base.replace(/_/g, ' ').trim();
  const m = clean.match(/^(.{2,80}?)\s*[-–—]\s*(.{1,120})$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: 'Неизвестный исполнитель', title: clean };
}

function saveCover(id, picture) {
  const ext = /png/i.test(picture.mime) ? '.png' : /webp/i.test(picture.mime) ? '.webp' : '.jpg';
  const file = path.join(coverDir, id + ext);
  fs.writeFileSync(file, picture.data);
  return pathToFileURL(file).href;
}
function toTrack(entry) {
  return {
    id: entry.id,
    title: entry.title,
    artist: entry.artist,
    album: entry.album || '',
    duration: entry.duration || 0,
    cover: entry.cover || '',
    url: pathToFileURL(entry.file).href,
    local: true,
    fileName: path.basename(entry.file)
  };
}

// ------------------------------------------------------------ API

function list() {
  const entries = readIndex();
  const alive = entries.filter((e) => {
    try { return fs.statSync(e.file).isFile(); } catch (err) { return false; }
  });
  if (alive.length !== entries.length) writeIndex(alive);
  return alive.map(toTrack);
}

function importFiles(paths) {
  const entries = readIndex();
  const added = [];

  for (const src of paths || []) {
    try {
      const stat = fs.statSync(src);
      if (!stat.isFile()) continue;
      const ext = path.extname(src).toLowerCase();
      if (!AUDIO_EXT.has(ext)) continue;

      const hash = crypto.createHash('sha1')
        .update(src + '|' + stat.size + '|' + stat.mtimeMs)
        .digest('hex').slice(0, 16);
      const id = 'local:' + hash;
      if (entries.some((e) => e.id === id)) continue;

      const dest = path.join(mediaDir, hash + ext);
      if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);

      const tags = ext === '.mp3' ? readId3(dest) : { title: '', artist: '', album: '', picture: null };
      const guess = splitName(path.basename(src, ext));

      const entry = {
        id,
        file: dest,
        title: tags.title || guess.title,
        artist: tags.artist || guess.artist,
        album: tags.album || '',
        duration: 0,
        cover: tags.picture ? saveCover(hash, tags.picture) : ''
      };
      entries.push(entry);
      added.push(toTrack(entry));
    } catch (e) {
      // файл пропускаем, остальные импортируем
    }
  }

  if (added.length) writeIndex(entries);
  return { tracks: list(), added: added.length };
}

function remove(id) {
  const entries = readIndex();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return list();
  try { fs.unlinkSync(entry.file); } catch (e) {}
  if (entry.cover) {
    try { fs.unlinkSync(require('url').fileURLToPath(entry.cover)); } catch (e) {}
  }
  writeIndex(entries.filter((e) => e.id !== id));
  return list();
}

function setDuration(id, duration) {
  const entries = readIndex();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  const value = Math.max(0, Math.round(Number(duration) || 0));
  if (!value || Math.abs((entry.duration || 0) - value) < 1) return;
  entry.duration = value;
  writeIndex(entries);
}

module.exports = { init, list, importFiles, remove, setDuration };
