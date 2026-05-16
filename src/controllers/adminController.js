const { z } = require('zod');
const { prisma } = require('../config/prisma');
const { env } = require('../config/env');
const { AppError } = require('../utils/errors');
const { hashPassword } = require('../utils/password');
const { writeAuditLog } = require('../services/auditService');
const { revokeAllUserSessions, revokeSingleUserSession } = require('../services/sessionSecurityService');
const { softDeleteUserAccount } = require('../services/deletionService');

/**
 * adminController.js — JSON API для админских операций.
 *
 * Важно:
 * - route уже проверил requireAuth + requireAdmin;
 * - controller всё равно проверяет target user, чтобы не работать с пустым id;
 * - опасные действия пишутся в audit log;
 * - удаление пользователя здесь soft-delete, а не физическое удаление.
 */

const blockSchema = z.object({ isBlocked: z.boolean() });
const resetPasswordSchema = z.object({ newPassword: z.string().min(8).max(128) });
const patchConfigSchema = z
  .object({
    systemPrompt: z.string().min(1).optional(),
    safetyPrompt: z.string().min(1).optional(),
    openrouterModel: z.string().min(1).optional(),
    openrouterApiKey: z.string().max(500).optional(),
    clearOpenrouterApiKey: z.boolean().optional(),
    featureFlagsJson: z.string().min(2).optional()
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Не переданы поля для обновления' });

function maskSecret(value) {
  // API key нельзя отдавать целиком в админку. Показываем только начало и конец.
  const text = `${value || ''}`.trim();
  if (!text) return '';
  if (text.length <= 10) return '********';
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function normalizeMessageRole(role) {
  // В базе UPPER_CASE, frontend обычно ждёт lowercase.
  if (role === 'USER') return 'user';
  if (role === 'ASSISTANT') return 'assistant';
  return 'system';
}

async function listUsers(req, res) {
  // q — простой поиск по username/displayName.
  const q = (req.query.q || '').toString();
  const users = await prisma.user.findMany({
    where: {
      ...(q
        ? {
            OR: [{ username: { contains: q } }, { displayName: { contains: q } }]
          }
        : {})
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      isBlocked: true,
      isDeleted: true,
      deletedAt: true,
      createdAt: true
    }
  });

  res.json({ users });
}

async function getUserById(req, res) {
  // Карточка пользователя плюс счётчики связанных сущностей.
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    include: {
      _count: {
        select: {
          chats: true,
          moodEntries: true,
          crisisEvents: true
        }
      }
    }
  });

  if (!user) throw new AppError(404, 'Пользователь не найден');
  res.json({ user });
}

async function getUserChats(req, res) {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) throw new AppError(404, 'Пользователь не найден');

  // Админ видит и активные, и удалённые чаты пользователя.
  const chats = await prisma.chat.findMany({
    where: { userId: req.params.id },
    orderBy: [{ isDeleted: 'asc' }, { updatedAt: 'desc' }]
  });

  res.json({ chats });
}

async function getChatMessages(req, res) {
  const chat = await prisma.chat.findUnique({ where: { id: req.params.chatId } });
  if (!chat) throw new AppError(404, 'Чат не найден');

  const messages = await prisma.message.findMany({
    where: { chatId: chat.id },
    orderBy: { createdAt: 'asc' }
  });

  const normalized = messages.map((message) => ({
    ...message,
    role: normalizeMessageRole(message.role)
  }));

  res.json({ chat, messages: normalized });
}

async function setUserBlock(req, res) {
  const data = blockSchema.parse(req.body);
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) throw new AppError(404, 'Пользователь не найден');

  // Защита от случайного самобана админа.
  if (target.id === req.user.id) {
    throw new AppError(400, 'Администратор не может заблокировать себя');
  }

  const user = await prisma.user.update({
    where: { id: target.id },
    data: { isBlocked: data.isBlocked }
  });

  await writeAuditLog({
    adminId: req.user.id,
    action: data.isBlocked ? 'USER_BLOCKED' : 'USER_UNBLOCKED',
    targetUserId: target.id,
    meta: { username: target.username }
  });

  res.json({ user });
}

async function resetUserPassword(req, res) {
  const data = resetPasswordSchema.parse(req.body);
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) throw new AppError(404, 'Пользователь не найден');

  const passwordHash = await hashPassword(data.newPassword);

  // Сброс пароля должен выбить все старые устройства пользователя.
  await prisma.$transaction([
    prisma.user.update({
      where: { id: target.id },
      data: {
        passwordHash,
        sessionVersion: { increment: 1 }
      }
    }),
    prisma.refreshToken.deleteMany({ where: { userId: target.id } })
  ]);

  await writeAuditLog({
    adminId: req.user.id,
    action: 'USER_PASSWORD_RESET',
    targetUserId: target.id,
    meta: { username: target.username }
  });

  res.json({ success: true });
}

async function deleteUser(req, res) {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) throw new AppError(404, 'Пользователь не найден');

  if (target.id === req.user.id) {
    throw new AppError(400, 'Администратор не может удалить себя');
  }

  // Soft-delete: аккаунт отключается, но данные остаются на retention-период.
  const result = await softDeleteUserAccount(target.id, 'deleted_by_admin_api');

  await writeAuditLog({
    adminId: req.user.id,
    action: 'USER_SOFT_DELETED',
    targetUserId: target.id,
    meta: { username: target.username, result }
  });

  res.json({ success: true });
}

