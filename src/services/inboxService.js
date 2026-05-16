const { prisma } = require('../config/prisma');
const { env } = require('../config/env');
const { getIo } = require('../socket/io');
const { userRoom } = require('../socket/rooms');
const { AppError } = require('../utils/errors');
const { getProConfig, hasProAccess } = require('./proConfigService');

const INBOX_TYPES = new Set(['TEST', 'NEWS', 'SYSTEM']);
const INBOX_SCOPES = new Set(['GLOBAL', 'USER', 'SEGMENT']);
const INBOX_STATES = new Set(['UNREAD', 'SEEN', 'SKIPPED', 'COMPLETED', 'DISMISSED']);
const INBOX_PUBLISH_STATUSES = new Set(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'CANCELED']);
const INBOX_SEGMENTS = new Set(['all_users', 'admins', 'pro_users', 'no_pro_users', 'new_users_7d']);
let warnedMissingPushLocaleColumn = false;
const MEDIA_PUBLIC_ORIGIN = (() => {
  const raw = `${env.mediaPublicBaseUrl || env.appUrl || ''}`.trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/i.test(parsed.protocol)) return '';
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_error) {
    return '';
  }
})();

function isPrivateHostname(hostname) {
  const host = `${hostname || ''}`.trim().toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

function rewritePrivateMediaUrl(rawValue) {
  const value = `${rawValue || ''}`.trim();
  if (!value || /^data:/i.test(value)) return value;

  let parsed;
  try {
    parsed = value.startsWith('//') ? new URL(`https:${value}`) : new URL(value);
  } catch (_error) {
    return value;
  }

  if (!/^https?:$/i.test(parsed.protocol)) return value;
  if (!isPrivateHostname(parsed.hostname)) return value;
  if (!MEDIA_PUBLIC_ORIGIN) return value;

  try {
    const publicOrigin = new URL(MEDIA_PUBLIC_ORIGIN);
    parsed.protocol = publicOrigin.protocol;
    parsed.hostname = publicOrigin.hostname;
    parsed.port = publicOrigin.port || '';
    return parsed.toString();
  } catch (_error) {
    return value;
  }
}

function sanitizeInboxPayloadMediaUrls(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const next = { ...payload };

  const simpleKeys = ['imageUrl', 'image', 'coverImage', 'mediaUrl'];
  for (const key of simpleKeys) {
    if (typeof next[key] !== 'string') continue;
    next[key] = rewritePrivateMediaUrl(next[key]);
  }

  if (next.richContent && typeof next.richContent === 'object' && !Array.isArray(next.richContent)) {
    next.richContent = { ...next.richContent };
    if (typeof next.richContent.image === 'string') {
      next.richContent.image = rewritePrivateMediaUrl(next.richContent.image);
    }
  }

  if (Array.isArray(next.attachments)) {
    next.attachments = next.attachments.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const item = { ...entry };
      if (typeof item.url === 'string') item.url = rewritePrivateMediaUrl(item.url);
      if (typeof item.imageUrl === 'string') item.imageUrl = rewritePrivateMediaUrl(item.imageUrl);
      return item;
    });
  }

  if (Array.isArray(next.blocks)) {
    next.blocks = next.blocks.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const item = { ...entry };
      if (typeof item.imageUrl === 'string') item.imageUrl = rewritePrivateMediaUrl(item.imageUrl);
      return item;
    });
  }

  return next;
}

function isMissingPushLocaleColumnError(error) {
  const code = `${error?.code || ''}`.trim().toUpperCase();
  if (code === 'P2022' || code === 'P2021') return true;
  const message = `${error?.message || ''}`.toLowerCase();
  return message.includes('userpushendpoint') && message.includes('locale') && message.includes('does not exist');
}

