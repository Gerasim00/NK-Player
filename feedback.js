// feedback.js — отправка отзывов из NK Player в Discord-канал разработчика.
//
// Webhook-адрес в исходниках не хранится: репозиторий содержит только
// зашифрованный XOR-ключ (XOR с ключом KEY + base64). Расшифрованный URL
// собирается в рантайме main-процесса и в окно не попадает.
// Ключ-файл `feedback.key` лежит рядом с модулем, в .gitignore не попадает,
// но пакуется в сборку (см. build.files в package.json). Без него отправка
// честно откажет — форма покажет ошибку, остальной плеер не затронут.
//
// Использование (main-процесс):
//   await feedback.sendFeedback({ rating: 4, comment: 'Трек зашёл!', version: '1.5.0' });

const fs = require('fs');
const path = require('path');

const MAX_COMMENT = 1200;        // предел поля в окне настроек
const REQUEST_TIMEOUT = 15000;   // Discord может подвиснуть — не ждём вечно

// Ключ XOR — без него содержимое feedback.key бесполезно.
const KEY = 'NK~Feedback/2026^vK9';

function loadWebhookUrl() {
  // Переменная окружения — для отладки своим ключом, приоритетнее файла
  if (process.env.DISCORD_WEBHOOK_URL) return process.env.DISCORD_WEBHOOK_URL;

  let blob;
  try {
    blob = fs.readFileSync(path.join(__dirname, 'feedback.key'), 'utf8').trim();
  } catch (err) {
    throw new Error('Отзывы не настроены: нет файла feedback.key');
  }
  if (!blob) throw new Error('Отзывы не настроены: файл feedback.key пуст');

  const data = Buffer.from(blob, 'base64');
  const key = Buffer.from(KEY, 'utf8');
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % key.length];
  const url = out.toString('utf8');

  if (!/^https:\/\/discord\.com\/api\/webhooks\//.test(url)) {
    throw new Error('Отзывы не настроены: ключ feedback.key повреждён');
  }
  return url;
}

/** Цвет embed-а по оценке: 1 — красный … 5 — зелёный. */
function ratingColor(rating) {
  switch (rating) {
    case 5: return 0x57f287;
    case 4: return 0xfee75c;
    case 3: return 0x5865f2;
    case 2: return 0xe67e22;
    case 1: return 0xed4245;
    default: return 0x5865f2;
  }
}

/** «⭐⭐⭐☆☆» для оценки 3. */
function stars(rating) {
  const r = Math.max(1, Math.min(5, Math.round(rating)));
  return '⭐'.repeat(r) + '☆'.repeat(5 - r);
}

/** Название оценки. */
function ratingLabel(rating) {
  switch (rating) {
    case 5: return 'Отлично';
    case 4: return 'Хорошо';
    case 3: return 'Средне';
    case 2: return 'Плохо';
    case 1: return 'Очень плохо';
    default: return 'Без оценки';
  }
}

/**
 * Собирает payload Discord-сообщения. Вынесено отдельно, чтобы проверять
 * без реальной отправки.
 */
function buildPayload({ rating, comment, version }) {
  const r = Math.round(Number(rating));
  if (!(r >= 1 && r <= 5) || Number.isNaN(r)) {
    throw new Error('rating должен быть числом от 1 до 5');
  }

  let text = String(comment || '').trim();
  if (!text) throw new Error('comment не может быть пустым');
  if (text.length > MAX_COMMENT) text = text.slice(0, MAX_COMMENT);

  const name = version ? `NK Player v${version}` : 'NK Player';

  return {
    username: 'NK Feedback', // имя, под которым публикуется сообщение
    embeds: [
      {
        title: `${stars(r)}  —  ${ratingLabel(r)}`,
        description: text,
        color: ratingColor(r),
        footer: { text: name },
        timestamp: new Date().toISOString(),
      },
    ],
    allowed_mentions: { parse: [] }, // отзыв не может упоминать никого
  };
}

/**
 * Отправляет отзыв в Discord.
 * @param {object} options
 * @param {number}  options.rating   Оценка 1–5
 * @param {string}  options.comment  Текст отзыва
 * @param {string}  [options.version] Версия плеера для подписи
 * @returns {Promise<{ ok: boolean, status: number }>}
 */
async function sendFeedback({ rating, comment, version } = {}) {
  const url = loadWebhookUrl();
  const payload = buildPayload({ rating, comment, version });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord вернул ${res.status}: ${body.slice(0, 200)}`);
  }
  return { ok: true, status: res.status };
}

module.exports = { sendFeedback, buildPayload, stars, MAX_COMMENT };
