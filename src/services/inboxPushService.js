const { prisma } = require('../config/prisma');
const { logger } = require('../utils/logger');

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const SUPPORTED_LOCALES = new Set(['ru', 'ky', 'en']);
let warnedMissingPushLocaleColumns = false;

function isMissingPushLocaleColumnsError(error) {
  const code = `${error?.code || ''}`.trim().toUpperCase();
  if (code === 'P2021' || code === 'P2022') {
    const message = `${error?.message || ''}`.toLowerCase();
    if (message.includes('userpushendpoint')) return true;
  }

  const message = `${error?.message || ''}`.toLowerCase();
  return (
    message.includes('userpushendpoint') &&
    (message.includes('locale') || message.includes('timezone')) &&
    (message.includes('does not exist') || message.includes('no such column'))
  );
}

function normalizeLimit(value, fallback = 150, min = 1, max = 1000) {
  const number = Number.parseInt(`${value ?? ''}`.trim(), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizePushToken(value) {
  const text = `${value || ''}`.trim();
  if (!text) return '';
  return text.slice(0, 512);
}

function safeJsonParse(value, fallback = {}) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') return parsed;
    return fallback;
  } catch (_error) {
    return fallback;
  }
}

function normalizeLocale(value, fallback = 'ru') {
  const raw = `${value || ''}`.trim().toLowerCase();
  if (!raw) return fallback;
  const short = raw.split(/[-_]/)[0];
  if (SUPPORTED_LOCALES.has(short)) return short;
  return fallback;
}

function normalizeTimeZone(value, fallback = 'Asia/Bishkek') {
  const text = `${value || ''}`.trim();
  if (!text) return fallback;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: text }).format(new Date());
    return text;
  } catch (_error) {
    return fallback;
  }
}

function parseTimeToMinutes(value) {
  const text = `${value || ''}`.trim();
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function getZonedMinutes(now, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  });
  const parts = formatter.formatToParts(now);
  const hour = Number(parts.find((item) => item.type === 'hour')?.value || '0');
  const minute = Number(parts.find((item) => item.type === 'minute')?.value || '0');
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
  return hour * 60 + minute;
}

function getQuietHoursConfig(payload) {
  const source =
    payload?.delivery?.quietHours && typeof payload.delivery.quietHours === 'object'
      ? payload.delivery.quietHours
      : payload?.quietHours && typeof payload.quietHours === 'object'
      ? payload.quietHours
      : null;

  const start = parseTimeToMinutes(source?.start);
  const end = parseTimeToMinutes(source?.end);
  if (start === null || end === null || start === end) return null;
  return { start, end };
}

function getQuietHoursDelayMinutes(nowMinutes, quietHours) {
  if (!quietHours) return 0;
  const { start, end } = quietHours;

  if (start < end) {
    if (nowMinutes < start || nowMinutes >= end) return 0;
    return end - nowMinutes;
  }

  const isQuiet = nowMinutes >= start || nowMinutes < end;
  if (!isQuiet) return 0;
  if (nowMinutes >= start) {
    return 1440 - nowMinutes + end;
  }
  return end - nowMinutes;
}

function pickLocalizedText(payload, key, locale, fallback = '') {
  const direct = `${payload?.[key] || ''}`.trim();
  if (direct) return direct;

  const localizedMap =
    payload?.[`${key}ByLocale`] && typeof payload[`${key}ByLocale`] === 'object'
      ? payload[`${key}ByLocale`]
      : {};

  const preferred = `${localizedMap?.[locale] || ''}`.trim();
  if (preferred) return preferred;

  const ruFallback = `${localizedMap?.ru || ''}`.trim();
  if (ruFallback) return ruFallback;

  const kyFallback = `${localizedMap?.ky || ''}`.trim();
  if (kyFallback) return kyFallback;

  return `${fallback || ''}`.trim();
}