function safeJsonParse(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function normalizeType(value) {
  const next = `${value || ''}`.trim().toUpperCase();
  return INBOX_TYPES.has(next) ? next : 'SYSTEM';
}

function normalizeScope(value) {
  const next = `${value || ''}`.trim().toUpperCase();
  return INBOX_SCOPES.has(next) ? next : 'GLOBAL';
}

function normalizeState(value) {
  const next = `${value || ''}`.trim().toUpperCase();
  return INBOX_STATES.has(next) ? next : 'UNREAD';
}

function normalizePublishStatus(value) {
  const next = `${value || ''}`.trim().toUpperCase();
  return INBOX_PUBLISH_STATUSES.has(next) ? next : 'DRAFT';
}

function normalizeTypesFilter(value) {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  const normalized = [];
  for (const item of source) {
    const next = `${item || ''}`.trim().toUpperCase();
    if (!INBOX_TYPES.has(next)) continue;
    if (!normalized.includes(next)) normalized.push(next);
  }
  return normalized;
}

function normalizeDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function normalizeTargetUserIds(raw) {
  const source = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const unique = new Set();
  for (const item of source) {
    const next = `${item || ''}`.trim();
    if (!next) continue;
    unique.add(next.slice(0, 128));
    if (unique.size >= 5000) break;
  }
  return Array.from(unique);
}

function normalizeSegmentKey(raw) {
  const key = `${raw || ''}`.trim().toLowerCase();
  return INBOX_SEGMENTS.has(key) ? key : null;
}

function normalizeLimit(value, fallback = 50, min = 1, max = 200) {
  const number = Number.parseInt(`${value ?? ''}`.trim(), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeSince(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeRepeatPlan(payload = {}) {
  const source =
    payload?.schedule && typeof payload.schedule === 'object' && !Array.isArray(payload.schedule)
      ? payload.schedule
      : payload;

  const repeatEveryMinutes = Number.parseInt(`${source?.repeatEveryMinutes ?? ''}`.trim(), 10);
  const maxOccurrences = Number.parseInt(`${source?.maxOccurrences ?? ''}`.trim(), 10);
  const repeatUntilRaw = `${source?.repeatUntil || ''}`.trim();
  const repeatUntil = repeatUntilRaw ? new Date(repeatUntilRaw) : null;

  const isValidRepeatInterval = Number.isFinite(repeatEveryMinutes) && repeatEveryMinutes >= 1;
  if (!isValidRepeatInterval) return null;

  return {
    repeatEveryMinutes: Math.min(60 * 24 * 14, Math.max(1, repeatEveryMinutes)),
    maxOccurrences: Number.isFinite(maxOccurrences) && maxOccurrences >= 1
      ? Math.min(1000, Math.max(1, maxOccurrences))
      : null,
    repeatUntil: repeatUntil && Number.isFinite(repeatUntil.getTime()) ? repeatUntil : null
  };
}

function computeTouchAt(item, delivery) {
  const values = [
    item?.updatedAt ? new Date(item.updatedAt).getTime() : 0,
    item?.publishedAt ? new Date(item.publishedAt).getTime() : 0,
    item?.createdAt ? new Date(item.createdAt).getTime() : 0,
    delivery?.updatedAt ? new Date(delivery.updatedAt).getTime() : 0,
    delivery?.deliveredAt ? new Date(delivery.deliveredAt).getTime() : 0
  ];
  const max = Math.max(...values.filter((value) => Number.isFinite(value)));
  return Number.isFinite(max) && max > 0 ? new Date(max) : new Date();
}

function makeDeliveryState(item, delivery) {
  const payload = sanitizeInboxPayloadMediaUrls(safeJsonParse(item?.payloadJson, {}));
  const progress = safeJsonParse(delivery?.progressJson, {});
  const touchAt = computeTouchAt(item, delivery);
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    message: item.message,
    payload,
    templateKey: item.templateKey || null,
    scope: item.scope,
    publishedAt: item.publishedAt || item.createdAt,
    expiresAt: item.expiresAt || null,
    state: delivery?.state || 'UNREAD',
    progress,
    deliveredAt: delivery?.deliveredAt || null,
    seenAt: delivery?.seenAt || null,
    skippedAt: delivery?.skippedAt || null,
    completedAt: delivery?.completedAt || null,
    dismissedAt: delivery?.dismissedAt || null,
    updatedAt: touchAt.toISOString()
  };
}

function normalizeLocale(value, fallback = 'ru') {
  const raw = `${value || ''}`.trim().toLowerCase();
  if (!raw) return fallback;
  const short = raw.split(/[-_]/)[0];
  if (short === 'ru' || short === 'ky' || short === 'en') return short;
  return fallback;
}

function pickLocalizedValue(map, locale, fallback) {
  const source = map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  const preferred = `${source?.[locale] || ''}`.trim();
  if (preferred) return preferred;
  const ru = `${source?.ru || ''}`.trim();
  if (ru) return ru;
  const ky = `${source?.ky || ''}`.trim();
  if (ky) return ky;
  return `${fallback || ''}`.trim();
}

function localizeInboxItemForLocale(item, locale) {
  const payload = safeJsonParse(item?.payloadJson || '{}', {});
  const normalizedLocale = normalizeLocale(locale, 'ru');
  const title = pickLocalizedValue(payload?.titleByLocale, normalizedLocale, item?.title || '');
  const message = pickLocalizedValue(payload?.messageByLocale, normalizedLocale, item?.message || '');
  return {
    ...item,
    title,
    message
  };
}

async function resolvePreferredLocaleForUser(userId) {
  const normalizedUserId = `${userId || ''}`.trim();
  if (!normalizedUserId) return 'ru';
  try {
    const endpoint = await prisma.userPushEndpoint.findFirst({
      where: { userId: normalizedUserId, isActive: true },
      orderBy: [{ lastSeenAt: 'desc' }, { updatedAt: 'desc' }],
      select: { locale: true }
    });
    return normalizeLocale(endpoint?.locale || 'ru', 'ru');
  } catch (error) {
    if (isMissingPushLocaleColumnError(error)) {
      if (!warnedMissingPushLocaleColumn) {
        warnedMissingPushLocaleColumn = true;
        console.warn('[inbox] UserPushEndpoint.locale column is missing. Falling back to default locale "ru" until migration is applied.');
      }
      return 'ru';
    }
    throw error;
  }
}

async function resolveSegmentUserIds(segmentKey) {
  const normalized = normalizeSegmentKey(segmentKey);
  if (!normalized) return [];

  if (normalized === 'admins') {
    const rows = await prisma.user.findMany({
      where: { role: 'ADMIN', isDeleted: false },
      select: { id: true }
    });
    return rows.map((row) => row.id);
  }

  if (normalized === 'new_users_7d') {
    const threshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const rows = await prisma.user.findMany({
      where: { isDeleted: false, createdAt: { gte: threshold } },
      select: { id: true }
    });
    return rows.map((row) => row.id);
  }

  const users = await prisma.user.findMany({
    where: { isDeleted: false },
    select: { id: true, role: true }
  });

  if (normalized === 'all_users') {
    return users.map((user) => user.id);
  }

  const proConfig = await getProConfig();
  return users
    .filter((user) => {
      const hasAccess = hasProAccess(user, proConfig);
      if (normalized === 'pro_users') return hasAccess;
      if (normalized === 'no_pro_users') return !hasAccess;
      return false;
    })
    .map((user) => user.id);
}

function emitInboxRefreshGlobal(itemId) {
  const io = getIo();
  if (!io) return;
  io.emit('inbox:refresh', {
    scope: 'global',
    itemId,
    updatedAt: new Date().toISOString()
  });
}

function emitInboxItemToUsers(item, userIds = []) {
  const io = getIo();
  if (!io || !item) return;
  const unique = Array.from(new Set(userIds.map((value) => `${value || ''}`.trim()).filter(Boolean)));
  if (!unique.length) return;

  const payload = {
    id: item.id,
    type: item.type,
    title: item.title,
    message: item.message,
    payload: sanitizeInboxPayloadMediaUrls(safeJsonParse(item.payloadJson, {})),
    templateKey: item.templateKey || null,
    scope: item.scope,
    publishedAt: item.publishedAt || item.createdAt,
    expiresAt: item.expiresAt || null,
    state: 'UNREAD',
    updatedAt: new Date().toISOString()
  };

  for (const userId of unique) {
    io.to(userRoom(userId)).emit('inbox:item', {
      userId,
      item: payload
    });
    io.to(userRoom(userId)).emit('inbox:refresh', {
      scope: 'user',
      userId,
      itemId: item.id,
      updatedAt: new Date().toISOString()
    });
  }
}

async function scheduleNextRepeatItemIfNeeded(item) {
  if (!item || `${item.status || ''}`.toUpperCase() !== 'PUBLISHED') return null;

  const payload = safeJsonParse(item.payloadJson || '{}', {});
  const repeatPlan = normalizeRepeatPlan(payload);
  if (!repeatPlan) return null;

  const meta =
    payload?._repeatMeta && typeof payload._repeatMeta === 'object' ? payload._repeatMeta : {};
  const occurrence = Number.isFinite(Number(meta.occurrence))
    ? Math.max(0, Number.parseInt(`${meta.occurrence}`, 10))
    : 0;

  if (repeatPlan.maxOccurrences && occurrence + 1 >= repeatPlan.maxOccurrences) {
    return null;
  }

  const baseTime = item.publishedAt || item.createdAt || new Date();
  const nextScheduledAt = new Date(baseTime.getTime() + repeatPlan.repeatEveryMinutes * 60_000);

  if (repeatPlan.repeatUntil && nextScheduledAt.getTime() > repeatPlan.repeatUntil.getTime()) {
    return null;
  }

  const nextPayload = {
    ...payload,
    _repeatMeta: {
      occurrence: occurrence + 1,
      parentItemId: meta.parentItemId || item.id
    }
  };

  const created = await prisma.inboxItem.create({
    data: {
      type: item.type,
      scope: item.scope,
      status: 'SCHEDULED',
      title: item.title,
      message: item.message,
      payloadJson: JSON.stringify(nextPayload),
      templateKey: item.templateKey || null,
      segmentKey: item.segmentKey || null,
      scheduledAt: nextScheduledAt,
      expiresAt: item.expiresAt || null,
      createdById: item.createdById || null
    }
  });

  if (`${item.scope || ''}`.toUpperCase() !== 'GLOBAL') {
    const targets = await prisma.inboxItemUserTarget.findMany({
      where: { itemId: item.id },
      select: { userId: true }
    });
    const targetUserIds = targets.map((row) => row.userId);
    if (targetUserIds.length) {
      await createInboxTargetsWithoutDuplicates(created.id, targetUserIds);
    }
  }

  return created;
}

async function getActiveUserIds() {
  const rows = await prisma.user.findMany({
    where: { isDeleted: false },
    select: { id: true }
  });
  return rows.map((row) => row.id);
}

function isUniqueConstraintError(error) {
  return Boolean(error && typeof error === 'object' && error.code === 'P2002');
}

async function createInboxTargetsWithoutDuplicates(itemId, userIds = []) {
  const unique = Array.from(new Set(userIds.map((value) => `${value || ''}`.trim()).filter(Boolean)));
  if (!unique.length) return [];

  const existing = await prisma.inboxItemUserTarget.findMany({
    where: {
      itemId,
      userId: { in: unique }
    },
    select: { userId: true }
  });
  const existingSet = new Set(existing.map((row) => row.userId));
  const missing = unique.filter((userId) => !existingSet.has(userId));
  if (!missing.length) return [];

  const data = missing.map((userId) => ({ itemId, userId }));

  try {
    await prisma.inboxItemUserTarget.createMany({ data });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    for (const row of data) {
      try {
        await prisma.inboxItemUserTarget.create({ data: row });
      } catch (innerError) {
        if (!isUniqueConstraintError(innerError)) throw innerError;
      }
    }
  }

  return missing;
}

async function createUserInboxDeliveriesWithoutDuplicates(itemId, userIds = [], now = new Date()) {
  const unique = Array.from(new Set(userIds.map((value) => `${value || ''}`.trim()).filter(Boolean)));
  if (!unique.length) return 0;

  const existing = await prisma.userInboxDelivery.findMany({
    where: {
      itemId,
      userId: { in: unique }
    },
    select: { userId: true }
  });
  const existingSet = new Set(existing.map((row) => row.userId));
  const missing = unique.filter((userId) => !existingSet.has(userId));
  if (!missing.length) return 0;

  const data = missing.map((userId) => ({
    itemId,
    userId,
    state: 'UNREAD',
    pushState: 'PENDING',
    pushAttempts: 0,
    nextPushRetryAt: now,
    deliveredAt: now,
    lastSyncedAt: now
  }));

  try {
    await prisma.userInboxDelivery.createMany({ data });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    for (const row of data) {
      try {
        await prisma.userInboxDelivery.create({ data: row });
      } catch (innerError) {
        if (!isUniqueConstraintError(innerError)) throw innerError;
      }
    }
  }

  return missing.length;
}

async function createTargetUsers(itemId, userIds = []) {
  const unique = Array.from(new Set(userIds.map((value) => `${value || ''}`.trim()).filter(Boolean)));
  if (!unique.length) return [];

  await createInboxTargetsWithoutDuplicates(itemId, unique);
  await createUserInboxDeliveriesWithoutDuplicates(itemId, unique, new Date());

  return unique;
}

async function publishItemById(itemId) {
  const now = new Date();
  const updated = await prisma.inboxItem.update({
    where: { id: itemId },
    data: {
      status: 'PUBLISHED',
      publishedAt: now
    },
    include: {
      targetUsers: { select: { userId: true } }
    }
  });

  if (updated.scope === 'GLOBAL') {
    const globalUserIds = await getActiveUserIds();
    if (globalUserIds.length) {
      await createUserInboxDeliveriesWithoutDuplicates(updated.id, globalUserIds, now);
    }
    emitInboxRefreshGlobal(updated.id);
  } else {
    const targetUserIds = updated.targetUsers.map((row) => row.userId);
    emitInboxItemToUsers(updated, targetUserIds);
  }

  await scheduleNextRepeatItemIfNeeded(updated).catch(() => null);

  return updated;
}

async function createInboxItemByAdmin(adminId, payload = {}) {
  const type = normalizeType(payload.type);
  const scope = normalizeScope(payload.scope);
  const title = `${payload.title || ''}`.trim().slice(0, 180);
  const message = `${payload.message || ''}`.trim().slice(0, 2000);
  if (!title) throw new AppError(400, 'Title is required');
  if (!message) throw new AppError(400, 'Message is required');

  const templateKey = `${payload.templateKey || ''}`.trim().slice(0, 120) || null;
  const segmentKey = scope === 'SEGMENT' ? normalizeSegmentKey(payload.segmentKey) : null;
  const scheduledAt = normalizeDate(payload.scheduledAt);
  const expiresAt = normalizeDate(payload.expiresAt);
  const publishNow = payload.publishNow === true || `${payload.publishNow || ''}`.trim().toLowerCase() === 'true';
  const targetUserIdsFromBody = normalizeTargetUserIds(payload.targetUserIds);

  let targetUserIds = [];
  if (scope === 'USER') {
    targetUserIds = targetUserIdsFromBody;
    if (!targetUserIds.length) {
      throw new AppError(400, 'At least one target user is required for USER scope');
    }
  } else if (scope === 'SEGMENT') {
    if (!segmentKey) throw new AppError(400, 'Valid segmentKey is required for SEGMENT scope');
    targetUserIds = await resolveSegmentUserIds(segmentKey);
  }

  let status = normalizePublishStatus(payload.status);
  let publishedAt = null;
  if (publishNow) {
    status = 'PUBLISHED';
    publishedAt = new Date();
  } else if (scheduledAt && scheduledAt.getTime() > Date.now()) {
    status = 'SCHEDULED';
  } else if (status === 'PUBLISHED') {
    publishedAt = new Date();
  }

  const created = await prisma.inboxItem.create({
    data: {
      type,
      scope,
      status,
      title,
      message,
      payloadJson: JSON.stringify(
        payload.payload && typeof payload.payload === 'object' && !Array.isArray(payload.payload)
          ? payload.payload
          : {}
      ),
      templateKey,
      segmentKey,
      scheduledAt,
      publishedAt,
      expiresAt,
      createdById: `${adminId || ''}`.trim() || null
    }
  });

  if (scope !== 'GLOBAL') {
    await createTargetUsers(created.id, targetUserIds);
  }

  if (status === 'PUBLISHED') {
    if (scope === 'GLOBAL') {
      const globalUserIds = await getActiveUserIds();
      if (globalUserIds.length) {
        await createUserInboxDeliveriesWithoutDuplicates(created.id, globalUserIds, new Date());
      }
      emitInboxRefreshGlobal(created.id);
    } else {
      emitInboxItemToUsers(created, targetUserIds);
    }
    await scheduleNextRepeatItemIfNeeded(created).catch(() => null);
  }

  return created;
}

async function getInboxFeedForUser(userId, options = {}) {
  const normalizedUserId = `${userId || ''}`.trim();
  if (!normalizedUserId) return { items: [], cursor: null };
  const preferredLocale = await resolvePreferredLocaleForUser(normalizedUserId);
  const limit = normalizeLimit(options.limit, 60, 1, 300);
  const since = normalizeSince(options.since);
  const now = new Date();

  const items = await prisma.inboxItem.findMany({
    where: {
      status: 'PUBLISHED',
      AND: [
        { OR: [{ publishedAt: null }, { publishedAt: { lte: now } }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        {
          OR: [{ scope: 'GLOBAL' }, { targetUsers: { some: { userId: normalizedUserId } } }]
        }
      ]
    },
    include: {
      deliveries: {
        where: { userId: normalizedUserId },
        take: 1
      }
    },
    orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
    take: limit
  });

  const upserts = [];
  const mapped = [];
  const nowDate = new Date();

  for (const item of items) {
    let delivery = Array.isArray(item.deliveries) && item.deliveries.length ? item.deliveries[0] : null;
    const touchAt = computeTouchAt(item, delivery);
    // Use strict "older than since" filter to avoid missing cards that share
    // the same millisecond timestamp as the cursor.
    if (since && touchAt.getTime() < since.getTime()) continue;

    if (!delivery) {
      upserts.push(
        prisma.userInboxDelivery.create({
          data: {
            itemId: item.id,
            userId: normalizedUserId,
            state: 'UNREAD',
            pushState: 'PENDING',
            pushAttempts: 0,
            nextPushRetryAt: nowDate,
            deliveredAt: nowDate,
            lastSyncedAt: nowDate
          }
        }).catch(() => null)
      );
      delivery = {
        state: 'UNREAD',
        progressJson: '{}',
        deliveredAt: nowDate,
        seenAt: null,
        skippedAt: null,
        completedAt: null,
        dismissedAt: null,
        updatedAt: nowDate
      };
    } else {
      upserts.push(
        prisma.userInboxDelivery.update({
          where: {
            itemId_userId: {
              itemId: item.id,
              userId: normalizedUserId
            }
          },
          data: {
            lastSyncedAt: nowDate
          }
        }).catch(() => null)
      );
    }

    const normalized = makeDeliveryState(localizeInboxItemForLocale(item, preferredLocale), delivery);
    if (normalized.state === 'DISMISSED') continue;
    mapped.push(normalized);
  }

  if (upserts.length) {
    await Promise.all(upserts);
  }

  // Never move cursor to "now" on empty delta responses. Otherwise a short
  // race can permanently skip cards published between polls.
  const latestCursorTime = mapped.reduce((latest, entry) => {
    const timestamp = new Date(entry?.updatedAt || 0).getTime();
    if (!Number.isFinite(timestamp) || timestamp <= 0) return latest;
    return Math.max(latest, timestamp);
  }, 0);
  const cursor = latestCursorTime
    ? new Date(latestCursorTime).toISOString()
    : since
      ? since.toISOString()
      : null;
  return { items: mapped, cursor };
}

async function getInboxItemForUser(userId, itemId) {
  const normalizedUserId = `${userId || ''}`.trim();
  const normalizedItemId = `${itemId || ''}`.trim();
  if (!normalizedUserId || !normalizedItemId) {
    throw new AppError(400, 'Invalid inbox target');
  }
  const preferredLocale = await resolvePreferredLocaleForUser(normalizedUserId);

  const now = new Date();
  const item = await prisma.inboxItem.findFirst({
    where: {
      id: normalizedItemId,
      status: 'PUBLISHED',
      AND: [
        { OR: [{ publishedAt: null }, { publishedAt: { lte: now } }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }
      ],
      OR: [{ scope: 'GLOBAL' }, { targetUsers: { some: { userId: normalizedUserId } } }]
    },
    include: {
      deliveries: {
        where: { userId: normalizedUserId },
        take: 1
      }
    }
  });
  if (!item) {
    throw new AppError(404, 'Inbox item not found');
  }

  const nowDate = new Date();
  let delivery = Array.isArray(item.deliveries) && item.deliveries.length ? item.deliveries[0] : null;
  if (!delivery) {
    try {
      delivery = await prisma.userInboxDelivery.create({
        data: {
          itemId: item.id,
          userId: normalizedUserId,
          state: 'UNREAD',
          pushState: 'PENDING',
          pushAttempts: 0,
          nextPushRetryAt: nowDate,
          deliveredAt: nowDate,
          lastSyncedAt: nowDate
        }
      });
    } catch (_error) {
      delivery = await prisma.userInboxDelivery.findUnique({
        where: { itemId_userId: { itemId: item.id, userId: normalizedUserId } }
      });
    }
  } else {
    await prisma.userInboxDelivery
      .update({
        where: { itemId_userId: { itemId: item.id, userId: normalizedUserId } },
        data: { lastSyncedAt: nowDate }
      })
      .catch(() => null);
  }

  return makeDeliveryState(localizeInboxItemForLocale(item, preferredLocale), delivery || null);
}

async function updateInboxStateForUser(userId, itemId, payload = {}) {
  const normalizedUserId = `${userId || ''}`.trim();
  const normalizedItemId = `${itemId || ''}`.trim();
  if (!normalizedUserId || !normalizedItemId) {
    throw new AppError(400, 'Invalid inbox target');
  }

  const item = await prisma.inboxItem.findFirst({
    where: {
      id: normalizedItemId,
      status: 'PUBLISHED',
      OR: [{ scope: 'GLOBAL' }, { targetUsers: { some: { userId: normalizedUserId } } }]
    }
  });
  if (!item) throw new AppError(404, 'Inbox item not found');

  const state = normalizeState(payload.state);
  const progress =
    payload.progress && typeof payload.progress === 'object' && !Array.isArray(payload.progress)
      ? payload.progress
      : {};
  const now = new Date();
  const data = {
    state,
    progressJson: JSON.stringify(progress),
    lastSyncedAt: now
  };
  if (state !== 'UNREAD') {
    data.pushState = 'SUPPRESSED';
    data.nextPushRetryAt = null;
  }
  if (state === 'SEEN') data.seenAt = now;
  if (state === 'SKIPPED') data.skippedAt = now;
  if (state === 'COMPLETED') data.completedAt = now;
  if (state === 'DISMISSED') data.dismissedAt = now;

  const delivery = await prisma.userInboxDelivery.upsert({
    where: {
      itemId_userId: {
        itemId: normalizedItemId,
        userId: normalizedUserId
      }
    },
    update: data,
    create: {
      itemId: normalizedItemId,
      userId: normalizedUserId,
      deliveredAt: now,
      pushState: state === 'UNREAD' ? 'PENDING' : 'SUPPRESSED',
      pushAttempts: 0,
      nextPushRetryAt: state === 'UNREAD' ? now : null,
      ...data
    }
  });

  const io = getIo();
  if (io) {
    io.to(userRoom(normalizedUserId)).emit('inbox:refresh', {
      scope: 'user',
      userId: normalizedUserId,
      itemId: normalizedItemId,
      updatedAt: new Date().toISOString()
    });
  }

  return makeDeliveryState(item, delivery);
}

async function listInboxItemsForAdmin(options = {}) {
  const limit = normalizeLimit(options.limit, 100, 1, 300);
  const where = {};
  if (options.status) {
    where.status = normalizePublishStatus(options.status);
  }
  const types = normalizeTypesFilter(options.types || options.type);
  if (types.length) {
    where.type = { in: types };
  }

  return prisma.inboxItem.findMany({
    where,
    include: {
      _count: {
        select: {
          targetUsers: true,
          deliveries: true
        }
      }
    },
    orderBy: [{ createdAt: 'desc' }],
    take: limit
  });
}

async function getInboxItemForAdmin(itemId) {
  const normalizedItemId = `${itemId || ''}`.trim();
  if (!normalizedItemId) throw new AppError(400, 'Invalid inbox item id');

  const item = await prisma.inboxItem.findUnique({
    where: { id: normalizedItemId },
    include: {
      targetUsers: {
        select: { userId: true }
      },
      _count: {
        select: {
          targetUsers: true,
          deliveries: true
        }
      }
    }
  });
  if (!item) throw new AppError(404, 'Inbox item not found');
  return item;
}

async function updateInboxItemByAdmin(itemId, payload = {}) {
  const normalizedItemId = `${itemId || ''}`.trim();
  if (!normalizedItemId) throw new AppError(400, 'Invalid inbox item id');

  const existing = await prisma.inboxItem.findUnique({
    where: { id: normalizedItemId },
    include: {
      targetUsers: { select: { userId: true } }
    }
  });
  if (!existing) throw new AppError(404, 'Inbox item not found');

  const nextTitle = `${payload.title || ''}`.trim().slice(0, 180);
  const nextMessage = `${payload.message || ''}`.trim().slice(0, 2000);
  if (!nextTitle) throw new AppError(400, 'Title is required');
  if (!nextMessage) throw new AppError(400, 'Message is required');

  const nextPayload =
    payload.payload && typeof payload.payload === 'object' && !Array.isArray(payload.payload)
      ? payload.payload
      : {};
  const templateKey = `${payload.templateKey || ''}`.trim().slice(0, 120) || null;
  const scheduledAt = payload.scheduledAt ? normalizeDate(payload.scheduledAt) : null;
  const expiresAt = payload.expiresAt ? normalizeDate(payload.expiresAt) : null;

  const updated = await prisma.inboxItem.update({
    where: { id: normalizedItemId },
    data: {
      title: nextTitle,
      message: nextMessage,
      payloadJson: JSON.stringify(nextPayload),
      templateKey,
      scheduledAt,
      expiresAt
    },
    include: {
      targetUsers: { select: { userId: true } },
      _count: {
        select: {
          targetUsers: true,
          deliveries: true
        }
      }
    }
  });

  if (`${updated.status || ''}`.toUpperCase() === 'PUBLISHED') {
    if (updated.scope === 'GLOBAL') {
      emitInboxRefreshGlobal(updated.id);
    } else {
      const targetUserIds = updated.targetUsers.map((row) => row.userId);
      emitInboxItemToUsers(updated, targetUserIds);
    }
  }

  return updated;
}

async function publishInboxItemNow(itemId) {
  const item = await prisma.inboxItem.findUnique({
    where: { id: `${itemId || ''}`.trim() }
  });
  if (!item) throw new AppError(404, 'Inbox item not found');
  if (item.status === 'PUBLISHED') return item;
  if (item.status === 'CANCELED') throw new AppError(409, 'Canceled item cannot be published');
  return publishItemById(item.id);
}

async function cancelInboxItem(itemId) {
  const item = await prisma.inboxItem.findUnique({
    where: { id: `${itemId || ''}`.trim() }
  });
  if (!item) throw new AppError(404, 'Inbox item not found');
  return prisma.inboxItem.update({
    where: { id: item.id },
    data: { status: 'CANCELED' }
  });
}

async function publishDueInboxItems({ limit = 200 } = {}) {
  const now = new Date();
  const dueItems = await prisma.inboxItem.findMany({
    where: {
      status: 'SCHEDULED',
      scheduledAt: { lte: now }
    },
    include: {
      targetUsers: { select: { userId: true } }
    },
    orderBy: { scheduledAt: 'asc' },
    take: normalizeLimit(limit, 200, 1, 500)
  });

  let published = 0;
  for (const item of dueItems) {
    const updated = await prisma.inboxItem.update({
      where: { id: item.id },
      data: {
        status: 'PUBLISHED',
        publishedAt: now
      }
    });
    published += 1;
    if (updated.scope === 'GLOBAL') {
      const globalUserIds = await getActiveUserIds();
      if (globalUserIds.length) {
        await createUserInboxDeliveriesWithoutDuplicates(updated.id, globalUserIds, now);
      }
      emitInboxRefreshGlobal(updated.id);
    } else {
      const targetIds = item.targetUsers.map((row) => row.userId);
      emitInboxItemToUsers(updated, targetIds);
    }
    await scheduleNextRepeatItemIfNeeded(updated).catch(() => null);
  }

  return { scanned: dueItems.length, published };
}

module.exports = {
  createInboxItemByAdmin,
  getInboxFeedForUser,
  getInboxItemForUser,
  updateInboxStateForUser,
  listInboxItemsForAdmin,
  getInboxItemForAdmin,
  updateInboxItemByAdmin,
  publishInboxItemNow,
  cancelInboxItem,
  publishDueInboxItems
};
