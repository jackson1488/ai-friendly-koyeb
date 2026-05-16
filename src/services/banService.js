const { prisma } = require('../config/prisma');
const { logger } = require('../utils/logger');

const BAN_SCOPE = {
  ANON: 'ANON',
  GLOBAL: 'GLOBAL'
};

function normalizeScope(scope) {
  const normalized = `${scope || ''}`.trim().toUpperCase();
  if (normalized === BAN_SCOPE.GLOBAL) return BAN_SCOPE.GLOBAL;
  return BAN_SCOPE.ANON;
}

function getBanDelegate() {
  if (!prisma.ban) {
    logger.warn('Модель Ban недоступна в Prisma Client. Выполни prisma generate и перезапусти сервер.');
    return null;
  }
  return prisma.ban;
}

function getAppealDelegate() {
  if (!prisma.appeal) {
    logger.warn('Модель Appeal недоступна в Prisma Client. Выполни prisma generate и перезапусти сервер.');
    return null;
  }
  return prisma.appeal;
}

function serializeBan(ban) {
  if (!ban) return null;
  return {
    id: ban.id,
    scope: normalizeScope(ban.scope),
    level: ban.level,
    reason: ban.reason,
    isActive: ban.isActive,
    createdAt: ban.createdAt,
    expiresAt: ban.expiresAt
  };
}

async function markBanInactive(banId) {
  if (!banId) return;

  const banDelegate = getBanDelegate();
  if (!banDelegate) return;

  await banDelegate.update({
    where: { id: banId },
    data: { isActive: false }
  });
}

function isBanExpired(ban) {
  if (!ban) return false;
  if (`${ban.level || ''}`.toUpperCase() === 'PERMANENT') return false;
  if (!ban.expiresAt) return false;
  return new Date(ban.expiresAt).getTime() <= Date.now();
}

async function getActiveBanForUser(userId, scope = BAN_SCOPE.ANON) {
  if (!userId) return null;

  const banDelegate = getBanDelegate();
  if (!banDelegate) return null;
  const normalizedScope = normalizeScope(scope);

  const ban = await banDelegate.findFirst({
    where: {
      userId,
      scope: normalizedScope,
      isActive: true
    },
    orderBy: [{ createdAt: 'desc' }]
  });

  if (!ban) return null;

  if (isBanExpired(ban)) {
    await markBanInactive(ban.id);
    return null;
  }

  return ban;
}

async function hasGlobalBanHistory(userId) {
  if (!userId) return false;
  const banDelegate = getBanDelegate();
  if (!banDelegate) return false;
  const count = await banDelegate.count({
    where: {
      userId,
      scope: BAN_SCOPE.GLOBAL
    }
  });
  return count > 0;
}

async function syncGlobalBlockState(user) {
  if (!user?.id) {
    return { user, activeGlobalBan: null, isGloballyBlocked: false };
  }

  let nextUser = user;
  const activeGlobalBan = await getActiveBanForUser(user.id, BAN_SCOPE.GLOBAL);

  if (activeGlobalBan && !nextUser.isBlocked) {
    await prisma.user.update({
      where: { id: user.id },
      data: { isBlocked: true }
    });
    nextUser = {
      ...nextUser,
      isBlocked: true
    };
  }

  if (!activeGlobalBan && nextUser.isBlocked) {
    const hasHistory = await hasGlobalBanHistory(user.id);
    if (hasHistory) {
      await prisma.user.update({
        where: { id: user.id },
        data: { isBlocked: false }
      });
      nextUser = {
        ...nextUser,
        isBlocked: false
      };
    }
  }

  return {
    user: nextUser,
    activeGlobalBan,
    isGloballyBlocked: Boolean(activeGlobalBan || nextUser?.isBlocked)
  };
}

async function getActiveGlobalBanForUser(userId) {
  return getActiveBanForUser(userId, BAN_SCOPE.GLOBAL);
}

async function createAutoSoftBan(userId, reason, hours = 24) {
  const banDelegate = getBanDelegate();
  if (!banDelegate) return null;

  const active = await getActiveBanForUser(userId, BAN_SCOPE.ANON);
  if (active) return active;

  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  return banDelegate.create({
    data: {
      userId,
      scope: BAN_SCOPE.ANON,
      level: 'SOFT',
      reason: `${reason || 'Нарушение правил анонимного чата'}`.trim().slice(0, 240),
      expiresAt,
      isActive: true
    }
  });
}

async function getBanWithAppealForUser(userId, scope = BAN_SCOPE.ANON) {
  const normalizedScope = normalizeScope(scope);
  const activeBan = await getActiveBanForUser(userId, normalizedScope);
  if (!activeBan) {
    return { ban: null, appeal: null };
  }

  if (normalizedScope !== BAN_SCOPE.ANON) {
    return { ban: activeBan, appeal: null };
  }

  const appealDelegate = getAppealDelegate();
  if (!appealDelegate) {
    return { ban: activeBan, appeal: null };
  }

  const appeal = await appealDelegate.findFirst({
    where: { banId: activeBan.id },
    orderBy: { createdAt: 'desc' }
  });

  return { ban: activeBan, appeal };
}

module.exports = {
  BAN_SCOPE,
  serializeBan,
  normalizeScope,
  getActiveBanForUser,
  getActiveGlobalBanForUser,
  syncGlobalBlockState,
  createAutoSoftBan,
  getBanWithAppealForUser
};
