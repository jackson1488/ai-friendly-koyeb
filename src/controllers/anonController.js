const { z } = require('zod');
const { prisma } = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { logger } = require('../utils/logger');
const { moderateAnonText } = require('../services/anonModerationService');
const { createAutoSoftBan, serializeBan } = require('../services/banService');

/**
 * anonController.js — REST-часть anonymous chat.
 *
 * Realtime-сообщения идут через socket.
 * Этот controller отвечает за:
 * - быструю модерацию текста;
 * - жалобы;
 * - список моих anon-сессий;
 * - историю сообщений;
 * - скрытие/восстановление завершённых anon-сессий.
 */

const moderationSchema = z.object({
  text: z.string().min(1).max(2000)
});

const reportSchema = z.object({
  sessionId: z.string().min(1).max(120),
  messageId: z.string().min(1).max(120).optional(),
  reason: z.string().max(240).optional()
});

const sessionMessagesParamsSchema = z.object({
  sessionId: z.string().min(1).max(120)
});

function safeJsonParse(value, fallback = null) {
  // modLog.detailsJson — строка. Если она битая, не роняем весь endpoint.
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

async function moderateAnonMessage(req, res) {
  const parsed = moderationSchema.safeParse(req.body || {});
  if (!parsed.success) {
    throw new AppError(400, 'Некорректные данные модерации', parsed.error.flatten());
  }

  // Локальная/сервисная проверка текста до отправки в anonymous chat.
  const result = moderateAnonText(parsed.data.text);

  res.json({
    flagged: result.flagged,
    category: result.category,
    reason: result.reason,
    crisisDetected: result.crisisDetected
  });
}

async function reportAnonMessage(req, res) {
  const parsed = reportSchema.safeParse(req.body || {});
  if (!parsed.success) {
    throw new AppError(400, 'Некорректные данные жалобы', parsed.error.flatten());
  }

  const reporterId = req.user.id;
  const sessionId = parsed.data.sessionId;
  const messageId = parsed.data.messageId || null;
  const reason = `${parsed.data.reason || 'manual_report'}`.trim().slice(0, 240) || 'manual_report';

  // Проверяем, что жалобщик реально был участником этой anon-сессии.
  const session = await prisma.chatSession.findFirst({
    where: {
      id: sessionId,
      OR: [{ userAId: reporterId }, { userBId: reporterId }]
    },
    select: {
      id: true,
      userAId: true,
      userBId: true
    }
  });

  if (!session) {
    throw new AppError(404, 'Сессия не найдена');
  }

  let targetUserId = session.userAId === reporterId ? session.userBId : session.userAId;
  let reportedMessage = null;

  if (messageId) {
    // Если жалоба на конкретное сообщение, проверяем, что сообщение существует
    // внутри этой же сессии и было отправлено пользователем, а не системой.
    reportedMessage = await prisma.chatSessionMessage.findFirst({
      where: { id: messageId, sessionId: session.id },
      select: {
        id: true,
        senderId: true,
        senderType: true,
        text: true,
        sentAt: true
      }
    });

    if (!reportedMessage) {
      throw new AppError(404, 'Сообщение не найдено');
    }

    if (!reportedMessage.senderId || `${reportedMessage.senderType || ''}`.toUpperCase() !== 'USER') {
      throw new AppError(400, 'Жалобу можно подать только на сообщение пользователя');
    }

    targetUserId = reportedMessage.senderId;
  }

  if (!targetUserId || targetUserId === reporterId) {
    throw new AppError(400, 'Нельзя пожаловаться на самого себя');
  }

  const [reporterUser, targetUser] = await Promise.all([
    prisma.user.findUnique({
      where: { id: reporterId },
      select: { id: true, username: true, displayName: true }
    }),
    prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, username: true, displayName: true }
    })
  ]);

  if (!targetUser) {
    throw new AppError(404, 'Пользователь для жалобы не найден');
  }

  // Антиспам: не даём одному пользователю отправлять одинаковую жалобу
  // на ту же ситуацию в течение 24 часов.
  const recentSince = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentReports = await prisma.modLog.findMany({
    where: {
      type: 'USER_REPORT',
      sessionId: session.id,
      userId: targetUserId,
      createdAt: {
        gte: recentSince
      }
    },
    orderBy: [{ createdAt: 'desc' }],
    select: { id: true, detailsJson: true, createdAt: true }
  });

  const hasDuplicateFromReporter = recentReports.some((item) => {
    const details = safeJsonParse(item.detailsJson, {});
    if (!details || details.reporterId !== reporterId) return false;
    if (messageId) return details.messageId === messageId;
    return !details.messageId;
  });

  if (hasDuplicateFromReporter) {
    throw new AppError(409, 'Вы уже отправили жалобу по этой ситуации');
  }

  const reportDetails = {
    reporterId,
    reporterUsername: reporterUser?.username || null,
    reporterDisplayName: reporterUser?.displayName || null,
    targetUserId,
    targetUsername: targetUser.username,
    targetDisplayName: targetUser.displayName,
    messageId,
    reportedText: reportedMessage?.text ? `${reportedMessage.text}`.slice(0, 500) : null,
    reason
  };

  const report = await prisma.modLog.create({
    data: {
      type: 'USER_REPORT',
      userId: targetUserId,
      sessionId: session.id,
      triggerWord: reason.slice(0, 120),
      autoAction: 'user_report',
      detailsJson: JSON.stringify(reportDetails)
    }
  });

  // Если за 24 часа набралось 3 уникальных жалобщика, выдаём мягкий автобан.
  const reporterIds = new Set([reporterId]);
  for (const item of recentReports) {
    const details = safeJsonParse(item.detailsJson, {});
    if (details?.reporterId) reporterIds.add(details.reporterId);
  }

  let autoBan = null;
  if (reporterIds.size >= 3) {
    autoBan = await createAutoSoftBan(
      targetUserId,
      'Множественные жалобы в анонимном чате',
      24
    );
  }

  logger.warn('Анонимный чат: жалоба пользователя', {
    reportId: report.id,
    reporterId,
    targetUserId,
    sessionId: session.id,
    messageId,
    reason,
    uniqueReporters24h: reporterIds.size,
    autoBan: Boolean(autoBan)
  });

  res.status(201).json({
    ok: true,
    reportId: report.id,
    targetUserId,
    uniqueReporters24h: reporterIds.size,
    ban: serializeBan(autoBan)
  });
}

