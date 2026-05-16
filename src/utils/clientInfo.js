/**
 * clientInfo.js — определяет примерное устройство клиента.
 *
 * Это не security-механизм. User-Agent можно подделать.
 * Но для админки, истории сессий и логов этого достаточно: видно, откуда примерно
 * заходил пользователь — Android, iOS, браузер, Expo Go и т.д.
 */

function normalizeIp(value) {
  // Node/прокси иногда отдаёт IPv4 как "::ffff:127.0.0.1".
  // Для логов удобнее хранить обычный IPv4.
  const raw = `${value || ''}`.trim();
  if (!raw) return null;
  if (raw.startsWith('::ffff:')) return raw.slice(7);
  return raw;
}

function extractIpFromHeaders(headers = {}, fallbackIp = null) {
  // За Cloudflare/прокси реальный IP часто лежит не в req.ip,
  // а в x-forwarded-for или cf-connecting-ip.
  const forwarded =
    headers['x-forwarded-for'] ||
    headers['X-Forwarded-For'] ||
    headers['cf-connecting-ip'] ||
    headers['CF-Connecting-IP'];

  if (typeof forwarded === 'string' && forwarded.trim()) {
    // x-forwarded-for может быть списком. Первый IP — обычно исходный клиент.
    const first = forwarded.split(',')[0].trim();
    return normalizeIp(first);
  }

  return normalizeIp(fallbackIp);
}

function detectClientInfo(userAgentRaw = '') {
  // Определение очень простое: ищем ключевые слова в User-Agent.
  // Это специально не сложная библиотека, потому что точность тут не критична.
  const userAgent = `${userAgentRaw || ''}`.trim();
  const ua = userAgent.toLowerCase();

  let platform = 'Unknown';
  if (ua.includes('android')) platform = 'Android';
  else if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) platform = 'iOS';
  else if (ua.includes('windows')) platform = 'Windows';
  else if (ua.includes('mac os') || ua.includes('macintosh')) platform = 'macOS';
  else if (ua.includes('linux')) platform = 'Linux';

  let appName = 'Unknown';
  if (ua.includes('expo') || ua.includes('expo-go')) appName = 'Expo Go';
  else if (ua.includes('okhttp')) appName = 'Mobile App';
  else if (ua.includes('edg/')) appName = 'Edge';
  else if (ua.includes('chrome/')) appName = 'Chrome';
  else if (ua.includes('firefox/')) appName = 'Firefox';
  else if (ua.includes('safari/') && !ua.includes('chrome/')) appName = 'Safari';
  else if (ua.includes('mozilla/')) appName = 'Web Browser';

  let device = `${appName} (${platform})`;
  if (appName === 'Unknown' && platform === 'Unknown') device = 'Unknown device';
  if (appName === 'Web Browser') device = `${appName} (${platform})`;

  return {
    userAgent: userAgent || null,
    platform,
    appName,
    device
  };
}

function buildRequestClientInfo(req) {
  // Версия для обычных HTTP/REST запросов.
  const headers = req?.headers || {};
  const ipAddress = extractIpFromHeaders(headers, req?.ip || req?.socket?.remoteAddress || null);
  const detected = detectClientInfo(headers['user-agent'] || headers['User-Agent'] || '');

  return {
    ipAddress,
    ...detected
  };
}

function buildSocketClientInfo(socket) {
  // Версия для Socket.IO: там данные лежат в socket.handshake.
  const headers = socket?.handshake?.headers || {};
  const ipAddress = extractIpFromHeaders(headers, socket?.handshake?.address || null);
  const detected = detectClientInfo(headers['user-agent'] || headers['User-Agent'] || '');

  return {
    ipAddress,
    ...detected
  };
}

module.exports = {
  normalizeIp,
  extractIpFromHeaders,
  detectClientInfo,
  buildRequestClientInfo,
  buildSocketClientInfo
};
