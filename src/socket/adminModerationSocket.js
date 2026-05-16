const { z } = require('zod');
const { logger } = require('../utils/logger');
const {
  getActiveSessionsSnapshot,
  getSessionMessagesSnapshot,
  adminSendSessionMessage,
  adminDeleteSessionMessage,
  adminMuteSessionUser,
  adminEndSession
} = require('./anonSupportSocket');
const { resolveSocketUser } = require('../services/socketAuthService');

const ADMIN_NAMESPACE = '/admin';

const joinSchema = z.object({
  sessionId: z.string().min(1).max(128)
});

const sendSchema = z.object({
  sessionId: z.string().min(1).max(128),
  text: z.string().min(1).max(2000),
  target: z.string().min(1).max(128).optional()
});

const deleteSchema = z.object({
  sessionId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(128)
});

const muteSchema = z.object({
  sessionId: z.string().min(1).max(128),
  userId: z.string().min(1).max(128),
  duration: z.number().int().min(30).max(86400).optional()
});

const endSchema = z.object({
  sessionId: z.string().min(1).max(128),
  reason: z.string().min(1).max(280).optional()
});

function safeAck(ack, payload) {
  if (typeof ack !== 'function') return;
  try {
    ack(payload);
  } catch (_error) {
    // ignore
  }
}

async function resolveAdminSocketUser(socket, next) {
  try {
    const resolved = await resolveSocketUser(socket, { requireAdmin: true });
    if (!resolved?.user) {
      next(new Error('Не авторизован'));
      return;
    }
    socket.user = resolved.user;
    socket.sessionId = resolved.sessionId;
    next();
  } catch (_error) {
    next(new Error('Не авторизован'));
  }
}

function registerAdminModerationSocket(io) {
  const nsp = io.of(ADMIN_NAMESPACE);

  nsp.use((socket, next) => {
    resolveAdminSocketUser(socket, next).catch(() => next(new Error('Не авторизован')));
  });

  nsp.on('connection', (socket) => {
    socket.emit('sessions:active', {
      sessions: getActiveSessionsSnapshot(),
      total: getActiveSessionsSnapshot().length
    });

    socket.on('admin:join_session', async (payload, ack) => {
      try {
        const parsed = joinSchema.parse(payload || {});
        const room = `admin:session:${parsed.sessionId}`;
        socket.join(room);

        const messages = await getSessionMessagesSnapshot(parsed.sessionId, 300);
        safeAck(ack, {
          ok: true,
          sessionId: parsed.sessionId,
          messages,
          total: messages.length
        });

        socket.emit('session:snapshot', {
          sessionId: parsed.sessionId,
          messages,
          total: messages.length
        });
      } catch (error) {
        safeAck(ack, {
          ok: false,
          message: 'Не удалось присоединиться к сессии',
          details: error?.flatten?.() || error?.issues || null
        });
      }
    });

    socket.on('admin:send_message', async (payload, ack) => {
      try {
        const parsed = sendSchema.parse(payload || {});
        const result = await adminSendSessionMessage(io, {
          sessionId: parsed.sessionId,
          text: parsed.text,
          target: parsed.target || 'all',
          adminId: socket.user.id
        });

        safeAck(ack, { ok: true, ...result });
      } catch (error) {
        safeAck(ack, {
          ok: false,
          message: 'Не удалось отправить сообщение модератора',
          code: error?.code || 'UNKNOWN_ERROR'
        });
      }
    });

    socket.on('admin:delete_message', async (payload, ack) => {
      try {
        const parsed = deleteSchema.parse(payload || {});
        const result = await adminDeleteSessionMessage(io, {
          sessionId: parsed.sessionId,
          messageId: parsed.messageId,
          adminId: socket.user.id
        });

        safeAck(ack, { ok: true, ...result });
      } catch (error) {
        safeAck(ack, {
          ok: false,
          message: 'Не удалось удалить сообщение',
          code: error?.code || 'UNKNOWN_ERROR'
        });
      }
    });

    socket.on('admin:mute_user', async (payload, ack) => {
      try {
        const parsed = muteSchema.parse(payload || {});
        const result = await adminMuteSessionUser(io, {
          sessionId: parsed.sessionId,
          userId: parsed.userId,
          durationSeconds: parsed.duration,
          adminId: socket.user.id
        });

        safeAck(ack, { ok: true, ...result });
      } catch (error) {
        safeAck(ack, {
          ok: false,
          message: 'Не удалось заглушить пользователя',
          code: error?.code || 'UNKNOWN_ERROR'
        });
      }
    });

    socket.on('admin:end_session', async (payload, ack) => {
      try {
        const parsed = endSchema.parse(payload || {});
        const result = await adminEndSession(io, {
          sessionId: parsed.sessionId,
          reason: parsed.reason || 'Завершено модератором',
          adminId: socket.user.id
        });

        safeAck(ack, { ok: true, ...result });
      } catch (error) {
        safeAck(ack, {
          ok: false,
          message: 'Не удалось завершить сессию',
          code: error?.code || 'UNKNOWN_ERROR'
        });
      }
    });

    socket.on('disconnect', () => {
      logger.info('Admin moderation socket disconnected', {
        adminId: socket.user?.id,
        socketId: socket.id
      });
    });
  });
}

module.exports = { registerAdminModerationSocket };
