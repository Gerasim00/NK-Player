// Тексты песен. Сначала LRCLIB (открытая база, есть синхронные LRC), если там
// пусто — NetEase Cloud Music: у него хорошее покрытие русской музыки и почти
// всегда построчные тайминги. Найденное (и «не найдено») кэшируем в профиле,
// чтобы повторный показ не ходил в сеть.

const fs = require('fs');
const path = require('path');
const { net } = require('electron');

const LRCLIB = 'https://lrclib.net/api';
const NETEASE = 'https://music.163.com/api';
const QQ_SEARCH = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp';
const QQ_LYRIC = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
// LRCLIB просит указывать в User-Agent клиент и ссылку на него
const LRCLIB_UA = 'NK-Player (https://github.com/Gerasim00/NK-Player)';
const NETEASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  Referer: 'https://music.163.com/'
};
const QQ_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://y.qq.com/'
};
const TIMEOUT = 12000;
const MISS_TTL = 3 * 24 * 60 * 60 * 1000; // «не найдено» перепроверяем через 3 дня
// Промах, при котором часть источников упала: держим недолго, иначе каждое
// открытие оверлея заново ходит в сеть
const PARTIAL_MISS_TTL = 10 * 60 * 1000;
const CACHE_MAX = 3000;
// Разница длительности, при которой считаем, что это та же запись, и
// показываем текст с таймингами
const DURATION_SLACK = 3;
// До этой разницы — та же песня, но залитая с лишним вступлением или хвостом
// (Static-P «It's Not Like I Like You»: 286 с в VK, 280 с в базе). Тайминги
// у неё поедут, поэтому только простой текст и только при точном совпадении
// исполнителя. Дальше — другая версия или чужая песня, текста нет.
const DURATION_NEAR = 10;
// Формат кэша: записи, найденные прежними правилами, сбрасываются
const CACHE_VERSION = 3;

let filePath = '';
let cache = null;

function init(userDataDir) {
  filePath = path.join(userDataDir, 'lyrics.json');
}

function readCache() {
  if (cache) return cache;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // Старый формат найден слишком мягким сравнением — среди записей есть
    // чужие тексты, ищем заново
    const entries = data && data.version === CACHE_VERSION && data.entries;
    cache = entries && typeof entries === 'object' && !Array.isArray(entries) ? entries : {};
  } catch (e) {
    cache = {};
  }
  return cache;
}

function writeCache() {
  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX) {
    keys.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0));
    for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k];
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify({ version: CACHE_VERSION, entries: cache }), 'utf8');
  } catch (e) { /* не записали — найдём заново в следующий раз */ }
}

// ---------- Нормализация ----------

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

// «X feat. Y», «X, Y», «X & Y» — для поиска нужен основной исполнитель
function mainArtist(artist) {
  return String(artist || '')
    .split(/\s+(?:feat\.?|ft\.?|при уч\.?)\s+/i)[0]
    .split(/\s*[,&]\s*/)[0]
    .trim();
}

// Пометки версии, которых нет в названиях у баз текстов. Русские тоже:
// «Группа крови (ремастер)» на NetEase даёт выдачу из чужих треков, а без
// приписки находится с первого раза. Караоке и инструментал не трогаем —
// их лучше распознать как «слов нет», чем показать чужой текст.
const VERSION_MARK =
  'feat|ft\\.|prod|remaster|explicit|official|bonus|clean|radio edit|remix|mix|edit|' +
  'live|demo|deluxe|reissue|acoustic|sped up|slowed|nightcore|from|' +
  'верси|ремаст|ремикс|лайв|концерт|демо|бонус|делюкс|акустик|микс';

