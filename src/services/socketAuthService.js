const { prisma } = require('../config/prisma');
const { verifyToken } = require('../utils/jwt');
const { buildSocketClientInfo } = require('../utils/clientInfo');
const { syncGlobalBlockState } = require('./banService');

function extractSocketToken(socket) {
  const authHeader = socket?.handshake?.auth?.token || socket?.handshake?.headers?.authorization;
  if (!authHeader) return null;
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
}

async function resolveSocketUser(socket, { requireAdmin = false } = {}) {
  const token = extractSocketToken(socket);
  if (!token) return null;

  const payload = verifyToken(token);
  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) return null;
  if (user.isDeleted) return null;
  const globalAccess = await syncGlobalBlockState(user);
  if (globalAccess.isGloballyBlocked) return null;
  const effectiveUser = globalAccess.user || user;
  if (requireAdmin && effectiveUser.role !== 'ADMIN') return null;

  const tokenSessionVersion = Number.isFinite(Number(payload?.sv)) ? Number(payload.sv) : 0;
  const userSessionVersion = Number.isFinite(Number(effectiveUser.sessionVersion))
    ? Number(effectiveUser.sessionVersion)
    : 0;
  if (tokenSessionVersion !== userSessionVersion) return null;

  const sessionId = `${payload?.sid || ''}`.trim();
  if (sessionId) {
    const session = await prisma.refreshToken.findFirst({
      where: {
        id: sessionId,
        userId: effectiveUser.id,
        expiresAt: { gt: new Date() }
      }
    });
    if (!session) return null;

    const meta = buildSocketClientInfo(socket);
    prisma.refreshToken
      .update({
        where: { id: session.id },
        data: {
          lastSeenAt: new Date(),
          ipAddress: meta.ipAddress || session.ipAddress,
          userAgent: meta.userAgent || session.userAgent,
          platform: meta.platform || session.platform,
          device: meta.device || session.device,
          appName: meta.appName || session.appName
        }
      })
      .catch(() => {});
  }

  return {
    user: effectiveUser,
    payload,
    sessionId: sessionId || null
  };
}

module.exports = {
  resolveSocketUser,
  extractSocketToken
};
