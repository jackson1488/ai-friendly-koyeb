const { z } = require('zod');
const { prisma } = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { hashPassword, comparePassword } = require('../utils/password');
const { signAccessToken, signRefreshToken, verifyToken } = require('../utils/jwt');
const { hashToken } = require('../utils/tokens');
const { logger } = require('../utils/logger');
const { getIo } = require('../socket/io');
const { userRoom } = require('../socket/rooms');
const { buildRequestClientInfo } = require('../utils/clientInfo');
const { writeLoginEvent } = require('../services/sessionSecurityService');
const { allocateNextUserId } = require('../services/userIdService');
const { allocatePublicId } = require('../services/publicIdService');
const { serializeBan, syncGlobalBlockState } = require('../services/banService');
const { softDeleteUserAccount } = require('../services/deletionService');

/**
 * authController.js — регистрация, вход, refresh, профиль и удаление аккаунта.
 *
 * Если коротко:
 * - register создаёт user + первую refresh-сессию;
 * - login проверяет пароль и бан;
 * - refresh меняет старый refresh token на новый;
 * - logout удаляет refresh token;
 * - patchMe/patchMyPassword меняют профиль и безопасность;
 * - deleteMe делает soft-delete, а не физическое удаление.
 */

const registerSchema = z.object({
  displayName: z.string().min(2).max(80),
  username: z.string().min(3).max(40).regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(8).max(128),
  termsAccepted: z.literal(true),
  termsVersion: z.string().min(1).max(20),
  age: z.number().int().min(13).max(100).optional(),
  goals: z.array(z.string().max(50)).max(3).optional()
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

const patchMeSchema = z
  .object({
    displayName: z.string().min(2).max(80).optional(),
    username: z.string().min(3).max(40).regex(/^[a-zA-Z0-9_]+$/).optional(),
    theme: z.enum(['dark', 'light', 'aurora']).optional(),
    avatar: z.string().max(500000).optional().nullable(),
    age: z.number().int().min(13).max(100).optional(),
    goals: z.array(z.string().max(50)).max(3).optional()
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Нет полей для обновления'
  });

const patchPasswordSchema = z.object({
  currentPassword: z.string().min(8).max(128),
  newPassword: z.string().min(8).max(128)
});

async function createRefreshToken(userId, clientInfo = {}) {
  // Refresh token хранится у клиента, а в базе хранится только hash.
  // Так при утечке базы нельзя сразу использовать refresh token.
  const { token } = signRefreshToken(userId);
  const decoded = verifyToken(token);
  const session = await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(decoded.exp * 1000),
      ipAddress: clientInfo.ipAddress || null,
      userAgent: clientInfo.userAgent || null,
      platform: clientInfo.platform || null,
      device: clientInfo.device || null,
      appName: clientInfo.appName || null,
      lastSeenAt: new Date()
    }
  });

  // session.id потом попадёт в access token как sid.
  // Это связывает access token с конкретной refresh-сессией.
  return { token, sessionId: session.id };
}

function parseGoals(raw) {
  // В базе goals лежат JSON-строкой. Если строка битая — безопасно отдаём [].
  try {
    return JSON.parse(raw || '[]');
  } catch (_) {
    return [];
  }
}

function toAuthPayload(user, accessToken, refreshToken) {
  // Один стандартный формат ответа для register/login/refresh.
  return {
    user: {
      id: user.id,
      publicId: user.publicId || null,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      theme: user.theme || 'dark',
      age: user.age || null,
      goals: parseGoals(user.goals),
      avatar: user.avatar || null
    },
    accessToken,
    refreshToken
  };
}

async function register(req, res) {
  const data = registerSchema.parse(req.body);
  const clientInfo = buildRequestClientInfo(req);

  if (data.termsAccepted !== true) {
    throw new AppError(400, 'Необходимо принять условия соглашения');
  }

  // Username уникальный. Если аккаунт soft-deleted, не создаём новый поверх него:
  // пользователь должен идти в поддержку для восстановления.
  const existing = await prisma.user.findUnique({ where: { username: data.username } });
  if (existing) {
    if (existing.isDeleted) {
      throw new AppError(409, 'Ваш аккаунт помечен как удаленный. Обратитесь в поддержку для восстановления.');
    }
    throw new AppError(409, 'Логин уже занят');
  }

  const passwordHash = await hashPassword(data.password);
  const newUserId = await allocateNextUserId(prisma);
  const publicId = await allocatePublicId(prisma);
  const user = await prisma.user.create({
    data: {
      id: newUserId,
      publicId,
      username: data.username,
      displayName: data.displayName,
      passwordHash,
      role: 'USER',
      termsAcceptedAt: new Date(),
      termsVersion: data.termsVersion,
      theme: 'dark',
      age: data.age ?? null,
      goals: JSON.stringify(data.goals ?? [])
    }
  });

  const { token: refreshToken, sessionId } = await createRefreshToken(user.id, clientInfo);
  const accessToken = signAccessToken(user, {
    sessionId,
    sessionVersion: user.sessionVersion
  });

  await writeLoginEvent({
    userId: user.id,
    username: user.username,
    sessionId,
    action: 'REGISTER',
    success: true,
    ...clientInfo
  });

  logger.info('Пользователь зарегистрирован', { userId: user.id, username: user.username });

  res.status(201).json(toAuthPayload(user, accessToken, refreshToken));
}

