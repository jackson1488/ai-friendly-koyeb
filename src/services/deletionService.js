const { prisma } = require('../config/prisma');

const ACCOUNT_DELETION_RETENTION_DAYS = 20;

function nowDate() {
  return new Date();
}

function getSoftDeletePurgeAt(deletedAt, retentionDays = ACCOUNT_DELETION_RETENTION_DAYS) {
  const date = deletedAt instanceof Date ? deletedAt : new Date(deletedAt);
  if (!date || Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}

function isSoftDeleteExpired(deletedAt, now = new Date(), retentionDays = ACCOUNT_DELETION_RETENTION_DAYS) {
  const purgeAt = getSoftDeletePurgeAt(deletedAt, retentionDays);
  if (!purgeAt) return false;
  return purgeAt.getTime() <= now.getTime();
}

async function softDeleteChatForUser(chatId, userId, reason = 'user_deleted_chat') {
  const deletedAt = nowDate();
  const result = await prisma.chat.updateMany({
    where: {
      id: chatId,
      userId,
      isDeleted: false
    },
    data: {
      isDeleted: true,
      deletedAt,
      deletedReason: reason
    }
  });

  return {
    success: result.count > 0,
    affected: result.count
  };
}

async function restoreChatForUser(chatId, userId) {
  const result = await prisma.chat.updateMany({
    where: {
      id: chatId,
      userId,
      isDeleted: true
    },
    data: {
      isDeleted: false,
      deletedAt: null,
      deletedReason: null
    }
  });

  return {
    success: result.count > 0,
    affected: result.count
  };
}

async function softDeleteProChatForUser(clientChatId, userId, reason = 'deleted_by_user') {
  const deletedAt = nowDate();
  const result = await prisma.proChat.updateMany({
    where: {
      userId,
      clientChatId,
      isDeleted: false
    },
    data: {
      isDeleted: true,
      deletedAt,
      deletedReason: reason
    }
  });

  return {
    success: result.count > 0,
    affected: result.count
  };
}

async function restoreProChatForUser(clientChatId, userId) {
  const result = await prisma.proChat.updateMany({
    where: {
      userId,
      clientChatId,
      isDeleted: true
    },
    data: {
      isDeleted: false,
      deletedAt: null,
      deletedReason: null
    }
  });

  return {
    success: result.count > 0,
    affected: result.count
  };
}

async function softDeleteUserAccount(userId, reason = 'account_deleted_by_user') {
  const deletedAt = nowDate();

  const result = await prisma.$transaction(async (tx) => {
    const [user, revokedSessions, chats, proChats, summaries, facts] = await Promise.all([
      tx.user.update({
        where: { id: userId },
        data: {
          isDeleted: true,
          deletedAt,
          deletedReason: reason,
          sessionVersion: { increment: 1 }
        }
      }),
      tx.refreshToken.deleteMany({
        where: { userId }
      }),
      tx.chat.updateMany({
        where: {
          userId,
          isDeleted: false
        },
        data: {
          isDeleted: true,
          deletedAt,
          deletedReason: reason
        }
      }),
      tx.proChat.updateMany({
        where: {
          userId,
          isDeleted: false
        },
        data: {
          isDeleted: true,
          deletedAt,
          deletedReason: reason
        }
      }),
      tx.sessionSummary.updateMany({
        where: {
          userId,
          deletedAt: null
        },
        data: {
          deletedAt
        }
      }),
      tx.userFact.updateMany({
        where: {
          userId,
          deletedAt: null
        },
        data: {
          archived: true,
          deletedAt
        }
      })
    ]);

    await tx.userMemoryProfile.upsert({
      where: { userId },
      create: {
        userId,
        profileJson: '{}',
        isDeleted: true,
        deletedAt
      },
      update: {
        isDeleted: true,
        deletedAt
      }
    });

    return {
      userId: user.id,
      revokedSessions: revokedSessions.count,
      softDeletedChats: chats.count,
      softDeletedProChats: proChats.count,
      softDeletedSummaries: summaries.count,
      softDeletedFacts: facts.count
    };
  });

  return result;
}

async function restoreUserAccount(userId) {
  const result = await prisma.$transaction(async (tx) => {
    const [user, chats, proChats, summaries, facts] = await Promise.all([
      tx.user.update({
        where: { id: userId },
        data: {
          isDeleted: false,
          deletedAt: null,
          deletedReason: null
        }
      }),
      tx.chat.updateMany({
        where: {
          userId,
          isDeleted: true
        },
        data: {
          isDeleted: false,
          deletedAt: null,
          deletedReason: null
        }
      }),
      tx.proChat.updateMany({
        where: {
          userId,
          isDeleted: true
        },
        data: {
          isDeleted: false,
          deletedAt: null,
          deletedReason: null
        }
      }),
      tx.sessionSummary.updateMany({
        where: {
          userId,
          NOT: { deletedAt: null }
        },
        data: {
          deletedAt: null
        }
      }),
      tx.userFact.updateMany({
        where: {
          userId,
          NOT: { deletedAt: null }
        },
        data: {
          deletedAt: null,
          archived: false
        }
      })
    ]);

    await tx.userMemoryProfile.updateMany({
      where: { userId },
      data: {
        isDeleted: false,
        deletedAt: null
      }
    });

    return {
      userId: user.id,
      restoredChats: chats.count,
      restoredProChats: proChats.count,
      restoredSummaries: summaries.count,
      restoredFacts: facts.count
    };
  });

  return result;
}

async function hardDeleteUserAccount(userId) {
  if (!userId) {
    return {
      success: false,
      userDeleted: false
    };
  }

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        role: true,
        isDeleted: true,
        deletedAt: true
      }
    });

    if (!user) {
      return {
        success: false,
        userDeleted: false,
        notFound: true
      };
    }

    if (user.role === 'ADMIN') {
      return {
        success: false,
        userDeleted: false,
        blockedByRole: true,
        role: user.role
      };
    }

    await tx.user.delete({
      where: { id: user.id }
    });

    return {
      success: true,
      userDeleted: true,
      userId: user.id,
      username: user.username,
      wasSoftDeleted: Boolean(user.isDeleted),
      deletedAt: user.deletedAt || null
    };
  });

  return result;
}

