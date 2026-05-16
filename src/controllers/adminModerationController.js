const { z } = require('zod');
const { AppError } = require('../utils/errors');
const { getIo } = require('../socket/io');
const {
  getActiveSessionsSnapshot,
  getSessionMessagesSnapshot,
  adminSendSessionMessage,
  adminDeleteSessionMessage,
  adminMuteSessionUser,
  adminEndSession
} = require('../socket/anonSupportSocket');

/**
 * adminModerationController.js — live-модерация anonymous support sessions.
 *
 * Важный момент:
 * данные активных anonymous sessions живут в socket-модуле, потому что это realtime.
 * Controller здесь выступает мостом:
 * HTTP admin API -> socket action -> ответ админке.
 */

const sendMessageSchema = z.object({
  text: z.string().min(1).max(2000),
  target: z.string().min(1).max(128).optional()
});

const deleteMessageSchema = z.object({
  messageId: z.string().min(1).max(128)
});

const muteUserSchema = z.object({
  userId: z.string().min(1).max(128),
  durationSeconds: z.number().int().min(30).max(86400).optional()
});

const endSessionSchema = z.object({
  reason: z.string().min(1).max(280).optional()
});

function mapLiveModerationError(error) {
  // Socket layer бросает технические коды. HTTP API должен вернуть нормальный статус.
  const code = error?.code || error?.message;
  if (code === 'ACTIVE_SESSION_NOT_FOUND') {
    return new AppError(404, 'Активная сессия не найдена');
  }
  if (code === 'MESSAGE_NOT_FOUND') {
    return new AppError(404, 'Сообщение не найдено');
  }
  if (code === 'USER_NOT_IN_SESSION') {
    return new AppError(404, 'Пользователь не найден в сессии');
  }
  if (code === 'TARGET_NOT_FOUND') {
    return new AppError(404, 'Целевой пользователь не найден в сессии');
  }
  if (code === 'EMPTY_MESSAGE') {
    return new AppError(400, 'Текст сообщения пустой');
  }

  return new AppError(500, 'Ошибка live-модерации');
}

function getIoOrThrow() {
  // Без Socket.IO live-модерация невозможна: команды должны улететь в комнаты.
  const io = getIo();
  if (!io) {
    throw new AppError(503, 'Socket сервер еще не инициализирован');
  }
  return io;
}

async function listActiveSessions(_req, res) {
  // Snapshot — текущая картина из памяти socket-модуля.
  const sessions = getActiveSessionsSnapshot();
  res.json({ sessions, total: sessions.length });
}

async function getSessionMessages(req, res) {
  const sessionId = `${req.params.sessionId || ''}`.trim();
  if (!sessionId) throw new AppError(400, 'Не передан sessionId');

  // take ограничивает объём, чтобы админка случайно не запросила бесконечную историю.
  const take = Number(req.query.take || 300);
  const messages = await getSessionMessagesSnapshot(sessionId, take);

  res.json({
    sessionId,
    messages,
    total: messages.length
  });
}

async function sendSessionMessage(req, res) {
  const parsed = sendMessageSchema.safeParse(req.body || {});
  if (!parsed.success) {
    throw new AppError(400, 'Некорректные данные сообщения модератора', parsed.error.flatten());
  }

  const sessionId = `${req.params.sessionId || ''}`.trim();
  if (!sessionId) throw new AppError(400, 'Не передан sessionId');

  try {
    const io = getIoOrThrow();
    const result = await adminSendSessionMessage(io, {
      sessionId,
      text: parsed.data.text,
      target: parsed.data.target || 'all',
      adminId: req.user.id
    });

    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    throw mapLiveModerationError(error);
  }
}

async function deleteSessionMessage(req, res) {
  const parsed = deleteMessageSchema.safeParse(req.body || {});
  if (!parsed.success) {
    throw new AppError(400, 'Некорректные данные удаления сообщения', parsed.error.flatten());
  }

  const sessionId = `${req.params.sessionId || ''}`.trim();
  if (!sessionId) throw new AppError(400, 'Не передан sessionId');

  try {
    const io = getIoOrThrow();
    const result = await adminDeleteSessionMessage(io, {
      sessionId,
      messageId: parsed.data.messageId,
      adminId: req.user.id
    });

    res.json(result);
  } catch (error) {
    throw mapLiveModerationError(error);
  }
}

async function muteSessionUser(req, res) {
  const parsed = muteUserSchema.safeParse(req.body || {});
  if (!parsed.success) {
    throw new AppError(400, 'Некорректные данные mute', parsed.error.flatten());
  }

  const sessionId = `${req.params.sessionId || ''}`.trim();
  if (!sessionId) throw new AppError(400, 'Не передан sessionId');

  try {
    const io = getIoOrThrow();
    const result = await adminMuteSessionUser(io, {
      sessionId,
      userId: parsed.data.userId,
      durationSeconds: parsed.data.durationSeconds,
      adminId: req.user.id
    });

    res.json(result);
  } catch (error) {
    throw mapLiveModerationError(error);
  }
}

async function endSession(req, res) {
  const parsed = endSessionSchema.safeParse(req.body || {});
  if (!parsed.success) {
    throw new AppError(400, 'Некорректные данные завершения сессии', parsed.error.flatten());
  }

  const sessionId = `${req.params.sessionId || ''}`.trim();
  if (!sessionId) throw new AppError(400, 'Не передан sessionId');

  try {
    const io = getIoOrThrow();
    const result = await adminEndSession(io, {
      sessionId,
      reason: parsed.data.reason || 'Завершено модератором',
      adminId: req.user.id
    });

    res.json(result);
  } catch (error) {
    throw mapLiveModerationError(error);
  }
}

module.exports = {
  listActiveSessions,
  getSessionMessages,
  sendSessionMessage,
  deleteSessionMessage,
  muteSessionUser,
  endSession
};