// Приписки в скобках и через тире: «Song (Remastered 2011)», «Песня - ремикс».
// Пометка должна стоять в начале приписки — иначе срезалась бы скобка с частью
// названия: «Песня (Я живу тобой)» остаётся как есть.
function cleanTitle(title) {
  const original = String(title || '').trim();
  return (
    original
      .replace(new RegExp(`\\s*[([]\\s*(?:${VERSION_MARK})[^)\\]]*[)\\]]`, 'giu'), '')
      .replace(/\s*[([]\s*(?:19|20)\d{2}\s*[)\]]/g, '')
      .replace(new RegExp(`\\s+[–—-]\\s+(?:${VERSION_MARK})[\\s\\S]*$`, 'iu'), '')
      .replace(/\s+[–—-]\s+(?:19|20)\d{2}\s*$/g, '')
      .replace(/\s+(?:feat\.?|ft\.)\s+.*$/i, '')
      .trim() || original
  );
}

// Названия сверяем только целиком, по нормализованной форме без пометок
// версии. По подстроке к коротким названиям («Дом», «Мия») липли чужие треки.
function sameTitle(a, b) {
  const x = norm(cleanTitle(a));
  return !!x && x === norm(cleanTitle(b));
}

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e',
  ю: 'yu', я: 'ya'
};

// Грубый «скелет» имени: кириллица в латиницу и схлопывание букв, которые
// пишут по-разному. Так «Пирокинезис» совпадает с «Pyrokinesis», а «ЛСП» —
// с «LSP», но «Кино» с «Кинофабрикой» не путается.
function skeleton(s) {
  return norm(s)
    .replace(/[а-я]/g, (ch) => TRANSLIT[ch])
    .replace(/ph/g, 'f')
    .replace(/[yj]/g, 'i')
    .replace(/z/g, 's')
    .replace(/w/g, 'v')
    .replace(/ck|c|q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/(.)\1+/g, '$1');
}

// Исполнителей сверяем мягче: в базах встречаются «Мумий Тролль» и «Мумий
// Тролль и …», «ЛСП» и «ЛСП feat. …». Но включение — только целыми словами,
// иначе «Кино» совпадало бы с «Кинофабрикой».
function sameArtist(a, b) {
  const x = norm(mainArtist(a));
  const y = norm(mainArtist(b));
  if (!x || !y) return false;
  if (x === y || skeleton(x) === skeleton(y)) return true;
  const words = (s) => ` ${String(mainArtist(s)).toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ')} `;
  const wa = words(a);
  const wb = words(b);
  return wa.includes(wb) || wb.includes(wa);
}

// Длительность в ключе: у ремастера и оригинала тайминги разные, а название
// с исполнителем совпадают — иначе один затирал бы другой в кэше.
function cacheKey(artist, title, duration) {
  return `${norm(mainArtist(artist))}\u0000${norm(cleanTitle(title))}\u0000${Math.round(duration || 0)}`;
}

// ---------- LRC ----------

// [offset:N] в миллисекундах: положительное значение сдвигает текст раньше.
// Многие LRC-редакторы пишут его вместо правки каждой метки — без учёта текст
// уезжает на всё значение, отсюда «отстаёт/спешит на несколько секунд».
function offsetOf(text) {
  const m = String(text || '').match(/\[offset:\s*([+-]?\d+)\s*\]/i);
  return m ? Number(m[1]) / 1000 : 0;
}

// Строка может нести несколько меток: [00:12.30][01:40.00]Припев.
// extraShift — сдвиг из шапки, снятой до вызова (китайские базы чистятся
// вместе с тегами, и сам parseLrc этот тег уже не увидит).
function parseLrc(text, extraShift) {
  const src = String(text || '');
  const shift = offsetOf(src) + (Number(extraShift) || 0);
  const lines = [];
  for (const raw of src.split(/\r?\n/)) {
    const stamps = [];
    const re = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/gy;
    let m;
    let end = 0;
    while ((m = re.exec(raw))) {
      stamps.push(Number(m[1]) * 60 + Number(m[2].replace(':', '.')));
      end = re.lastIndex;
    }
    if (!stamps.length) continue;
    const line = stripWordTags(raw.slice(end)).trim();
    for (const t of stamps) lines.push({ t: Math.max(0, Math.round((t - shift) * 100) / 100), text: line });
  }
  return lines.sort((a, b) => a.t - b.t);
}

