const { z } = require('zod');
const { prisma } = require('../config/prisma');
const { AppError } = require('../utils/errors');
const {
  BAN_SCOPE,
  serializeBan,
  getBanWithAppealForUser
} = require('../services/banService');

/**
 * banController.js — пользовательский просмотр бана и апелляции.
 *
 * Здесь речь в основном про ограничения anonymous chat.
 * Админские действия по банам живут отдельно в admin/service слое.
 */

const appealSchema = z.object({
  message: z.string().min(100).max(2000)
});

function ensureAppealModelReady() {
  // Если Prisma Client не обновили после миграции, prisma.appeal может отсутствовать.
  // Лучше вернуть понятную 503 ошибку, чем получить "cannot read create of undefined".
  if (!prisma.appeal) {
    throw new AppError(503, 'Модуль апелляций временно недоступен. Обнови Prisma Client и перезапусти сервер.');
  }
}

async function getMyBan(req, res) {
  // Берём активный бан и связанную appeal, если пользователь уже подавал её.
  const { ban, appeal } = await getBanWithAppealForUser(req.user.id, BAN_SCOPE.ANON);

  res.json({
    timezone: 'Asia/Bishkek',
    now: new Date().toISOString(),
    active: Boolean(ban),
    ban: serializeBan(ban),
    appeal: appeal
      ? {
          id: appeal.id,
          status: appeal.status,
          message: appeal.message,
          adminNote: appeal.adminNote,
          createdAt: appeal.createdAt,
          resolvedAt: appeal.resolvedAt
        }
      : null
  });
}

async function createAppeal(req, res) {
  ensureAppealModelReady();

  const parsed = appealSchema.safeParse(req.body || {});
  if (!parsed.success) {
    throw new AppError(400, 'Некорректные данные апелляции', parsed.error.flatten());
  }

  const { ban, appeal } = await getBanWithAppealForUser(req.user.id, BAN_SCOPE.ANON);
  if (!ban) {
    throw new AppError(400, 'Активный бан не найден');
  }
  if (`${ban.scope || ''}`.toUpperCase() !== BAN_SCOPE.ANON) {
    throw new AppError(400, 'Апелляция доступна только для ограничений анонимного чата');
  }

  // На один бан разрешаем только одну appeal. Иначе пользователь сможет спамить админку.
  if (appeal) {
    if (appeal.status === 'PENDING') {
      throw new AppError(409, 'Апелляция уже на рассмотрении');
    }
    throw new AppError(409, 'На этот бан уже была подана апелляция');
  }

  const created = await prisma.appeal.create({
    data: {
      banId: ban.id,
      userId: req.user.id,
      message: parsed.data.message.trim()
    }
  });

  res.status(201).json({
    ok: true,
    appeal: {
      id: created.id,
      status: created.status,
      message: created.message,
      createdAt: created.createdAt
    }
  });
}

async function getMyAppeals(req, res) {
  ensureAppealModelReady();

  const appeals = await prisma.appeal.findMany({
    where: { userId: req.user.id },
    include: {
      ban: {
        select: {
          id: true,
          scope: true,
          level: true,
          reason: true,
          expiresAt: true,
          createdAt: true
        }
      }
    },
    orderBy: [{ createdAt: 'desc' }]
  });

  res.json({
    appeals: appeals.map((item) => ({
      id: item.id,
      status: item.status,
      message: item.message,
      adminNote: item.adminNote,
      createdAt: item.createdAt,
      resolvedAt: item.resolvedAt,
      ban: item.ban
    }))
  });
}

module.exports = {
  getMyBan,
  createAppeal,
  getMyAppeals
};
