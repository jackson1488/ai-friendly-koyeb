const { z } = require('zod');
const { prisma } = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { logger } = require('../utils/logger');

/**
 * cloudPasswordController.js — дополнительный облачный пароль.
 *
 * Важно: сюда приходит уже hash длиной 64 символа, а не сырой пароль.
 * Это значит, что клиент сначала хэширует/готовит пароль, а сервер хранит только hash.
 */

const hashSchema = z.object({
  hash: z.string().length(64)
});

async function getCloudPasswordStatus(req, res) {
  // Клиенту нужно знать только установлен пароль или нет, а не сам hash.
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { cloudPasswordHash: true, cloudPasswordSetAt: true }
  });

  if (!user.cloudPasswordHash) {
    return res.json({ set: false });
  }
  return res.json({ set: true, setAt: user.cloudPasswordSetAt });
}

async function setCloudPassword(req, res) {
  const { hash } = hashSchema.parse(req.body);

  // При установке нового cloud password сбрасываем счётчик попыток и lockout.
  await prisma.user.update({
    where: { id: req.user.id },
    data: {
      cloudPasswordHash: hash,
      cloudPasswordSetAt: new Date(),
      cloudPasswordAttempts: 0,
      cloudPasswordLockedUntil: null
    }
  });

  logger.info('Cloud password set', { userId: req.user.id });
  res.json({ success: true });
}

async function verifyCloudPassword(req, res) {
  const { hash } = hashSchema.parse(req.body);

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      cloudPasswordHash: true,
      cloudPasswordAttempts: true,
      cloudPasswordLockedUntil: true
    }
  });

  if (!user.cloudPasswordHash) {
    return res.status(404).json({ error: 'Облачный пароль не установлен' });
  }

  // Если пользователь уже заблокирован после ошибок, не проверяем пароль до конца lockout.
  if (user.cloudPasswordLockedUntil && user.cloudPasswordLockedUntil > new Date()) {
    return res.json({ valid: false, locked: true, until: user.cloudPasswordLockedUntil });
  }

  if (user.cloudPasswordHash === hash) {
    // Успешный ввод сбрасывает счётчик ошибок.
    await prisma.user.update({
      where: { id: req.user.id },
      data: { cloudPasswordAttempts: 0, cloudPasswordLockedUntil: null }
    });
    return res.json({ valid: true });
  }

  // Неверный пароль: увеличиваем счётчик попыток.
  const newAttempts = (user.cloudPasswordAttempts || 0) + 1;
  const updateData = { cloudPasswordAttempts: newAttempts };

  if (newAttempts >= 5) {
    // После 5 ошибок блокируем проверку на 15 минут.
    updateData.cloudPasswordLockedUntil = new Date(Date.now() + 15 * 60 * 1000);
    await prisma.user.update({ where: { id: req.user.id }, data: updateData });
    return res.json({ valid: false, locked: true, until: updateData.cloudPasswordLockedUntil });
  }

  await prisma.user.update({ where: { id: req.user.id }, data: updateData });
  return res.json({ valid: false, attemptsLeft: 5 - newAttempts });
}

async function deleteCloudPassword(req, res) {
  const { hash } = hashSchema.parse(req.body);

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { cloudPasswordHash: true }
  });

  if (!user.cloudPasswordHash) {
    throw new AppError(404, 'Облачный пароль не установлен');
  }

  if (user.cloudPasswordHash !== hash) {
    throw new AppError(401, 'Неверный пароль');
  }

  await prisma.user.update({
    where: { id: req.user.id },
    data: {
      cloudPasswordHash: null,
      cloudPasswordSetAt: null,
      cloudPasswordAttempts: 0,
      cloudPasswordLockedUntil: null
    }
  });

  logger.info('Cloud password deleted', { userId: req.user.id });
  res.json({ success: true });
}

async function adminResetCloudPassword(req, res) {
  // Админский сброс не требует старый hash пользователя.
  const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body);

  await prisma.user.update({
    where: { id: userId },
    data: {
      cloudPasswordHash: null,
      cloudPasswordSetAt: null,
      cloudPasswordAttempts: 0,
      cloudPasswordLockedUntil: null
    }
  });

  logger.info('Admin reset cloud password', { adminId: req.user.id, targetUserId: userId });
  res.json({ success: true });
}

module.exports = {
  getCloudPasswordStatus,
  setCloudPassword,
  verifyCloudPassword,
  deleteCloudPassword,
  adminResetCloudPassword
};