function lrcToPlain(lines) {
  return lines.map((l) => l.text).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Пословные метки караоке внутри строки: <00:12.30> и <0,600>. В LRC они
// служебные, но при показе текста вылезают прямо в строке — это и есть
// артефакты вида «<0,600>Поёт<0,540>».
function stripWordTags(text) {
  return String(text || '')
    .replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '')
    .replace(/<\d{1,4}[,.]\d{1,4}>/g, '');
}

// Шапка китайских баз: «作词 : …», «作曲 : …» и служебные JSON-строки
const LYRICS_CREDITS = /^(?:作词|作曲|编曲|制作人|监制|混音|母带|和声|吉他|贝斯|鼓|录音|弦乐|出品|发行|OP|SP|词|曲)\s*[:：]/i;
// QQ часто отдаёт текстом первую строку «Название (Explicit) - Исполнитель»
// и английскую шапку авторов
const LYRICS_CREDITS_EN = /^(?:lyrics?|composed?|written|music|words)\s*(?:by|:)/i;

// shift — [offset:N] из текста, который уже снят чисткой до парсера.
function finish(source, syncedText, plainText, duration, shift) {
  let synced = parseLrc(syncedText, shift);
  // Синхронный текст без единой непустой строки — это не текст
  if (!synced.some((l) => l.text)) synced = [];
  const plain = String(plainText || '').trim() || lrcToPlain(synced);
  if (!plain) return null;
  return { source, synced, plain, instrumental: false, duration: Math.round(duration || 0) };
}

function durationDiff(a, b) {
  return a && b ? Math.abs(a - b) : Infinity;
}

// Одно название с исполнителем не гарантирует ничего: у каверов и перепетых
// песен («Прекрасное далёко») в базах лежит текст оригинала. Поэтому запись
// принимаем, только если сошлась и длительность: до DURATION_SLACK — при любом
// написании исполнителя, до DURATION_NEAR — лишь при точном.
function fits(candidate, q) {
  const diff = durationDiff(candidate.duration, q.duration);
  if (diff > DURATION_NEAR || !candidate.artists.some((name) => sameArtist(name, q.artist))) return false;
  return diff <= DURATION_SLACK || candidate.artists.some((name) => norm(mainArtist(name)) === norm(q.artist));
}

// Русский трек с текстом из одних иероглифов — заведомо чужой текст
// с тем же названием
function fitsLanguage(result, q) {
  if (result.instrumental || !/\p{Script=Cyrillic}/u.test(`${q.artist} ${q.title}`)) return true;
  return !HAN.test(result.plain) || NON_HAN_LETTER.test(result.plain);
}

function isExact(result, duration) {
  return durationDiff(result.duration, duration) <= DURATION_SLACK;
}

// Тайминги отдаём, только если длины совпадают; иначе — тот же текст без них
function tune(result, duration) {
  if (!result) return null;
  return {
    source: result.source,
    synced: isExact(result, duration) ? result.synced : [],
    plain: result.plain,
    instrumental: result.instrumental
  };
}

// ---------- HTTP ----------

