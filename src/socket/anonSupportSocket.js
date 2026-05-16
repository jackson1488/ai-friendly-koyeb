const crypto = require('crypto');
const { z } = require('zod');
const { prisma } = require('../config/prisma');
const { logger } = require('../utils/logger');
const { moderateAnonText } = require('../services/anonModerationService');
const {
  BAN_SCOPE,
  getActiveBanForUser,
  createAutoSoftBan,
  serializeBan,
  syncGlobalBlockState
} = require('../services/banService');
const { resolveSocketUser } = require('../services/socketAuthService');

const TALK_MODE = 'talk';
const LISTEN_MODE = 'listen';
const ADMIN_NAMESPACE = '/admin';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const TALK_TALK_FALLBACK_WAIT_MS = 12 * 1000;
const LISTEN_LISTEN_FALLBACK_WAIT_MS = 12 * 1000;
const MESSAGE_RATE_LIMIT_PER_MINUTE = 30;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MUTE_SECONDS = 300;
const LAST_PARTNER_COOLDOWN_MS = (() => {
  const raw = process.env.ANON_LAST_PARTNER_COOLDOWN_MS;
  if (typeof raw !== 'string') return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed);
})();
const ANON_ALLOW_SELF_MATCH =
  typeof process.env.ANON_ALLOW_SELF_MATCH === 'string'
    ? process.env.ANON_ALLOW_SELF_MATCH === 'true'
    : true;

const queueSchema = z.object({
  mode: z.enum([TALK_MODE, LISTEN_MODE]),
  topic: z.string().min(1).max(64).optional()
});

const messageSchema = z.object({
  text: z.string().min(1).max(2000)
});

const typingSchema = z.object({
  isTyping: z.boolean().optional()
});

const waiting = {
  [TALK_MODE]: [],
  [LISTEN_MODE]: []
};

const activeSessions = new Map();
const userToSession = new Map();
const lastPartnerByUser = new Map();
const userRateBuckets = new Map();
const moderationHitsByUser = new Map();
const aliasByUserId = new Map();
let aliasCounter = 0;

let cleanupTimer = null;

function normalizeTopic(topic) {
  const value = `${topic || ''}`.trim();
  return value ? value.slice(0, 64) : 'all';
}

function safeAck(ack, payload) {
  if (typeof ack !== 'function') return;
  try {
    ack(payload);
  } catch (_error) {
    // Игнорируем ошибки callback на клиенте.
  }
}

function makeAlias(userId) {
  if (!userId) {
    aliasCounter += 1;
    return `Аноним ${aliasCounter}`;
  }

  const existing = aliasByUserId.get(userId);
  if (existing) return existing;

  aliasCounter += 1;
  const value = `Аноним ${aliasCounter}`;
  aliasByUserId.set(userId, value);
  return value;
}

function isLastPartnerPair(userAId, userBId) {
  const now = Date.now();
  const stateA = lastPartnerByUser.get(userAId);
  const stateB = lastPartnerByUser.get(userBId);

  if (!stateA || !stateB) return false;

  const aMatch =
    typeof stateA === 'object'
      ? stateA.partnerId === userBId && now - Number(stateA.at || 0) < LAST_PARTNER_COOLDOWN_MS
      : stateA === userBId;
  const bMatch =
    typeof stateB === 'object'
      ? stateB.partnerId === userAId && now - Number(stateB.at || 0) < LAST_PARTNER_COOLDOWN_MS
      : stateB === userAId;

  return aMatch || bMatch;
}

function canMatch(entryA, entryB) {
  if (!entryA || !entryB) return false;
  if (entryA.socketId === entryB.socketId) return false;
  if (entryA.userId === entryB.userId) {
    return ANON_ALLOW_SELF_MATCH;
  }
  if (isLastPartnerPair(entryA.userId, entryB.userId)) return false;
  return true;
}

function removeFromQueueByUser(userId) {
  waiting[TALK_MODE] = waiting[TALK_MODE].filter((item) => item.userId !== userId);
  waiting[LISTEN_MODE] = waiting[LISTEN_MODE].filter((item) => item.userId !== userId);
}

function removeFromQueueBySocket(socketId) {
  waiting[TALK_MODE] = waiting[TALK_MODE].filter((item) => item.socketId !== socketId);
  waiting[LISTEN_MODE] = waiting[LISTEN_MODE].filter((item) => item.socketId !== socketId);
}

function upsertQueueEntry(entry) {
  if (ANON_ALLOW_SELF_MATCH) {
    removeFromQueueBySocket(entry.socketId);
  } else {
    removeFromQueueByUser(entry.userId);
  }
  waiting[entry.mode].push(entry);
  waiting[entry.mode].sort((a, b) => a.joinedAt - b.joinedAt);
}

