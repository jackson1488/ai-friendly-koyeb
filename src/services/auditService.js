const { prisma } = require('../config/prisma');
const { logger } = require('../utils/logger');

async function writeAuditLog({ adminId, action, targetUserId = null, meta = {} }) {
  if (!adminId || !action) {
    logger.warn('Пропущена запись audit-лога: не хватает adminId/action', {
      adminId: adminId || null,
      action: action || null
    });
    return;
  }

  let normalizedTargetUserId = targetUserId || null;
  if (normalizedTargetUserId) {
    const targetUser = await prisma.user.findUnique({
      where: { id: normalizedTargetUserId },
      select: { id: true }
    });
    if (!targetUser) {
      normalizedTargetUserId = null;
    }
  }

  try {
    await prisma.adminAuditLog.create({
      data: {
        adminId,
        action,
        targetUserId: normalizedTargetUserId,
        metaJson: JSON.stringify(meta || {})
      }
    });
  } catch (error) {
    if (error?.code === 'P2003') {
      logger.warn('Конфликт внешнего ключа в audit-логе, пробуем записать без targetUserId', {
        adminId,
        action,
        targetUserId: normalizedTargetUserId
      });

      await prisma.adminAuditLog.create({
        data: {
          adminId,
          action,
          targetUserId: null,
          metaJson: JSON.stringify({
            ...(meta || {}),
            targetUserIdFallback: normalizedTargetUserId
          })
        }
      });
      return;
    }
    throw error;
  }
}

module.exports = { writeAuditLog };