async function login(req, res) {
  const data = loginSchema.parse(req.body);
  const clientInfo = buildRequestClientInfo(req);

  const user = await prisma.user.findUnique({ where: { username: data.username } });
  if (!user) {
    await writeLoginEvent({
      username: data.username,
      action: 'LOGIN',
      success: false,
      reason: 'USER_NOT_FOUND',
      ...clientInfo
    });
    throw new AppError(401, 'Неверный логин или пароль');
  }
  if (user.isDeleted) {
    await writeLoginEvent({
      userId: user.id,
      username: user.username,
      action: 'LOGIN',
      success: false,
      reason: 'ACCOUNT_SOFT_DELETED',
      ...clientInfo
    });
    throw new AppError(423, 'Ваш аккаунт помечен как удаленный. Напишите в поддержку, чтобы восстановить доступ.');
  }

  const isValidPassword = await comparePassword(data.password, user.passwordHash);
  if (!isValidPassword) {
    await writeLoginEvent({
      userId: user.id,
      username: user.username,
      action: 'LOGIN',
      success: false,
      reason: 'INVALID_PASSWORD',
      ...clientInfo
    });
    throw new AppError(401, 'Неверный логин или пароль');
  }

  // Даже если пароль верный, глобальный бан не должен пустить пользователя в приложение.
  const globalAccess = await syncGlobalBlockState(user);
  if (globalAccess.isGloballyBlocked) {
    await writeLoginEvent({
      userId: user.id,
      username: user.username,
      action: 'LOGIN',
      success: false,
      reason: 'GLOBAL_BLOCKED',
      ...clientInfo
    });
    throw new AppError(423, 'Вы заблокированы. Обратитесь в поддержку.', {
      scope: 'GLOBAL',
      timezone: 'Asia/Bishkek',
      ban: serializeBan(globalAccess.activeGlobalBan),
      reason: globalAccess.activeGlobalBan?.reason || 'Нарушение правил'
    });
  }
  const effectiveUser = globalAccess.user || user;

  const { token: refreshToken, sessionId } = await createRefreshToken(effectiveUser.id, clientInfo);
  const accessToken = signAccessToken(effectiveUser, {
    sessionId,
    sessionVersion: effectiveUser.sessionVersion
  });

  await writeLoginEvent({
    userId: effectiveUser.id,
    username: effectiveUser.username,
    sessionId,
    action: 'LOGIN',
    success: true,
    ...clientInfo
  });

  logger.info('Вход пользователя', { userId: effectiveUser.id, username: effectiveUser.username, sessionId });

  res.json(toAuthPayload(effectiveUser, accessToken, refreshToken));
}

async function refresh(req, res) {
  const data = refreshSchema.parse(req.body);
  const clientInfo = buildRequestClientInfo(req);

  let payload;
  try {
    payload = verifyToken(data.refreshToken);
  } catch (_error) {
    throw new AppError(401, 'Недействительный refresh-токен');
  }

  if (payload.type !== 'refresh') {
    throw new AppError(401, 'Неверный тип refresh-токена');
  }

  // Refresh token одноразовый: нашли в базе, удалили, выдали новый.
  // Это защищает от повторного использования украденного refresh token.
  const hashed = hashToken(data.refreshToken);
  const dbToken = await prisma.refreshToken.findUnique({ where: { tokenHash: hashed } });
  if (!dbToken || dbToken.expiresAt < new Date()) {
    throw new AppError(401, 'Refresh-токен просрочен или отозван');
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) {
    throw new AppError(401, 'Пользователь недоступен');
  }
  if (user.isDeleted) {
    throw new AppError(423, 'Ваш аккаунт помечен как удаленный. Напишите в поддержку, чтобы восстановить доступ.');
  }
  const globalAccess = await syncGlobalBlockState(user);
  if (globalAccess.isGloballyBlocked) {
    throw new AppError(423, 'Вы заблокированы. Обратитесь в поддержку.', {
      scope: 'GLOBAL',
      timezone: 'Asia/Bishkek',
      ban: serializeBan(globalAccess.activeGlobalBan),
      reason: globalAccess.activeGlobalBan?.reason || 'Нарушение правил'
    });
  }
  const effectiveUser = globalAccess.user || user;

  const deleted = await prisma.refreshToken.deleteMany({ where: { id: dbToken.id } });
  if (!deleted.count) {
    throw new AppError(401, 'Refresh-токен уже использован или отозван');
  }

  const { token: refreshToken, sessionId } = await createRefreshToken(effectiveUser.id, clientInfo);
  const accessToken = signAccessToken(effectiveUser, {
    sessionId,
    sessionVersion: effectiveUser.sessionVersion
  });

  await writeLoginEvent({
    userId: effectiveUser.id,
    username: effectiveUser.username,
    sessionId,
    action: 'REFRESH',
    success: true,
    ...clientInfo
  });

  res.json(toAuthPayload(effectiveUser, accessToken, refreshToken));
}