function getSessionIndicator(session) {
  if (session.flags?.hasCrisis) return 'crisis';
  if (session.flags?.hasSuspicious) return 'warning';
  return 'normal';
}

function emitAdminEvent(io, event, payload) {
  if (!io?.of) return;
  io.of(ADMIN_NAMESPACE).emit(event, payload);
}

async function persistSessionCreated(session) {
  try {
    await prisma.chatSession.upsert({
      where: { id: session.id },
      update: {
        status: 'ACTIVE',
        endedAt: null,
        endedBy: null,
        mode: session.mode,
        room: session.room,
        userAId: session.users[0].userId,
        userBId: session.users[1].userId
      },
      create: {
        id: session.id,
        userAId: session.users[0].userId,
        userBId: session.users[1].userId,
        mode: session.mode,
        room: session.room,
        status: 'ACTIVE',
        startedAt: new Date(session.createdAt)
      }
    });
  } catch (error) {
    logger.error('Anon-чат: ошибка сохранения сессии', {
      sessionId: session.id,
      error: error.message
    });
  }
}

async function persistSessionEnded(sessionId, endedBy) {
  try {
    await prisma.chatSession.update({
      where: { id: sessionId },
      data: {
        status: 'ENDED',
        endedAt: new Date(),
        endedBy
      }
    });
  } catch (error) {
    logger.warn('Anon-чат: не удалось обновить статус сессии', {
      sessionId,
      endedBy,
      error: error.message
    });
  }
}

async function persistSessionMessage({
  id,
  sessionId,
  senderId,
  senderType,
  alias,
  text,
  flagged = false,
  flagReason = null,
  meta = null
}) {
  try {
    await prisma.chatSessionMessage.create({
      data: {
        id,
        sessionId,
        senderId: senderId || null,
        senderType,
        alias: alias || null,
        text,
        flagged,
        flagReason,
        metaJson: meta ? JSON.stringify(meta) : null,
        sentAt: new Date()
      }
    });
  } catch (error) {
    logger.warn('Anon-чат: не удалось сохранить сообщение сессии', {
      sessionId,
      messageId: id,
      error: error.message
    });
  }
}

async function writeModLog({ type, userId = null, sessionId = null, triggerWord = null, autoAction = null, details = null }) {
  try {
    await prisma.modLog.create({
      data: {
        type,
        userId,
        sessionId,
        triggerWord,
        autoAction,
        detailsJson: details ? JSON.stringify(details) : null
      }
    });
  } catch (error) {
    logger.warn('Модерация: не удалось сохранить mod_log', {
      type,
      sessionId,
      userId,
      error: error.message
    });
  }
}

async function writeModAction({ adminId, targetUserId = null, sessionId = null, action, reason = null, metadata = null }) {
  if (!adminId) return;
  try {
    await prisma.modAction.create({
      data: {
        adminId,
        targetUserId,
        sessionId,
        action,
        reason,
        metadataJson: metadata ? JSON.stringify(metadata) : null
      }
    });
  } catch (error) {
    logger.warn('Модерация: не удалось сохранить mod_action', {
      adminId,
      targetUserId,
      sessionId,
      action,
      error: error.message
    });
  }
}

function createSession(entryA, entryB, now) {
  const sessionId = crypto.randomUUID();

  const first = {
    userId: entryA.userId,
    socketId: entryA.socketId,
    role: entryA.mode,
    alias: makeAlias(entryA.userId),
    topic: entryA.topic
  };

  const second = {
    userId: entryB.userId,
    socketId: entryB.socketId,
    role: entryB.mode,
    alias: makeAlias(entryB.userId),
    topic: entryB.topic
  };

  const room = first.topic || second.topic || 'all';
  const mode = `${first.role}_${second.role}`;

  const session = {
    id: sessionId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    room,
    mode,
    users: [first, second],
    flags: {
      hasSuspicious: false,
      hasCrisis: false,
      lastTriggerAt: null
    },
    mutedUntilByUserId: new Map(),
    messages: new Map(),
    messageCount: 0
  };

  activeSessions.set(sessionId, session);
  userToSession.set(first.userId, sessionId);
  userToSession.set(second.userId, sessionId);
  lastPartnerByUser.set(first.userId, { partnerId: second.userId, at: now });
  lastPartnerByUser.set(second.userId, { partnerId: first.userId, at: now });

  removeFromQueueByUser(first.userId);
  removeFromQueueByUser(second.userId);

  persistSessionCreated(session).catch(() => undefined);

  return session;
}

