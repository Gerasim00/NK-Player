// Проверка новой версии по GitHub Releases.
// Отдельного канала обновлений нет, поэтому сравниваем тег последнего релиза
// с версией из package.json. Сеть может быть недоступна — тогда молча живём дальше.

const { app, net } = require('electron');

const REPO = 'Gerasim00/NK-Player';
const CACHE_TTL = 6 * 60 * 60 * 1000; // не чаще раза в 6 часов

let cache = { at: 0, result: null };

// Теги вида v1.4.0, 1.4.0 и NK-Player-1.4.0 — берём первое числовое ядро,
// хвост после дефиса (beta, rc) отбрасываем.
function parseVersion(str) {
  const m = String(str || '').match(/\d+(?:\.\d+)*/);
  if (!m) return [0];
  return m[0].split('.').map((n) => parseInt(n, 10) || 0);
}

function compare(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function fetchLatest() {
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'NK-Player'
    }
  });

  // 404 — релизов ещё нет, это не ошибка
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub вернул ${res.status}`);

  const data = await res.json();
  return {
    tag: String(data.tag_name || ''),
    url: String(data.html_url || `https://github.com/${REPO}/releases`),
    notes: String(data.body || '').slice(0, 2000),
    published: data.published_at || ''
  };
}

async function check({ force = false } = {}) {
  const current = app.getVersion();
  if (!force && cache.result && Date.now() - cache.at < CACHE_TTL) {
    return { ...cache.result, current, cached: true };
  }

  let latest = null;
  let error = '';
  try {
    latest = await fetchLatest();
  } catch (e) {
    error = e.message || 'Нет связи с GitHub';
  }

  const result = {
    current,
    latest: latest ? latest.tag : '',
    url: latest ? latest.url : `https://github.com/${REPO}/releases`,
    notes: latest ? latest.notes : '',
    published: latest ? latest.published : '',
    updateAvailable: !!(latest && latest.tag && compare(latest.tag, current) > 0),
    error
  };

  // Неудачу не кэшируем — иначе при запуске без интернета кнопка «проверить»
  // будет шесть часов показывать старую ошибку.
  if (!error) {
    cache = { at: Date.now(), result };
  }

  return { ...result, cached: false };
}

module.exports = { check, compare };