async function purgeExpiredSoftDeletedUsers({
  retentionDays = ACCOUNT_DELETION_RETENTION_DAYS,
  limit = 50
} = {}) {
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(200, Number(limit))) : 50;
  const now = new Date();
  const threshold = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const candidates = await prisma.user.findMany({
    where: {
      isDeleted: true,
      deletedAt: { not: null, lte: threshold },
      role: { not: 'ADMIN' }
    },
    select: {
      id: true,
      username: true,
      deletedAt: true
    },
    orderBy: { deletedAt: 'asc' },
    take: safeLimit
  });

  const purgedUsers = [];
  const failedUsers = [];

  for (const candidate of candidates) {
    try {
      const deleted = await hardDeleteUserAccount(candidate.id);
      if (deleted?.success && deleted?.userDeleted) {
        purgedUsers.push({
          id: candidate.id,
          username: candidate.username,
          deletedAt: candidate.deletedAt
        });
      } else {
        failedUsers.push({
          id: candidate.id,
          username: candidate.username,
          reason: deleted?.blockedByRole ? 'ADMIN_ROLE' : 'UNKNOWN'
        });
      }
    } catch (error) {
      failedUsers.push({
        id: candidate.id,
        username: candidate.username,
        reason: error?.message || 'PURGE_ERROR'
      });
    }
  }

  return {
    scanned: candidates.length,
    purged: purgedUsers.length,
    failed: failedUsers.length,
    purgedUsers,
    failedUsers
  };
}

async function purgeChatById(chatId) {
  return prisma.chat.delete({
    where: { id: chatId }
  });
}

async function purgeAnonSessionById(sessionId) {
  return prisma.chatSession.delete({
    where: { id: sessionId }
  });
}

module.exports = {
  ACCOUNT_DELETION_RETENTION_DAYS,
  getSoftDeletePurgeAt,
  isSoftDeleteExpired,
  softDeleteChatForUser,
  restoreChatForUser,
  softDeleteProChatForUser,
  restoreProChatForUser,
  softDeleteUserAccount,
  restoreUserAccount,
  hardDeleteUserAccount,
  purgeExpiredSoftDeletedUsers,
  purgeChatById,
  purgeAnonSessionById
};