async function getMyAnonSessions(req, res) {
  const userId = req.user.id;

  const sessions = await prisma.chatSession.findMany({
    where: {
      status: {
        in: ['ACTIVE', 'ENDED']
      },
      OR: [{ userAId: userId }, { userBId: userId }],
      hiddenForUsers: {
        none: {
          userId
        }
      }
    },
    orderBy: [{ status: 'asc' }, { startedAt: 'desc' }],
    include: {
      _count: {
        select: { messages: true }
      }
    },
    take: 80
  });

  res.json(
    sessions.map((item, index) => ({
      sessionId: item.id,
      status: item.status,
      mode: item.mode,
      room: item.room,
      yourRole: resolveUserRoleFromMode(item.mode, item.userAId === userId),
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      messageCount: item._count?.messages || 0,
      peerLabel: `Аноним ${index + 1}`
    }))
  );
}

function resolveUserRoleFromMode(mode, isUserA) {
  // mode выглядит как "talk_listen" или похожая пара ролей.
  // userA получает первую роль, userB — вторую.
  const parts = `${mode || ''}`.toLowerCase().split('_');
  const first = parts[0] === 'listen' ? 'listen' : 'talk';
  const second = parts[1] === 'listen' ? 'listen' : 'talk';
  return isUserA ? first : second;
}