function findTalkListenMatch(now) {
  const talks = waiting[TALK_MODE];
  const listeners = waiting[LISTEN_MODE];
  if (!talks.length || !listeners.length) return null;

  for (let talkIndex = 0; talkIndex < talks.length; talkIndex += 1) {
    const talkEntry = talks[talkIndex];

    for (let listenerIndex = 0; listenerIndex < listeners.length; listenerIndex += 1) {
      const listenerEntry = listeners[listenerIndex];
      if (!canMatch(talkEntry, listenerEntry)) continue;
      return createSession(talkEntry, listenerEntry, now);
    }
  }

  return null;
}

function findTalkTalkMatch(now) {
  return findSameModeMatch(TALK_MODE, TALK_TALK_FALLBACK_WAIT_MS, now);
}

function findListenListenMatch(now) {
  return findSameModeMatch(LISTEN_MODE, LISTEN_LISTEN_FALLBACK_WAIT_MS, now);
}

function findSameModeMatch(mode, minWaitMs, now) {
  const list = waiting[mode];
  if (list.length < 2) return null;

  const oldest = list[0];
  if (!oldest || now - oldest.joinedAt < minWaitMs) {
    return null;
  }

  for (let index = 1; index < list.length; index += 1) {
    const candidate = list[index];
    if (!canMatch(oldest, candidate)) continue;
    return createSession(oldest, candidate, now);
  }

  return null;
}

function pruneWaitingQueue(io) {
  if (!io?.sockets?.sockets) return;
  const isAliveSocketId = (socketId) => io.sockets.sockets.has(socketId);
  waiting[TALK_MODE] = waiting[TALK_MODE].filter((entry) => isAliveSocketId(entry.socketId));
  waiting[LISTEN_MODE] = waiting[LISTEN_MODE].filter((entry) => isAliveSocketId(entry.socketId));
}

function tryMatchFromQueue(io) {
  pruneWaitingQueue(io);
  const now = Date.now();
  return findTalkListenMatch(now) || findTalkTalkMatch(now) || findListenListenMatch(now);
}

function getSessionByUser(userId) {
  const sessionId = userToSession.get(userId);
  if (!sessionId) return null;
  return activeSessions.get(sessionId) || null;
}

function getParticipant(session, userId, socketId = null) {
  if (!session?.users?.length) return null;
  if (socketId) {
    const exactBySocket = session.users.find((item) => item.socketId === socketId);
    if (exactBySocket) return exactBySocket;
  }

  if (socketId) {
    const reconnectSlot = session.users.find((item) => item.userId === userId && !item.socketId);
    if (reconnectSlot) return reconnectSlot;
  }

  return session.users.find((item) => item.userId === userId) || null;
}

function getPartner(session, userId, socketId = null) {
  if (!session?.users?.length) return null;
  if (socketId) {
    const bySocket = session.users.find((item) => item.socketId !== socketId);
    if (bySocket) return bySocket;
  }

  return session.users.find((item) => item.userId !== userId) || null;
}

function clearSessionIndexes(session) {
  if (!session) return;
  activeSessions.delete(session.id);
  for (const user of session.users) {
    userToSession.delete(user.userId);
  }
}

function getEndedByFromReason(reason) {
  if (reason === 'expired') return 'TIMEOUT';
  if (reason === 'banned') return 'BANNED';
  if (reason === 'admin') return 'ADMIN';
  if (reason === 'disconnect') return 'DISCONNECT';
  return 'USER';
}

function emitSessionEnded(io, session, reason, actorUserId = null) {
  emitAdminEvent(io, 'session:ended', {
    sessionId: session.id,
    reason,
    endedBy: getEndedByFromReason(reason),
    actorUserId,
    endedAt: new Date().toISOString(),
    indicator: getSessionIndicator(session)
  });
}

function endSessionForUser(io, userId, reason = 'left', socketId = null) {
  const session = getSessionByUser(userId);
  if (!session) return null;

  const current = getParticipant(session, userId, socketId);
  const partner = getPartner(session, userId, socketId);

  clearSessionIndexes(session);
  persistSessionEnded(session.id, getEndedByFromReason(reason)).catch(() => undefined);

  if (partner?.socketId) {
    io.to(partner.socketId).emit('anon:partner_left', {
      sessionId: session.id,
      reason
    });
  }

  if (current?.socketId) {
    io.to(current.socketId).emit('anon:left', {
      sessionId: session.id,
      reason
    });
  }

  emitSessionEnded(io, session, reason, userId);

  return session;
}

function detachSocketFromSession(io, userId, socketId) {
  const session = getSessionByUser(userId);
  if (!session) return null;

  const current = getParticipant(session, userId, socketId);
  if (!current) return null;

  current.socketId = null;
  const partner = getPartner(session, userId, socketId);

  if (partner?.socketId) {
    io.to(partner.socketId).emit('anon:partner_disconnected', {
      sessionId: session.id
    });
  }

  return session;
}