function truncateText(value, maxLength = 240) {
  const source = `${value || ''}`.replace(/\s+/g, ' ').trim();
  if (!source) return '';
  if (source.length <= maxLength) return source;
  return `${source.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function normalizeImageUrl(value) {
  const text = `${value || ''}`.trim();
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) return '';
  return text.slice(0, 2000);
}

function sanitizePushCtas(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((cta) => cta && typeof cta === 'object')
    .map((cta) => ({
      label: truncateText(cta.label, 80),
      route: `${cta.route || ''}`.trim().startsWith('/') ? `${cta.route || ''}`.trim().slice(0, 200) : undefined,
      url: /^https?:\/\//i.test(`${cta.url || ''}`.trim()) ? `${cta.url || ''}`.trim().slice(0, 1000) : undefined
    }))
    .filter((cta) => Boolean(cta.label) && (cta.route || cta.url))
    .slice(0, 2);
}

function nextRetryAt(attempts) {
  const attempt = Math.max(1, Number(attempts) || 1);
  const delays = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];
  const delayMs = delays[Math.min(delays.length - 1, attempt - 1)];
  return new Date(Date.now() + delayMs);
}

function makePushBody(delivery, token, endpointMeta = {}) {
  const item = delivery?.item || {};
  const payload = safeJsonParse(item?.payloadJson || '{}', {});
  const locale = normalizeLocale(endpointMeta.locale, 'ru');
  const title = truncateText(
    pickLocalizedText(payload, 'pushTitle', locale, '') ||
      pickLocalizedText(payload, 'title', locale, item?.title || 'Alma') ||
      'Alma',
    120
  );
  const body = truncateText(
    pickLocalizedText(payload, 'pushBody', locale, '') || pickLocalizedText(payload, 'message', locale, item?.message || ''),
    240
  );
  const imageUrl = normalizeImageUrl(payload?.imageUrl);
  const ctas = sanitizePushCtas(payload?.ctas);
  const explicitRoute = `${payload?.route || ''}`.trim();
  const route = (() => {
    if (explicitRoute.startsWith('/')) return explicitRoute;
    if (`${item?.type || ''}`.toUpperCase() === 'TEST') return '/personalization-test';
    return `/inbox/${encodeURIComponent(`${item?.id || ''}`)}`;
  })();

  const message = {
    to: token,
    sound: 'default',
    title,
    body,
    channelId: 'default',
    data: {
      type: 'inbox',
      inboxItemId: item?.id,
      inboxType: item?.type,
      route,
      locale,
      ctas
    }
  };

  if (imageUrl) {
    message.image = imageUrl;
    message.richContent = { image: imageUrl };
  }

  return message;
}

async function sendExpoPushBatch(messages) {
  if (!messages.length) return [];

  const response = await fetch(EXPO_PUSH_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(messages)
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.errors?.[0]?.message || payload?.error || `Expo push request failed (${response.status})`);
  }

  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows;
}

async function deactivateEndpoint(endpointId) {
  const id = `${endpointId || ''}`.trim();
  if (!id) return;
  try {
    await prisma.userPushEndpoint.update({
      where: { id },
      data: { isActive: false }
    });
  } catch (_error) {
    // no-op
  }
}

async function markDeliverySent(deliveryId) {
  await prisma.userInboxDelivery.update({
    where: { id: deliveryId },
    data: {
      pushState: 'SENT',
      pushedAt: new Date(),
      lastPushError: null,
      nextPushRetryAt: null
    }
  });
}

async function markDeliveryFailed(deliveryId, attempts, errorMessage) {
  await prisma.userInboxDelivery.update({
    where: { id: deliveryId },
    data: {
      pushState: 'FAILED',
      pushAttempts: attempts,
      lastPushError: `${errorMessage || 'push_failed'}`.slice(0, 1000),
      nextPushRetryAt: nextRetryAt(attempts)
    }
  });
}

async function markDeliveryDeferred(deliveryId, nextAt, reason = 'deferred') {
  await prisma.userInboxDelivery.update({
    where: { id: deliveryId },
    data: {
      pushState: 'PENDING',
      lastPushError: `${reason}`.slice(0, 1000),
      nextPushRetryAt: nextAt || new Date(Date.now() + 5 * 60_000)
    }
  });
}

async function processSingleDelivery(delivery) {
  const payload = safeJsonParse(delivery?.item?.payloadJson || '{}', {});
  const quietHours = getQuietHoursConfig(payload);
  const now = new Date();
  const endpointCandidates = (delivery?.user?.pushEndpoints || [])
    .map((endpoint) => ({
      id: endpoint.id,
      token: normalizePushToken(endpoint.pushToken),
      locale: normalizeLocale(endpoint.locale, 'ru'),
      timeZone: normalizeTimeZone(endpoint.timeZone, 'Asia/Bishkek')
    }))
    .filter((endpoint) => Boolean(endpoint.token));

  const quietDefers = [];
  const endpoints = endpointCandidates.filter((endpoint) => {
    if (!quietHours) return true;
    const nowMinutes = getZonedMinutes(now, endpoint.timeZone);
    const delayMinutes = getQuietHoursDelayMinutes(nowMinutes, quietHours);
    if (delayMinutes <= 0) return true;
    quietDefers.push(new Date(Date.now() + (delayMinutes + 1) * 60_000));
    return false;
  });

  if (!endpointCandidates.length) {
    await markDeliveryFailed(
      delivery.id,
      (delivery.pushAttempts || 0) + 1,
      'no_active_push_endpoints'
    );
    return { sent: 0, failed: 1, scanned: 1 };
  }

  if (!endpoints.length && quietDefers.length) {
    const nextAt = quietDefers.sort((a, b) => a.getTime() - b.getTime())[0];
    await markDeliveryDeferred(delivery.id, nextAt, 'quiet_hours');
    return { sent: 0, failed: 0, scanned: 1 };
  }

  const messages = endpoints.map((endpoint) => makePushBody(delivery, endpoint.token, endpoint));

  let resultRows;
  try {
    resultRows = await sendExpoPushBatch(messages);
  } catch (error) {
    await markDeliveryFailed(delivery.id, (delivery.pushAttempts || 0) + 1, error.message);
    return { sent: 0, failed: 1, scanned: 1 };
  }

  let hasSuccess = false;
  let failureMessage = '';

  for (let index = 0; index < resultRows.length; index += 1) {
    const row = resultRows[index] || {};
    if (`${row?.status || ''}`.toLowerCase() === 'ok') {
      hasSuccess = true;
      continue;
    }

    const detailsError = `${row?.details?.error || ''}`.trim();
    const rowMessage = `${row?.message || detailsError || 'push_ticket_error'}`.trim();
    failureMessage = failureMessage || rowMessage;

    if (detailsError === 'DeviceNotRegistered' || detailsError === 'InvalidCredentials') {
      const endpoint = endpoints[index];
      if (endpoint?.id) {
        await deactivateEndpoint(endpoint.id);
      }
    }
  }

  if (hasSuccess) {
    await markDeliverySent(delivery.id);
    return { sent: 1, failed: 0, scanned: 1 };
  }

  await markDeliveryFailed(delivery.id, (delivery.pushAttempts || 0) + 1, failureMessage || 'all_push_tickets_failed');
  return { sent: 0, failed: 1, scanned: 1 };
}

async function processPendingInboxPushes({ limit = 150 } = {}) {
  const now = new Date();
  const where = {
    state: 'UNREAD',
    pushState: { in: ['PENDING', 'FAILED'] },
    OR: [{ nextPushRetryAt: null }, { nextPushRetryAt: { lte: now } }],
    item: {
      status: 'PUBLISHED',
      AND: [
        { OR: [{ publishedAt: null }, { publishedAt: { lte: now } }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }
      ]
    }
  };
  const orderBy = [{ nextPushRetryAt: 'asc' }, { updatedAt: 'asc' }];
  const take = normalizeLimit(limit, 150, 1, 1000);

  let batch;
  try {
    batch = await prisma.userInboxDelivery.findMany({
      where,
      include: {
        item: true,
        user: {
          select: {
            pushEndpoints: {
              where: { isActive: true },
              select: { id: true, pushToken: true, locale: true, timeZone: true }
            }
          }
        }
      },
      orderBy,
      take
    });
  } catch (error) {
    if (!isMissingPushLocaleColumnsError(error)) throw error;

    if (!warnedMissingPushLocaleColumns) {
      warnedMissingPushLocaleColumns = true;
      logger.warn('UserPushEndpoint.locale/timeZone columns are missing. Push worker will use fallback defaults (ru, Asia/Bishkek) until migration is applied.');
    }

    batch = await prisma.userInboxDelivery.findMany({
      where,
      include: {
        item: true,
        user: {
          select: {
            pushEndpoints: {
              where: { isActive: true },
              select: { id: true, pushToken: true }
            }
          }
        }
      },
      orderBy,
      take
    });
  }

  let scanned = 0;
  let sent = 0;
  let failed = 0;

  for (const delivery of batch) {
    const result = await processSingleDelivery(delivery);
    scanned += result.scanned;
    sent += result.sent;
    failed += result.failed;
  }

  if (scanned > 0) {
    logger.info('Inbox push worker cycle finished', { scanned, sent, failed });
  }

  return { scanned, sent, failed };
}

async function registerPushEndpoint(userId, payload = {}) {
  const normalizedUserId = `${userId || ''}`.trim();
  const pushToken = normalizePushToken(payload.pushToken);
  if (!normalizedUserId || !pushToken) {
    throw new Error('pushToken is required');
  }

  const provider = `${payload.provider || 'expo'}`.trim().toLowerCase().slice(0, 32) || 'expo';
  const platform = `${payload.platform || 'unknown'}`.trim().toLowerCase().slice(0, 32) || 'unknown';
  const locale = normalizeLocale(payload.locale, 'ru');
  const timeZone = normalizeTimeZone(payload.timeZone, 'Asia/Bishkek');
  const now = new Date();

  let endpoint;
  try {
    endpoint = await prisma.userPushEndpoint.upsert({
      where: {
        provider_pushToken: {
          provider,
          pushToken
        }
      },
      update: {
        userId: normalizedUserId,
        platform,
        locale,
        timeZone,
        isActive: true,
        lastSeenAt: now
      },
      create: {
        userId: normalizedUserId,
        provider,
        platform,
        locale,
        timeZone,
        pushToken,
        isActive: true,
        lastSeenAt: now
      }
    });
  } catch (error) {
    if (!isMissingPushLocaleColumnsError(error)) throw error;

    if (!warnedMissingPushLocaleColumns) {
      warnedMissingPushLocaleColumns = true;
      logger.warn('UserPushEndpoint.locale/timeZone columns are missing. Push endpoint registration will skip locale/timeZone until migration is applied.');
    }

    endpoint = await prisma.userPushEndpoint.upsert({
      where: {
        provider_pushToken: {
          provider,
          pushToken
        }
      },
      update: {
        userId: normalizedUserId,
        platform,
        isActive: true,
        lastSeenAt: now
      },
      create: {
        userId: normalizedUserId,
        provider,
        platform,
        pushToken,
        isActive: true,
        lastSeenAt: now
      }
    });
  }

  await prisma.userInboxDelivery.updateMany({
    where: {
      userId: normalizedUserId,
      state: 'UNREAD',
      pushState: { in: ['PENDING', 'FAILED'] }
    },
    data: {
      nextPushRetryAt: now
    }
  });

  return endpoint;
}

async function unregisterPushEndpoint(userId, payload = {}) {
  const normalizedUserId = `${userId || ''}`.trim();
  const pushToken = normalizePushToken(payload.pushToken);
  if (!normalizedUserId || !pushToken) {
    throw new Error('pushToken is required');
  }

  const provider = `${payload.provider || 'expo'}`.trim().toLowerCase().slice(0, 32) || 'expo';

  const updated = await prisma.userPushEndpoint.updateMany({
    where: {
      userId: normalizedUserId,
      provider,
      pushToken
    },
    data: {
      isActive: false
    }
  });

  return { deactivated: updated.count };
}

module.exports = {
  processPendingInboxPushes,
  registerPushEndpoint,
  unregisterPushEndpoint
};

