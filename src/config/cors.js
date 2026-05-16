const { env } = require('./env');

const LOCALHOST_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i;
const IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * CORS решает, каким сайтам/приложениям можно обращаться к backend из браузера.
 *
 * Важно понимать:
 * - React Native/Expo native обычно не упирается в браузерный CORS;
 * - web-версия, GitHub Pages, localhost и Cloudflare tunnel зависят от CORS;
 * - если открыть CORS слишком широко, любой чужой сайт сможет делать запросы
 *   к нашему API от имени пользователя, если у него есть токен/сессия.
 *
 * Поэтому здесь разрешаются только понятные источники:
 * - локальная разработка;
 * - Expo-схемы;
 * - LAN-адреса в development;
 * - домены из .env и дефолтные домены проекта.
 */
function normalizeOrigin(origin) {
  // Браузер присылает origin в виде "scheme://host:port".
  // Нормализуем через URL, чтобы убрать path/query и сравнивать только origin.
  if (!origin || typeof origin !== 'string') return null;
  try {
    return new URL(origin).origin;
  } catch (_error) {
    return null;
  }
}

function isExpoOrigin(origin) {
  // Expo Go и dev-client могут приходить не как http(s), а как exp:// или exps://.
  // Такие origins нужны для мобильной разработки.
  if (!origin || typeof origin !== 'string') return false;
  return /^exps?:\/\//i.test(origin);
}

function isLocalDevOrigin(origin) {
  // localhost/127.0.0.1/0.0.0.0 разрешаются всегда: это основной web/dev сценарий.
  if (!origin || typeof origin !== 'string') return false;
  return LOCALHOST_PATTERN.test(origin.trim());
}

function isPrivateIpv4(hostname) {
  // Проверяем частные IPv4-диапазоны: телефон в одной Wi-Fi сети часто ходит на
  // backend по адресу вида http://192.168.x.x:4000.
  if (!IPV4_PATTERN.test(hostname)) return false;
  const parts = hostname.split('.').map((item) => Number(item));
  if (parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return false;

  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  return false;
}

function isLanOrigin(origin) {
  // LAN-origin разрешается только не в production. В production частные IP лучше
  // не открывать, чтобы случайно не расширить поверхность атаки.
  if (!origin || typeof origin !== 'string') return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isPrivateIpv4(parsed.hostname);
  } catch (_error) {
    return false;
  }
}

const domainDefaults = [
  // Дефолтные публичные домены проекта. Root может быть занят туннелем/backend,
  // а www может указывать на GitHub Pages/static frontend.
  'https://ai-friendly.site',
  'https://www.ai-friendly.site',
  'http://ai-friendly.site',
  'http://www.ai-friendly.site'
];

const allowedOrigins = new Set(
  [...env.frontendOrigins, ...domainDefaults]
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean)
);

function isOriginAllowed(origin) {
  // Отсутствующий origin бывает у curl, server-to-server запросов и некоторых native
  // клиентов. Это не браузерный CORS-сценарий, поэтому пропускаем.
  if (!origin || origin === 'null') return true;
  if (isExpoOrigin(origin)) return true;
  if (isLocalDevOrigin(origin)) return true;
  // Для мобильных оболочек Capacitor/Ionic, если когда-то будет webview wrapper.
  if (origin.startsWith('capacitor://') || origin.startsWith('ionic://')) return true;
  if (env.nodeEnv !== 'production' && isLanOrigin(origin)) return true;

  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;

  return allowedOrigins.has(normalized);
}

function corsOrigin(origin, callback) {
  // Express cors middleware ожидает callback(null, true), если origin разрешён.
  // Если origin не разрешён, отдаём явную ошибку: это помогает быстро увидеть
  // неправильный домен в логах backend.
  if (isOriginAllowed(origin)) {
    callback(null, true);
    return;
  }
  callback(new Error(`Origin не разрешен CORS: ${origin || 'unknown'}`));
}

module.exports = { corsOrigin, isOriginAllowed };