function endSessionForAdmin(io, sessionId, reason = 'ended_by_moderator') {
  const session = activeSessions.get(sessionId);
  if (!session) return null;

  clearSessionIndexes(session);
  persistSessionEnded(session.id, 'ADMIN').catch(() => undefined);

  for (const participant of session.users) {
    if (!participant?.socketId) continue;

    io.to(participant.socketId).emit('anon:partner_left', {
      sessionId: session.id,
      reason: 'admin',
      details: reason
    });

    io.to(participant.socketId).emit('anon:left', {
      sessionId: session.id,
      reason: 'admin',
      details: reason
    });
  }

  emitSessionEnded(io, session, 'admin', null);
  return session;
}

function cleanupExpiredSessions(io) {
  const now = Date.now();
  for (const session of activeSessions.values()) {
    if (session.expiresAt > now) continue;
    for (const user of session.users) {
      if (user.socketId) {
        io.to(user.socketId).emit('anon:partner_left', {
          sessionId: session.id,
          reason: 'expired'
        });
      }
    }
    clearSessionIndexes(session);
    persistSessionEnded(session.id, 'TIMEOUT').catch(() => undefined);
    emitSessionEnded(io, session, 'expired', null);
  }
}

function checkMessageRateLimit(userId) {
  const now = Date.now();
  const bucket = userRateBuckets.get(userId) || [];
  const recent = bucket.filter((ts) => now - ts < 60 * 1000);
  if (recent.length >= MESSAGE_RATE_LIMIT_PER_MINUTE) {
    userRateBuckets.set(userId, recent);
    return false;
  }
  recent.push(now);
  userRateBuckets.set(userId, recent);
  return true;
}

function registerModerationHit(userId) {
  const now = Date.now();
  const bucket = moderationHitsByUser.get(userId) || [];
  const recent = bucket.filter((ts) => now - ts < 24 * 60 * 60 * 1000);
  recent.push(now);
  moderationHitsByUser.set(userId, recent);
  return recent.length;
}

function isUserMuted(session, userId) {
  const mutedUntil = session?.mutedUntilByUserId?.get(userId);
  if (!mutedUntil) return false;
  if (mutedUntil <= Date.now()) {
    session.mutedUntilByUserId.delete(userId);
    return false;
  }
  return true;
}

function emitMatched(io, session) {
  const [first, second] = session.users;
  if (first?.socketId) {
    io.to(first.socketId).emit('anon:matched', {
      sessionId: session.id,
      yourRole: first.role,
      partnerAlias: second.alias,
      topic: first.topic || second.topic || 'all'
    });
  }

  if (second?.socketId) {
    io.to(second.socketId).emit('anon:matched', {
      sessionId: session.id,
      yourRole: second.role,
      partnerAlias: first.alias,
      topic: second.topic || first.topic || 'all'
    });
  }

  emitAdminEvent(io, 'session:new', {
    sessionId: session.id,
    startedAt: new Date(session.createdAt).toISOString(),
    mode: session.mode,
    room: session.room,
    users: session.users.map((item) => ({
      userId: item.userId,
      role: item.role,
      alias: item.alias
    })),
    indicator: getSessionIndicator(session),
    messageCount: session.messageCount
  });
}