async function getConfig(_req, res) {
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  if (!config) throw new AppError(404, 'Конфигурация не найдена');

  // OpenRouter key может быть в базе или в .env. Секрет наружу не отдаём.
  const dbKey = (config.openrouterApiKey || '').trim();
  const envKey = (env.openRouterApiKey || '').trim();
  const hasOpenrouterApiKey = Boolean(dbKey || envKey);

  res.json({
    config: {
      ...config,
      openrouterApiKey: undefined,
      hasOpenrouterApiKey,
      openrouterApiKeySource: dbKey ? 'database' : envKey ? 'env' : 'none',
      openrouterApiKeyMasked: dbKey ? maskSecret(dbKey) : envKey ? 'Ключ используется из .env' : ''
    }
  });
}

async function patchConfig(req, res) {
  const data = patchConfigSchema.parse(req.body);

  if (data.featureFlagsJson) {
    try {
      JSON.parse(data.featureFlagsJson);
    } catch (_error) {
      throw new AppError(400, 'featureFlagsJson должен быть валидным JSON');
    }
  }

  const { clearOpenrouterApiKey, openrouterApiKey, ...rest } = data;
  const updateData = { ...rest };

  if (typeof updateData.openrouterModel === 'string') {
    updateData.openrouterModel = updateData.openrouterModel.trim();
  }

  if (typeof openrouterApiKey === 'string') {
    const nextKey = openrouterApiKey.trim();
    if (nextKey) {
      updateData.openrouterApiKey = nextKey;
    }
  }
  if (clearOpenrouterApiKey === true) {
    updateData.openrouterApiKey = null;
  }

  const config = await prisma.appConfig.update({
    where: { id: 1 },
    data: updateData
  });

  await writeAuditLog({
    adminId: req.user.id,
    action: 'APP_CONFIG_UPDATED',
    meta: { keys: Object.keys(updateData) }
  });

  res.json({ config });
}

async function getAuditLogs(_req, res) {
  const logs = await prisma.adminAuditLog.findMany({
    take: 100,
    orderBy: { createdAt: 'desc' },
    include: {
      admin: { select: { id: true, username: true } },
      targetUser: { select: { id: true, username: true } }
    }
  });
  res.json({ logs });
}

async function getCrisisEvents(_req, res) {
  const events = await prisma.crisisEvent.findMany({
    take: 100,
    orderBy: { createdAt: 'desc' },
    include: {
      user: { select: { id: true, username: true, displayName: true } },
      chat: { select: { id: true, title: true } }
    }
  });
  res.json({ events });
}

async function getUserSessions(req, res) {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) throw new AppError(404, 'Пользователь не найден');

  const sessions = await prisma.refreshToken.findMany({
    where: {
      userId: target.id,
      expiresAt: { gt: new Date() }
    },
    orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      createdAt: true,
      lastSeenAt: true,
      expiresAt: true,
      ipAddress: true,
      userAgent: true,
      platform: true,
      device: true,
      appName: true
    }
  });

  res.json({ sessions });
}

async function getUserLoginEvents(req, res) {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) throw new AppError(404, 'Пользователь не найден');

  // limit защищаем от слишком большого запроса.
  const takeRaw = Number(req.query.limit);
  const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 500) : 100;

  const events = await prisma.loginEvent.findMany({
    where: { userId: target.id },
    orderBy: { createdAt: 'desc' },
    take
  });

  res.json({ events });
}

async function kickUserSession(req, res) {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) throw new AppError(404, 'Пользователь не найден');

  const sessionId = `${req.params.sessionId || ''}`.trim();
  if (!sessionId) throw new AppError(400, 'Не указан sessionId');

  const result = await revokeSingleUserSession(target.id, sessionId);
  if (!result.deletedSessions) {
    throw new AppError(404, 'Сессия не найдена');
  }

  await writeAuditLog({
    adminId: req.user.id,
    action: 'USER_SESSION_REVOKED',
    targetUserId: target.id,
    meta: {
      username: target.username,
      sessionId,
      disconnectedSockets: result.disconnectedSockets
    }
  });

  res.json({
    success: true,
    result
  });
}

async function kickAllUserSessions(req, res) {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) throw new AppError(404, 'Пользователь не найден');

  const result = await revokeAllUserSessions(target.id);

  await writeAuditLog({
    adminId: req.user.id,
    action: 'USER_ALL_SESSIONS_REVOKED',
    targetUserId: target.id,
    meta: {
      username: target.username,
      revokedSessions: result.deletedSessions,
      disconnectedSockets: result.disconnectedSockets
    }
  });

  res.json({
    success: true,
    result
  });
}

async function getDashboardMetrics() {
  // Используется admin web dashboard для верхних карточек.
  const [usersCount, crisesCount, blockedCount] = await Promise.all([
    prisma.user.count({ where: { isDeleted: false } }),
    prisma.crisisEvent.count(),
    prisma.user.count({ where: { isBlocked: true, isDeleted: false } })
  ]);

  return { usersCount, crisesCount, blockedCount };
}

module.exports = {
  listUsers,
  getUserById,
  getUserChats,
  getChatMessages,
  setUserBlock,
  resetUserPassword,
  deleteUser,
  getConfig,
  patchConfig,
  getAuditLogs,
  getCrisisEvents,
  getUserSessions,
  getUserLoginEvents,
  kickUserSession,
  kickAllUserSessions,
  getDashboardMetrics
};
