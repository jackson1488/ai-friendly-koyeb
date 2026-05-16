const { prisma } = require('../config/prisma');
const { getIo } = require('../socket/io');

async function writeLoginEvent({
  userId = null,
  username = null,
  sessionId = null,
  action,
  success = true,
  reason = null,
  ipAddress = null,
  userAgent = null,
  platform = null,
  device = null,
  appName = null
}) {
  if (!action) return null;

  return prisma.loginEvent.create({
    data: {
      userId,
      username,
      sessionId,
      action,
      success,
      reason,
      ipAddress,
      userAgent,
      platform,
      device,
      appName
    }
  });
}

function iterateSocketsByUserId(userId, sessionId = null) {
  const io = getIo();
  if (!io || !io._nsps) return [];

  const hits = [];
  for (const nsp of io._nsps.values()) {
    if (!nsp?.sockets) continue;
    for (const socket of nsp.sockets.values()) {
      if (!socket?.user?.id) continue;
      if (socket.user.id !== userId) continue;
      if (sessionId && socket.sessionId && socket.sessionId !== sessionId) continue;
      hits.push(socket);
    }
  }
  return hits;
}

function disconnectUserSockets(userId, sessionId = null, reason = 'SESSION_REVOKED', details = null) {
  const sockets = iterateSocketsByUserId(userId, sessionId);
  for (const socket of sockets) {
    try {
      socket.emit('auth:force_logout', { reason, sessionId, details });
      socket.disconnect(true);
    } catch (_error) {
      // ignore
    }
  }
  return sockets.length;
}

async function revokeAllUserSessions(userId, options = {}) {
  const reason = `${options?.reason || 'ALL_SESSIONS_REVOKED'}`.trim() || 'ALL_SESSIONS_REVOKED';
  const details = options?.details || null;
  const [deleted] = await prisma.$transaction([
    prisma.refreshToken.deleteMany({ where: { userId } }),
    prisma.user.update({
      where: { id: userId },
      data: { sessionVersion: { increment: 1 } },
      select: { id: true, sessionVersion: true }
    })
  ]);

  const disconnected = disconnectUserSockets(userId, null, reason, details);
  return {
    deletedSessions: deleted.count,
    disconnectedSockets: disconnected
  };
}

async function revokeSingleUserSession(userId, sessionId) {
  const deleted = await prisma.refreshToken.deleteMany({
    where: { id: sessionId, userId }
  });

  const disconnected = disconnectUserSockets(userId, sessionId, 'SESSION_REVOKED');
  return {
    deletedSessions: deleted.count,
    disconnectedSockets: disconnected
  };
}

module.exports = {
  writeLoginEvent,
  disconnectUserSockets,
  revokeAllUserSessions,
  revokeSingleUserSession
};