function registerAnonSupportSocket(io) {
  io.use(async (socket, next) => {
    try {
      const resolved = await resolveSocketUser(socket);
      if (!resolved?.user) {
        next(new Error('Not authorized'));
        return;
      }
      socket.user = resolved.user;
      socket.sessionId = resolved.sessionId;
      next();
    } catch (_error) {
      next(new Error('Not authorized'));
    }
  });

  if (!cleanupTimer) {
    cleanupTimer = setInterval(() => cleanupExpiredSessions(io), CLEANUP_INTERVAL_MS);
  }

  io.on('connection', (socket) => {
    socket.on('anon:queue', async (payload, ack) => {
      try {
        const parsed = queueSchema.parse(payload || {});
        const userId = socket.user.id;

        const globalAccess = await syncGlobalBlockState(socket.user);
        if (globalAccess.isGloballyBlocked) {
          safeAck(ack, { ok: false, message: 'Аккаунт заблокирован' });
          return;
        }

        const activeBan = await getActiveBanForUser(userId, BAN_SCOPE.ANON);
        if (activeBan) {
          const bannedPayload = {
            ok: false,
            message: 'Доступ к анонимному чату ограничен',
            ban: serializeBan(activeBan)
          };
          socket.emit('anon:banned', bannedPayload);
          safeAck(ack, bannedPayload);
          return;
        }

        const existingSession = getSessionByUser(userId);
        if (existingSession) {
          const partner = getPartner(existingSession, userId, socket.id);
          const current = getParticipant(existingSession, userId, socket.id);

          if (current) {
            current.socketId = socket.id;
          }

          safeAck(ack, {
            ok: true,
            inSession: true,
            sessionId: existingSession.id
          });

          socket.emit('anon:matched', {
            sessionId: existingSession.id,
            yourRole: current?.role || TALK_MODE,
            partnerAlias: partner?.alias || 'Собеседник',
            topic: current?.topic || partner?.topic || 'all'
          });
          return;
        }

        const entry = {
          userId,
          socketId: socket.id,
          mode: parsed.mode,
          topic: normalizeTopic(parsed.topic),
          joinedAt: Date.now()
        };

        upsertQueueEntry(entry);

        const matched = tryMatchFromQueue(io);
        if (matched) {
          logger.info('Anon-чат: собеседники сматчены', {
            sessionId: matched.id,
            users: matched.users.map((item) => item.userId)
          });
          emitMatched(io, matched);
          safeAck(ack, {
            ok: true,
            matched: true,
            sessionId: matched.id
          });
          return;
        }

        const queueList = waiting[entry.mode];
        const position = queueList.findIndex((item) => item.userId === userId) + 1;

        socket.emit('anon:queued', {
          mode: entry.mode,
          topic: entry.topic,
          position: position || 1
        });

        safeAck(ack, {
          ok: true,
          queued: true,
          mode: entry.mode,
          position: position || 1
        });
      } catch (error) {
        if (error?.name === 'ZodError') {
          safeAck(ack, {
            ok: false,
            message: 'Некорректные данные очереди',
            details: error.flatten?.() || error.issues || null
          });
          return;
        }

        logger.error('Anon-чат: ошибка anon:queue', {
          userId: socket.user?.id,
          error: error.message
        });
        safeAck(ack, { ok: false, message: 'Не удалось войти в очередь' });
      }
    });

    socket.on('anon:message', async (payload, ack) => {
      try {
        const parsed = messageSchema.parse(payload || {});
        const userId = socket.user.id;

        if (!checkMessageRateLimit(userId)) {
          socket.emit('anon:error', { message: 'Слишком много сообщений. Попробуйте чуть позже.' });
          safeAck(ack, { ok: false, message: 'Превышен лимит сообщений (30/мин)' });
          return;
        }

        const globalAccess = await syncGlobalBlockState(socket.user);
        if (globalAccess.isGloballyBlocked) {
          safeAck(ack, { ok: false, message: 'Аккаунт заблокирован' });
          return;
        }

        const activeBan = await getActiveBanForUser(userId, BAN_SCOPE.ANON);
        if (activeBan) {
          const bannedPayload = {
            ok: false,
            message: 'Доступ к анонимному чату ограничен',
            ban: serializeBan(activeBan)
          };
          socket.emit('anon:banned', bannedPayload);
          safeAck(ack, bannedPayload);
          return;
        }

        const session = getSessionByUser(userId);
        if (!session) {
          safeAck(ack, { ok: false, message: 'Вы не в активном чате' });
          return;
        }

        if (isUserMuted(session, userId)) {
          const untilTs = session.mutedUntilByUserId.get(userId);
          socket.emit('anon:error', {
            message: 'Вы временно ограничены модератором. Попробуйте позже.',
            mutedUntil: new Date(untilTs).toISOString()
          });
          safeAck(ack, {
            ok: false,
            muted: true,
            message: 'Пользователь временно заглушен'
          });
          return;
        }

        const sender = getParticipant(session, userId, socket.id);
        const partner = getPartner(session, userId, socket.id);
        if (!sender || !partner) {
          safeAck(ack, { ok: false, message: 'Сессия недоступна' });
          return;
        }

        const moderation = moderateAnonText(parsed.text);
        if (moderation.flagged) {
          const hits = registerModerationHit(userId);
          session.flags.hasSuspicious = true;
          session.flags.lastTriggerAt = Date.now();

          await persistSessionMessage({
            id: crypto.randomUUID(),
            sessionId: session.id,
            senderId: userId,
            senderType: 'USER',
            alias: sender.alias,
            text: moderation.normalizedText || parsed.text,
            flagged: true,
            flagReason: moderation.reason,
            meta: { category: moderation.category, blocked: true }
          });

          writeModLog({
            type: 'STOP_WORD',
            userId,
            sessionId: session.id,
            triggerWord: moderation.category,
            autoAction: 'blocked_message',
            details: {
              reason: moderation.reason,
              strikes24h: hits
            }
          }).catch(() => undefined);

          emitAdminEvent(io, 'session:trigger', {
            sessionId: session.id,
            type: 'suspicious',
            category: moderation.category,
            reason: moderation.reason,
            userId,
            indicator: getSessionIndicator(session),
            at: new Date().toISOString()
          });

          socket.emit('anon:moderated', {
            message: 'Сообщение нарушает правила безопасного пространства. Попробуйте переформулировать.',
            category: moderation.category,
            reason: moderation.reason,
            strikes24h: hits
          });

          if (hits >= 5) {
            const ban = await createAutoSoftBan(
              userId,
              'Повторные нарушения правил анонимного чата'
            );

            const bannedPayload = {
              message: 'Доступ временно ограничен из-за повторных нарушений правил.',
              ban: serializeBan(ban)
            };
            socket.emit('anon:banned', bannedPayload);
            writeModLog({
              type: 'AUTO_BAN',
              userId,
              sessionId: session.id,
              autoAction: 'soft_ban_24h',
              details: {
                strikes24h: hits
              }
            }).catch(() => undefined);
            endSessionForUser(io, userId, 'banned', socket.id);
          } else if (hits >= 3) {
            socket.emit('anon:warn', {
              message: 'Предупреждение: при повторных нарушениях доступ будет временно ограничен.',
              strikes24h: hits
            });
            writeModLog({
              type: 'AUTO_WARNING',
              userId,
              sessionId: session.id,
              autoAction: 'warn_user',
              details: {
                strikes24h: hits
              }
            }).catch(() => undefined);
          }

          safeAck(ack, {
            ok: false,
            moderated: true,
            category: moderation.category,
            reason: moderation.reason
          });
          return;
        }

        const messageId = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        const text = moderation.normalizedText;

        session.messageCount += 1;
        session.messages.set(messageId, {
          id: messageId,
          senderId: userId,
          text,
          createdAt,
          isDeleted: false
        });

        await persistSessionMessage({
          id: messageId,
          sessionId: session.id,
          senderId: userId,
          senderType: 'USER',
          alias: sender.alias,
          text
        });

        if (partner.socketId) {
          io.to(partner.socketId).emit('anon:message', {
            sessionId: session.id,
            message: {
              id: messageId,
              from: 'partner',
              alias: sender.alias,
              text,
              createdAt
            }
          });
        }

        socket.emit('anon:message', {
          sessionId: session.id,
          message: {
            id: messageId,
            from: 'me',
            alias: sender.alias,
            text,
            createdAt
          }
        });

        emitAdminEvent(io, 'session:message', {
          sessionId: session.id,
          indicator: getSessionIndicator(session),
          message: {
            id: messageId,
            senderId: userId,
            senderType: 'USER',
            alias: sender.alias,
            text,
            createdAt,
            flagged: false,
            isDeleted: false
          },
          messageCount: session.messageCount
        });

        if (moderation.crisisDetected) {
          const crisisPayload = {
            sessionId: session.id,
            phone: '150',
            message: 'Кажется, тебе сейчас очень тяжело. Если нужна немедленная помощь: телефон доверия 150 (бесплатно).'
          };

          session.flags.hasCrisis = true;
          session.flags.lastTriggerAt = Date.now();

          socket.emit('anon:crisis', crisisPayload);
          if (partner.socketId) {
            io.to(partner.socketId).emit('anon:crisis', crisisPayload);
          }

          writeModLog({
            type: 'CRISIS_TRIGGER',
            userId,
            sessionId: session.id,
            autoAction: 'show_crisis_contacts'
          }).catch(() => undefined);

          emitAdminEvent(io, 'session:trigger', {
            sessionId: session.id,
            type: 'crisis',
            category: 'crisis',
            userId,
            indicator: getSessionIndicator(session),
            at: new Date().toISOString()
          });
        }

        safeAck(ack, { ok: true, messageId, createdAt });
      } catch (error) {
        if (error?.name === 'ZodError') {
          safeAck(ack, {
            ok: false,
            message: 'Некорректные данные сообщения',
            details: error.flatten?.() || error.issues || null
          });
          return;
        }
        logger.error('Anon-чат: ошибка anon:message', {
          userId: socket.user?.id,
          error: error.message
        });
        safeAck(ack, { ok: false, message: 'Не удалось отправить сообщение' });
      }
    });

    socket.on('anon:typing', (payload) => {
      try {
        const parsed = typingSchema.parse(payload || {});
        const userId = socket.user.id;
        const session = getSessionByUser(userId);
        if (!session) return;

        const partner = getPartner(session, userId, socket.id);
        if (!partner?.socketId) return;

        io.to(partner.socketId).emit('anon:typing', {
          sessionId: session.id,
          isTyping: Boolean(parsed.isTyping)
        });
      } catch (_error) {
        // Игнорируем невалидные события печати.
      }
    });

    socket.on('anon:leave', (_payload, ack) => {
      const userId = socket.user.id;

      if (ANON_ALLOW_SELF_MATCH) {
        removeFromQueueBySocket(socket.id);
      } else {
        removeFromQueueByUser(userId);
      }
      const ended = endSessionForUser(io, userId, 'left', socket.id);

      safeAck(ack, {
        ok: true,
        leftQueue: !ended,
        leftSession: Boolean(ended)
      });
    });

    socket.on('anon:leave_queue', (_payload, ack) => {
      const userId = socket.user.id;
      if (ANON_ALLOW_SELF_MATCH) {
        removeFromQueueBySocket(socket.id);
      } else {
        removeFromQueueByUser(userId);
      }
      safeAck(ack, { ok: true });
    });

    socket.on('disconnect', () => {
      const userId = socket.user?.id;
      if (!userId) return;
      removeFromQueueBySocket(socket.id);
      detachSocketFromSession(io, userId, socket.id);
    });
  });
}