function mapSessionMessageToClient(item, userId) {
  // Приводим Prisma message к простому формату для клиента:
  // me / partner / system.
  const senderType = `${item?.senderType || ''}`.toUpperCase();
  const isMine = Boolean(item?.senderId) && item.senderId === userId;
  const isSystem = senderType === 'ADMIN' || senderType === 'SYSTEM' || !item?.senderId;

  if (isSystem) {
    return {
      id: item.id,
      kind: 'system',
      from: 'system',
      alias: item.alias || 'Система',
      text: item.text,
      createdAt: item.sentAt
    };
  }

  return {
    id: item.id,
    from: isMine ? 'me' : 'partner',
    alias: item.alias || 'Аноним',
    text: item.text,
    createdAt: item.sentAt
  };
}

async function getAnonSessionMessages(req, res) {
  const parsed = sessionMessagesParamsSchema.safeParse(req.params || {});
  if (!parsed.success) {
    throw new AppError(400, 'Некорректный идентификатор сессии', parsed.error.flatten());
  }

  const userId = req.user.id;
  const { sessionId } = parsed.data;

  const session = await prisma.chatSession.findFirst({
    where: {
      id: sessionId,
      OR: [{ userAId: userId }, { userBId: userId }]
    },
    select: {
      id: true,
      status: true,
      mode: true,
      room: true,
      userAId: true,
      userBId: true,
      startedAt: true,
      endedAt: true
    }
  });

  if (!session) {
    throw new AppError(404, 'Сессия не найдена');
  }

  const messages = await prisma.chatSessionMessage.findMany({
    where: { sessionId: session.id },
    orderBy: [{ sentAt: 'asc' }],
    take: 500
  });

  const isUserA = session.userAId === userId;
  const yourRole = resolveUserRoleFromMode(session.mode, isUserA);

  res.json({
    sessionId: session.id,
    status: session.status,
    room: session.room,
    yourRole,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    messages: messages.map((item) => mapSessionMessageToClient(item, userId))
  });
}

async function hideAnonSession(req, res) {
  const parsed = sessionMessagesParamsSchema.safeParse(req.params || {});
  if (!parsed.success) {
    throw new AppError(400, 'Некорректный идентификатор сессии', parsed.error.flatten());
  }

  const userId = req.user.id;
  const { sessionId } = parsed.data;

  const session = await prisma.chatSession.findFirst({
    where: {
      id: sessionId,
      OR: [{ userAId: userId }, { userBId: userId }]
    },
    select: {
      id: true,
      status: true
    }
  });

  if (!session) {
    throw new AppError(404, 'Сессия не найдена');
  }

  if (`${session.status}`.toUpperCase() !== 'ENDED') {
    throw new AppError(409, 'Можно убрать только завершенный чат');
  }

  // Скрытие персональное: сессия не удаляется для другого участника.
  await prisma.userHiddenChatSession.upsert({
    where: {
      userId_sessionId: {
        userId,
        sessionId: session.id
      }
    },
    update: {
      hiddenAt: new Date()
    },
    create: {
      userId,
      sessionId: session.id
    }
  });

  res.json({ ok: true });
}

async function restoreAnonSession(req, res) {
  const parsed = sessionMessagesParamsSchema.safeParse(req.params || {});
  if (!parsed.success) {
    throw new AppError(400, 'Некорректный идентификатор сессии', parsed.error.flatten());
  }

  const userId = req.user.id;
  const { sessionId } = parsed.data;

  const session = await prisma.chatSession.findFirst({
    where: {
      id: sessionId,
      OR: [{ userAId: userId }, { userBId: userId }]
    },
    select: { id: true }
  });
  if (!session) {
    throw new AppError(404, 'Сессия не найдена');
  }

  await prisma.userHiddenChatSession.deleteMany({
    where: {
      userId,
      sessionId: session.id
    }
  });

  res.json({ ok: true });
}

module.exports = {
  moderateAnonMessage,
  reportAnonMessage,
  getMyAnonSessions,
  getAnonSessionMessages,
  hideAnonSession,
  restoreAnonSession
};