async function logout(req, res) {
  const data = refreshSchema.parse(req.body);
  const hashed = hashToken(data.refreshToken);
  const clientInfo = buildRequestClientInfo(req);

  const tokenRecord = await prisma.refreshToken.findUnique({ where: { tokenHash: hashed } });
  await prisma.refreshToken.deleteMany({ where: { tokenHash: hashed } });

  if (tokenRecord) {
    await writeLoginEvent({
      userId: tokenRecord.userId,
      sessionId: tokenRecord.id,
      action: 'LOGOUT',
      success: true,
      ...clientInfo
    });
  }

  // Logout всегда idempotent: даже если token уже удалён, клиент получает success.
  res.json({ success: true });
}

async function getMe(req, res) {
  // req.user поставил requireAuth. Тут просто отдаём безопасный профиль.
  const profile = {
    id: req.user.id,
    publicId: req.user.publicId || null,
    username: req.user.username,
    displayName: req.user.displayName,
    role: req.user.role,
    isBlocked: req.user.isBlocked,
    theme: req.user.theme || 'dark',
    avatar: req.user.avatar || null,
    age: req.user.age || null,
    goals: parseGoals(req.user.goals),
    termsAcceptedAt: req.user.termsAcceptedAt,
    termsVersion: req.user.termsVersion,
    createdAt: req.user.createdAt
  };
  res.json(profile);
}

async function patchMe(req, res) {
  const data = patchMeSchema.parse(req.body);

  if (data.username && data.username !== req.user.username) {
    const conflict = await prisma.user.findUnique({ where: { username: data.username } });
    if (conflict) throw new AppError(409, 'Логин уже занят');
  }

  // Собираем updateData только из реально переданных полей.
  // Так undefined не перетрёт существующие значения.
  const updateData = {};
  if (data.displayName !== undefined) updateData.displayName = data.displayName;
  if (data.username !== undefined) updateData.username = data.username;
  if (data.theme !== undefined) updateData.theme = data.theme;
  if (data.avatar !== undefined) updateData.avatar = data.avatar;
  if (data.age !== undefined) updateData.age = data.age;
  if (data.goals !== undefined) updateData.goals = JSON.stringify(data.goals);

  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: updateData
  });

  const profile = {
    id: user.id,
    publicId: user.publicId || null,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    theme: user.theme || 'dark',
    avatar: user.avatar || null,
    age: user.age || null,
    goals: parseGoals(user.goals)
  };

  try {
    const io = getIo();
    if (io) io.to(userRoom(user.id)).emit('user:profileUpdated', profile);
  } catch (_) {
    // Realtime sync не должен ломать сохранение профиля.
  }

  res.json(profile);
}

async function patchMyPassword(req, res) {
  const data = patchPasswordSchema.parse(req.body);

  const valid = await comparePassword(data.currentPassword, req.user.passwordHash);
  if (!valid) {
    throw new AppError(400, 'Текущий пароль указан неверно');
  }

  const passwordHash = await hashPassword(data.newPassword);

  // При смене пароля:
  // - меняем hash;
  // - увеличиваем sessionVersion, чтобы старые access token стали невалидны;
  // - удаляем refresh tokens, чтобы все устройства вошли заново.
  await prisma.$transaction([
    prisma.user.update({
      where: { id: req.user.id },
      data: {
        passwordHash,
        sessionVersion: { increment: 1 }
      }
    }),
    prisma.refreshToken.deleteMany({ where: { userId: req.user.id } })
  ]);

  res.json({ success: true });
}

async function deleteMe(req, res) {
  // Это soft-delete: аккаунт отключается сейчас, но физическое удаление происходит позже.
  const result = await softDeleteUserAccount(req.user.id, 'deleted_by_user');
  res.json({ success: true, softDeleted: true, ...result });
}

module.exports = {
  register,
  login,
  refresh,
  logout,
  getMe,
  patchMe,
  patchMyPassword,
  deleteMe
};