function getActiveSessionsSnapshot() {
  return Array.from(activeSessions.values())
    .map((session) => ({
      sessionId: session.id,
      status: 'ACTIVE',
      mode: session.mode,
      room: session.room,
      startedAt: new Date(session.createdAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      messageCount: session.messageCount,
      indicator: getSessionIndicator(session),
      users: session.users.map((item) => ({
        userId: item.userId,
        role: item.role,
        alias: item.alias,
        mutedUntil: session.mutedUntilByUserId.get(item.userId)
          ? new Date(session.mutedUntilByUserId.get(item.userId)).toISOString()
          : null
      }))
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

async function getSessionMessagesSnapshot(sessionId, take = 300) {
  const normalizedTake = Number.isFinite(Number(take)) ? Math.min(Math.max(Number(take), 1), 500) : 300;
  const messages = await prisma.chatSessionMessage.findMany({
    where: { sessionId },
    orderBy: [{ sentAt: 'asc' }],
    take: normalizedTake,
    include: {
      sender: {
        select: {
          id: true,
          username: true,
          displayName: true
        }
      }
    }
  });

  return messages.map((item) => {
    let parsedMeta = null;
    if (item.metaJson) {
      try {
        parsedMeta = JSON.parse(item.metaJson);
      } catch (_error) {
        parsedMeta = null;
      }
    }

    return {
    id: item.id,
    sessionId: item.sessionId,
    senderId: item.senderId,
    senderType: item.senderType,
    alias: item.alias,
    text: item.text,
    isDeleted: item.isDeleted,
    deletedBy: item.deletedBy,
    flagged: item.flagged,
    flagReason: item.flagReason,
    sentAt: item.sentAt,
    sender: item.sender,
    meta: parsedMeta
  };
  });
}

function ensureActiveSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) {
    const error = new Error('ACTIVE_SESSION_NOT_FOUND');
    error.code = 'ACTIVE_SESSION_NOT_FOUND';
    throw error;
  }
  return session;
}

async function adminSendSessionMessage(io, { sessionId, text, target = 'all', adminId }) {
  const session = ensureActiveSession(sessionId);
  const normalizedText = `${text || ''}`.trim().slice(0, 2000);
  if (!normalizedText) {
    const error = new Error('EMPTY_MESSAGE');
    error.code = 'EMPTY_MESSAGE';
    throw error;
  }

  const messageId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const targets =
    target === 'all'
      ? session.users
      : session.users.filter((item) => item.userId === target);

  if (!targets.length) {
    const error = new Error('TARGET_NOT_FOUND');
    error.code = 'TARGET_NOT_FOUND';
    throw error;
  }

  session.messageCount += 1;
  session.messages.set(messageId, {
    id: messageId,
    senderId: adminId,
    text: normalizedText,
    createdAt,
    isDeleted: false,
    senderType: 'ADMIN'
  });

  await persistSessionMessage({
    id: messageId,
    sessionId,
    senderId: adminId,
    senderType: 'ADMIN',
    alias: 'Модератор',
    text: normalizedText,
    meta: { target }
  });

  for (const participant of targets) {
    if (!participant.socketId) continue;
    io.to(participant.socketId).emit('anon:message', {
      sessionId,
      message: {
        id: messageId,
        kind: 'system',
        from: 'system',
        alias: 'Модератор',
        text: normalizedText,
        createdAt
      }
    });
  }

  emitAdminEvent(io, 'session:message', {
    sessionId,
    indicator: getSessionIndicator(session),
    message: {
      id: messageId,
      senderId: adminId,
      senderType: 'ADMIN',
      alias: 'Модератор',
      text: normalizedText,
      createdAt,
      isDeleted: false
    },
    messageCount: session.messageCount
  });

  writeModAction({
    adminId,
    sessionId,
    action: 'intervene_message',
    reason: 'admin_message',
    metadata: { target, messageId }
  }).catch(() => undefined);

  return {
    messageId,
    sessionId,
    deliveredTo: targets.map((item) => item.userId),
    createdAt
  };
}

async function adminDeleteSessionMessage(io, { sessionId, messageId, adminId }) {
  ensureActiveSession(sessionId);

  const existing = await prisma.chatSessionMessage.findFirst({
    where: {
      id: messageId,
      sessionId
    }
  });

  if (!existing) {
    const error = new Error('MESSAGE_NOT_FOUND');
    error.code = 'MESSAGE_NOT_FOUND';
    throw error;
  }

  await prisma.chatSessionMessage.update({
    where: { id: existing.id },
    data: {
      isDeleted: true,
      deletedBy: 'admin',
      text: 'Сообщение удалено модератором'
    }
  });

  const session = activeSessions.get(sessionId);
  if (session?.messages?.has(messageId)) {
    const prev = session.messages.get(messageId);
    session.messages.set(messageId, {
      ...prev,
      text: 'Сообщение удалено модератором',
      isDeleted: true
    });
  }

  if (session) {
    for (const participant of session.users) {
      if (!participant.socketId) continue;
      io.to(participant.socketId).emit('anon:message_deleted', {
        sessionId,
        messageId,
        replacementText: 'Сообщение удалено модератором'
      });
    }
  }

  emitAdminEvent(io, 'session:message_deleted', {
    sessionId,
    messageId,
    byAdminId: adminId
  });

  writeModAction({
    adminId,
    targetUserId: existing.senderId,
    sessionId,
    action: 'delete_msg',
    reason: 'manual_delete',
    metadata: { messageId }
  }).catch(() => undefined);

  return {
    ok: true,
    sessionId,
    messageId
  };
}

async function adminMuteSessionUser(io, { sessionId, userId, durationSeconds = DEFAULT_MUTE_SECONDS, adminId }) {
  const session = ensureActiveSession(sessionId);
  const participant = session.users.find((item) => item.userId === userId);
  if (!participant) {
    const error = new Error('USER_NOT_IN_SESSION');
    error.code = 'USER_NOT_IN_SESSION';
    throw error;
  }

  const normalizedDuration = Number.isFinite(Number(durationSeconds))
    ? Math.min(Math.max(Number(durationSeconds), 30), 24 * 60 * 60)
    : DEFAULT_MUTE_SECONDS;

  const mutedUntilTs = Date.now() + normalizedDuration * 1000;
  session.mutedUntilByUserId.set(userId, mutedUntilTs);

  if (participant.socketId) {
    io.to(participant.socketId).emit('anon:muted', {
      sessionId,
      durationSeconds: normalizedDuration,
      mutedUntil: new Date(mutedUntilTs).toISOString(),
      message: 'Вы временно ограничены модератором.'
    });
  }

  emitAdminEvent(io, 'session:user_muted', {
    sessionId,
    userId,
    durationSeconds: normalizedDuration,
    mutedUntil: new Date(mutedUntilTs).toISOString(),
    byAdminId: adminId
  });

  writeModAction({
    adminId,
    targetUserId: userId,
    sessionId,
    action: 'mute',
    reason: `mute_${normalizedDuration}s`,
    metadata: { durationSeconds: normalizedDuration }
  }).catch(() => undefined);

  return {
    ok: true,
    sessionId,
    userId,
    durationSeconds: normalizedDuration,
    mutedUntil: new Date(mutedUntilTs).toISOString()
  };
}

async function adminEndSession(io, { sessionId, reason = 'ended_by_moderator', adminId }) {
  const endedSession = endSessionForAdmin(io, sessionId, reason);
  if (!endedSession) {
    const error = new Error('ACTIVE_SESSION_NOT_FOUND');
    error.code = 'ACTIVE_SESSION_NOT_FOUND';
    throw error;
  }

  for (const participant of endedSession.users) {
    writeModAction({
      adminId,
      targetUserId: participant.userId,
      sessionId,
      action: 'end_session',
      reason,
      metadata: { mode: endedSession.mode, room: endedSession.room }
    }).catch(() => undefined);
  }

  return {
    ok: true,
    sessionId,
    reason
  };
}

module.exports = {
  registerAnonSupportSocket,
  getActiveSessionsSnapshot,
  getSessionMessagesSnapshot,
  adminSendSessionMessage,
  adminDeleteSessionMessage,
  adminMuteSessionUser,
  adminEndSession
};