async function getJson(url, headers) {
  // Без cookie: NetEase ставит NMTID, и с ней поиск отдаёт случайные китайские хиты
  const res = await net.fetch(url, { headers, credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------- Отбор кандидатов ----------

// Общий для NetEase и QQ: название, исполнитель и длительность должны
// совпасть все три. Без проверки артиста к «www» Ленинграда цеплялась
// китайская песня той же длины, без проверки длины — чужая версия песни.
function candidatesOf(list, q, fields) {
  return (Array.isArray(list) ? list : [])
    .filter((s) => s && sameTitle(fields.title(s), q.title))
    .map((s) => ({ item: s, duration: fields.duration(s), artists: fields.artists(s), title: q.title }))
    .filter((c) => fits(c, q))
    .sort((a, b) => durationDiff(a.duration, q.duration) - durationDiff(b.duration, q.duration));
}

// Хвост китайских баз: «Recorded at …», «Operatic Vocals : Freddie Mercury».
// Проверяем только хвост — в середине песни такие слова встречаются в тексте.
// Пробел перед двоеточием обязателен: «Припев:» в тексте так не пишут, а
// кредиты в китайских базах — всегда с ним.
const LYRICS_TAIL_CREDITS =
  /^(?:recorded|produced|mixed|mastered|engineered|written|composed|arranged|artwork|cover)\b|^(?:записан|спродюсирован|сведён|сведен|мастеринг|слова|музыка)\b/i;

function isTailCredit(text) {
  return LYRICS_TAIL_CREDITS.test(text) || /^[\p{L}][^.!?…]{0,40}\s[:：]\s\S/u.test(text);
}

// Теги шапки LRC: [ti:название], [ar:исполнитель], [al:альбом], [by:…],
// [offset:…]. Раньше с них снимались только скобки, и текст песни начинался
// со строк «Название - Исполнитель» и кредитов — их и видно артефактами.
const LRC_META = /^\s*\[(?:ti|ar|al|au|by|re|ve|length|offset|kana|tool|encoding|hash|sign|total|qq|id)\s*:/i;

// Служебные приписки загрузчиков: «未经许可,不得翻唱或使用», «原曲：…»,
// «本歌词由…» — в текст песни они не входят
const LYRICS_NOTICE = /未经|许可|翻唱|原曲|本歌词|歌词贡献|歌词由|版权/;
// Имя исполнителя реплики перед строкой: «纱世里：…»
const SPEAKER_PREFIX = /^\p{Script=Han}{1,8}\s*[:：]\s*/u;
const HAN = /\p{Script=Han}/u;
const NON_HAN_LETTER = /[\p{Script=Latin}\p{Script=Cyrillic}]/u;

// Текст из китайских баз: убираем шапку, заглушки и служебные строки
function cleanChineseLrc(lrc, title) {
  const stamp = (line) => (line.match(/^(\[[^\]]*\])+/) || [''])[0];
  let lines = String(lrc || '')
    // Неразрывные пробелы не дают длинной строке переноситься
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('{'))
    // Мусорные хвосты base64/JSON-обёрток, которые иногда попадают в поле lrc
    .filter((line) => !/^[A-Za-z0-9+/=]{40,}$/.test(line.trim()))
    .filter((line) => !LRC_META.test(line))
    .filter((line) => {
      const text = line.replace(/^(\[[^\]]*\])+/, '').trim();
      // «......» — заглушка вместо вступления
      return !LYRICS_CREDITS.test(text) && !LYRICS_CREDITS_EN.test(text) &&
        !LYRICS_NOTICE.test(text) && !/^[.…·]{2,}$/.test(text);
    })
    // Префикс реплики снимаем после кредитов: «作词 : …» тоже подходит под него
    .map((line) => {
      const text = line.slice(stamp(line).length).trim();
      return stamp(line) + text.replace(SPEAKER_PREFIX, '');
    });

  const textOf = (line) => line.replace(/^(\[[^\]]*\])+/, '').trim();

  // Русская или английская песня с подклеенным китайским переводом: строки
  // перевода выбрасываем. Китайская песня (иероглифов больше) остаётся как есть.
  const hanOnly = (line) => HAN.test(textOf(line)) && !NON_HAN_LETTER.test(textOf(line));
  const hanCount = lines.filter(hanOnly).length;
  const otherCount = lines.filter((line) => NON_HAN_LETTER.test(textOf(line))).length;
  if (hanCount && otherCount >= hanCount) lines = lines.filter((line) => !hanOnly(line));

  while (lines.length && !textOf(lines[0])) lines.shift();
  while (lines.length && !textOf(lines[lines.length - 1])) lines.pop();
  // Первая строка-заголовок: «<название> - <исполнитель>», «<название> by
  // <исполнитель>», «<название> (<исполнитель>)»
  if (lines.length && title) {
    const head = textOf(lines[0]);
    const left = head.split(/\s+(?:[-–—]|by)\s+|\s*[(（]/i)[0];
    if (left !== head && norm(left) === norm(cleanTitle(title))) lines.shift();
  }
  while (lines.length && isTailCredit(textOf(lines[lines.length - 1]))) lines.pop();

  return lines
    .join('\n')
    // В базах апострофы часто удвоены: I''m
    .replace(/''/g, "'");
}

function fromChineseLrc(source, rawLrc, duration, title) {
  if (/纯音乐/.test(rawLrc)) {
    return { source, synced: [], plain: '', instrumental: true, duration: Math.round(duration) };
  }
  // Сдвиг снимаем до чистки: тег [offset:N] — служебный, из текста он уходит
  const shift = offsetOf(rawLrc);
  const cleaned = cleanChineseLrc(rawLrc, title);
  const timed = /\[\d{1,3}:\d{1,2}/.test(cleaned);
  return finish(source, timed ? cleaned : '', timed ? '' : cleaned, duration, shift);
}

// ---------- LRCLIB ----------

function pickLrclib(list, q) {
  const items = (Array.isArray(list) ? list : [])
    .filter((x) => x && sameTitle(x.trackName, q.title) && fits({ duration: x.duration, artists: [x.artistName] }, q))
    .map((x) => ({ x, diff: durationDiff(x.duration, q.duration) }));
  // Сначала та же запись, затем с таймингами, затем ближе по длительности
  items.sort((a, b) =>
    ((a.diff > DURATION_SLACK) - (b.diff > DURATION_SLACK)) ||
    (!!b.x.syncedLyrics - !!a.x.syncedLyrics) ||
    (a.diff - b.diff));
  return items[0] || null;
}

async function fromLrclib(q) {
  const params = new URLSearchParams({ track_name: q.title, artist_name: q.artist });
  let hit = pickLrclib(await getJson(`${LRCLIB}/search?${params}`, { 'User-Agent': LRCLIB_UA }), q);
  if (!hit) {
    const loose = new URLSearchParams({ q: `${q.artist} ${q.title}` });
    hit = pickLrclib(await getJson(`${LRCLIB}/search?${loose}`, { 'User-Agent': LRCLIB_UA }), q);
  }
  if (!hit) return null;
  if (hit.x.instrumental) {
    return { source: 'lrclib', synced: [], plain: '', instrumental: true, duration: Math.round(hit.x.duration || 0) };
  }
  return finish('lrclib', hit.x.syncedLyrics, hit.x.plainLyrics, hit.x.duration);
}

// ---------- NetEase ----------

const NETEASE_FIELDS = {
  title: (s) => s.name,
  artists: (s) => (s.artists || []).map((a) => a.name),
  duration: (s) => (s.duration || 0) / 1000
};

async function neteaseSearch(query, limit) {
  const params = new URLSearchParams({ type: 1, limit, s: query });
  const found = await getJson(`${NETEASE}/search/get?${params}`, NETEASE_HEADERS);
  return (found && found.result && found.result.songs) || [];
}

async function neteaseLyric(c) {
  const data = await getJson(`${NETEASE}/song/lyric?id=${c.item.id}&lv=1&tv=-1`, NETEASE_HEADERS);
  if (!data || data.nolyric || data.uncollected) return null;
  return fromChineseLrc('netease', String((data.lrc && data.lrc.lyric) || ''), c.duration, c.title);
}

async function fromNetease(q) {
  // Первый запрос — «артист название». Ранжирование NetEase по релевантности
  // часто вытесняет нужную запись каверами, поэтому если он не дал текста,
  // второй раз ищем только по названию: так находятся те же песни, но
  // с другим написанием артиста.
  const passes = [
    { query: `${q.artist} ${q.title}`, limit: 10 },
    { query: q.title, limit: 30 }
  ];
  for (const pass of passes) {
    const candidates = candidatesOf(await neteaseSearch(pass.query, pass.limit), q, NETEASE_FIELDS);
    // У NetEase бывают дубли без текста — пробуем пару лучших
    for (const c of candidates.slice(0, 3)) {
      const out = await neteaseLyric(c);
      if (out) return out;
    }
  }
  return null;
}

// ---------- QQ Music ----------

// Название и длительность приходят, но альбомный вариант отдельной копией,
// поэтому ремастеры в выдаче живут рядом с оригиналом
const QQ_FIELDS = {
  title: (s) => s.songname,
  artists: (s) => (s.singer || []).map((x) => x.name),
  duration: (s) => s.interval || 0
};

async function qqSearch(query) {
  const params = new URLSearchParams({ format: 'json', n: 8, w: query });
  const found = await getJson(`${QQ_SEARCH}?${params}`, QQ_HEADERS);
  return (found && found.data && found.data.song && found.data.song.list) || [];
}

// Текст у QQ приходит в base64 внутри JSON
async function qqLyric(c) {
  const payload = JSON.stringify({
    comm: { ct: 24, cv: 0 },
    lyric: {
      module: 'music.musichallSong.PlayLyricInfo',
      method: 'GetPlayLyricInfo',
      param: { songMID: c.item.songmid }
    }
  });
  const data = await getJson(`${QQ_LYRIC}?format=json&data=${encodeURIComponent(payload)}`, QQ_HEADERS);
  const b64 = data && data.lyric && data.lyric.data && data.lyric.data.lyric;
  if (!b64) return null;
  let lrc = '';
  try {
    lrc = Buffer.from(String(b64).replace(/\s/g, ''), 'base64').toString('utf8');
  } catch (e) {
    return null;
  }
  return fromChineseLrc('qq', lrc, c.duration, c.title);
}

async function fromQq(q) {
  const passes = [{ query: `${q.artist} ${q.title}` }, { query: q.title }];
  for (const pass of passes) {
    const candidates = candidatesOf(await qqSearch(pass.query), q, QQ_FIELDS);
    for (const c of candidates.slice(0, 3)) {
      const out = await qqLyric(c);
      if (out) return out;
    }
  }
  return null;
}

// ---------- Поиск ----------

// Порядок важен: LRCLIB даёт самые чистые тексты, NetEase лучше всех знает
// русскую музыку, QQ добирает то, чего у первых двух нет
const SOURCES = [fromLrclib, fromNetease, fromQq];

async function get(track) {
  const artist = mainArtist(track && track.artist);
  const title = cleanTitle(track && track.title);
  const q = { artist, title, duration: Math.round(Number(track && track.duration) || 0) };
  // Без длительности не сверить запись — лучше без текста, чем с чужим
  if (!artist || !title || !q.duration) return null;

  const key = cacheKey(artist, title, q.duration);
  const store = readCache();
  const hit = store[key];
  if (hit) {
    // Промах с упавшими источниками перепроверяем раньше полного
    const ttl = hit.partial ? PARTIAL_MISS_TTL : MISS_TTL;
    if (hit.result || Date.now() - hit.at < ttl) return tune(hit.result, q.duration);
  }

  let failed = 0;
  let result = null;
  for (const source of SOURCES) {
    try {
      const found = await source(q);
      if (!found || !fitsLanguage(found, q)) continue;
      // Инструментал — дальше искать нечего
      if (found.instrumental) { result = found; break; }
      // Синхронный текст той же записи — лучше не найти
      const exact = isExact(found, q.duration);
      if (exact && found.synced.length) { result = found; break; }
      // Остальное держим про запас и ищем дальше: у соседнего источника тот же
      // трек часто с построчными метками или с точной длительностью
      if (!result || (exact && !isExact(result, q.duration))) result = found;
    } catch (e) {
      failed++;
    }
  }

  // Все сервисы лежат — говорим об этом и не запоминаем «не найдено»
  if (!result && failed === SOURCES.length) throw new Error('Сервисы текстов недоступны, попробуйте позже');
  if (result) store[key] = { at: Date.now(), result };
  // Промах пишем всегда, но если часть источников упала — ненадолго: иначе
  // каждое открытие оверлея заново ходит в сеть
  else store[key] = { at: Date.now(), result: null, partial: failed > 0 };
  writeCache();
  return tune(result, q.duration);
}

module.exports = { init, get };
