const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { env } = require('../config/env');

const UPLOAD_ROOT = path.resolve(__dirname, '../../uploads');
const USERS_UPLOAD_ROOT = path.join(UPLOAD_ROOT, 'users');

/**
 * mediaStorage.js — общая работа с файлами пользователей.
 *
 * Здесь собрана низкоуровневая логика:
 * - как выбрать расширение файла по MIME;
 * - как безопасно собрать путь uploads/users/<userId>/...;
 * - как data:image/...;base64 сохранить на диск;
 * - как вернуть publicUrl, который увидит frontend.
 */

const MIME_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/m4a': 'm4a',
  'audio/aac': 'm4a',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/xml': 'xml',
  'application/json': 'json',
  'application/xml': 'xml',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
};

function isPrivateHostname(hostname) {
  // Private hosts — это localhost и локальная сеть.
  // Для публичных ссылок их обычно нельзя отдавать, потому что телефон пользователя
  // не сможет открыть localhost сервера.
  const host = `${hostname || ''}`.trim().toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

function normalizeHttpUrlCandidate(url, { allowPrivate = false } = {}) {
  // Принимаем только http/https URL.
  // Если allowPrivate=false, отбрасываем localhost/LAN.
  const text = `${url || ''}`.trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    if (!/^https?:$/i.test(parsed.protocol)) return '';
    if (!allowPrivate && isPrivateHostname(parsed.hostname)) return '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    return '';
  }
}

function buildRequestBaseUrl(req) {
  // Когда backend стоит за Cloudflare/nginx, реальный protocol/host лежит
  // в forwarded headers. Если их нет, используем обычный req.protocol + host.
  const forwardedProtoRaw = `${req?.headers?.['x-forwarded-proto'] || ''}`.trim();
  const forwardedHostRaw = `${req?.headers?.['x-forwarded-host'] || ''}`.trim();
  const hostRaw = `${req?.headers?.host || ''}`.trim();

  const protocol = (forwardedProtoRaw.split(',')[0] || req?.protocol || 'http').trim();
  const host = (forwardedHostRaw.split(',')[0] || hostRaw).trim();
  if (!host) return '';
  return `${protocol}://${host}`;
}

function resolvePublicBaseUrl(req, { allowPrivate = false } = {}) {
  // Приоритет:
  // 1. публичный URL из текущего запроса;
  // 2. MEDIA_PUBLIC_BASE_URL / APP_URL из .env;
  // 3. private URL только если явно разрешили.
  const requestBasePublic = normalizeHttpUrlCandidate(buildRequestBaseUrl(req), { allowPrivate: false });
  const envBase = normalizeHttpUrlCandidate(env.mediaPublicBaseUrl || env.appUrl, { allowPrivate });
  if (requestBasePublic) return requestBasePublic;
  if (envBase) return envBase;
  if (!allowPrivate) return '';
  const requestBasePrivate = normalizeHttpUrlCandidate(buildRequestBaseUrl(req), { allowPrivate: true });
  return requestBasePrivate || '';
}

function sanitizePathSegment(value, fallback = 'unknown') {
  // Пользовательский id/segment нельзя вставлять в путь как есть.
  // Убираем всё опасное, чтобы не получить ../ или странные символы в имени папки.
  const text = `${value || ''}`.trim().replace(/[^\w.-]/g, '_');
  return text || fallback;
}

function resolveUserMediaDir(userId, segments = []) {
  // Итоговый путь всегда внутри uploads/users/<safeUserId>/...
  const safeUserId = sanitizePathSegment(userId, 'guest');
  const safeSegments = (Array.isArray(segments) ? segments : [])
    .map((segment) => sanitizePathSegment(segment, 'x'))
    .filter(Boolean);
  return path.join(USERS_UPLOAD_ROOT, safeUserId, ...safeSegments);
}

function resolveExtensionByMime(mimeType, fallback = 'bin') {
  // MIME приходит от клиента/браузера. Если неизвестный — используем безопасный fallback.
  const normalized = `${mimeType || ''}`.trim().toLowerCase();
  if (!normalized) return fallback;
  return MIME_EXTENSIONS[normalized] || fallback;
}

function parseDataUrl(dataUrl) {
  // Поддерживаем формат: data:image/png;base64,AAAA...
  // Это часто приходит с canvas, preview или мобильного клиента.
  const raw = `${dataUrl || ''}`.trim();
  const match = raw.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) return null;

  const mimeType = `${match[1] || ''}`.trim().toLowerCase();
  const base64 = `${match[2] || ''}`.trim();
  if (!mimeType || !base64) return null;

  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) return null;

  return {
    mimeType,
    base64,
    buffer
  };
}

async function persistBufferForUser({
  userId,
  segments = [],
  prefix = 'file',
  mimeType,
  buffer,
  req,
  publicBaseUrl
}) {
  // Если buffer пустой, сохранять нечего.
  if (!buffer || !Buffer.isBuffer(buffer) || !buffer.length) return null;

  const targetDir = resolveUserMediaDir(userId, segments);
  await fs.mkdir(targetDir, { recursive: true });

  // Имя строим по hash содержимого. Плюсы:
  // - одинаковый файл не плодится много раз;
  // - имя не зависит от опасного original filename клиента.
  const safePrefix = sanitizePathSegment(prefix, 'file');
  const ext = resolveExtensionByMime(mimeType, 'bin');
  const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 24);
  const fileName = `${safePrefix}_${hash}.${ext}`;
  const filePath = path.join(targetDir, fileName);

  try {
    await fs.access(filePath);
  } catch (_error) {
    // Если файла с таким hash ещё нет, записываем.
    await fs.writeFile(filePath, buffer);
  }

  // publicUrl нужен frontend, а filePath нужен серверу.
  const relativePath = path.relative(UPLOAD_ROOT, filePath).replace(/\\/g, '/');
  const base = `${publicBaseUrl || resolvePublicBaseUrl(req, { allowPrivate: true }) || ''}`.trim();
  const publicUrl = base ? `${base}/uploads/${relativePath}` : '';

  return {
    filePath,
    fileName,
    relativePath,
    publicUrl,
    mimeType: `${mimeType || ''}`.trim().toLowerCase() || null,
    size: buffer.length
  };
}

async function persistDataUrlForUser({
  userId,
  dataUrl,
  segments = [],
  prefix = 'file',
  req,
  publicBaseUrl,
  allowedMimePrefixes = ['image/']
}) {
  // Сначала превращаем dataUrl в { mimeType, buffer }.
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;

  // allowedMimePrefixes защищает endpoint от неожиданной загрузки не того типа.
  // Например, для картинок разрешаем только image/.
  const prefixes = Array.isArray(allowedMimePrefixes) ? allowedMimePrefixes : [];
  if (prefixes.length) {
    const allowed = prefixes.some((prefixItem) => parsed.mimeType.startsWith(`${prefixItem || ''}`.toLowerCase()));
    if (!allowed) return null;
  }

  return persistBufferForUser({
    userId,
    segments,
    prefix,
    mimeType: parsed.mimeType,
    buffer: parsed.buffer,
    req,
    publicBaseUrl
  });
}

module.exports = {
  UPLOAD_ROOT,
  USERS_UPLOAD_ROOT,
  buildRequestBaseUrl,
  normalizeHttpUrlCandidate,
  resolvePublicBaseUrl,
  resolveExtensionByMime,
  parseDataUrl,
  resolveUserMediaDir,
  persistBufferForUser,
  persistDataUrlForUser
};
