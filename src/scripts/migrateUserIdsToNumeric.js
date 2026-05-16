const { prisma } = require('../config/prisma');
const { allocateNextUserId, ensureUserIdSequence, isNumericUserId } = require('../services/userIdService');

async function migrateUserIdsToNumeric() {
  await ensureUserIdSequence(prisma);

  const users = await prisma.user.findMany({
    select: {
      id: true,
      username: true,
      createdAt: true
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
  });

  const toMigrate = users.filter((user) => !isNumericUserId(user.id));
  if (!toMigrate.length) {
    console.log('[user-id-migration] Nothing to migrate, all user ids are numeric.');
    return { migrated: 0, skipped: users.length, mappings: [] };
  }

  const mappings = [];
  for (const user of toMigrate) {
    const mapping = await prisma.$transaction(async (tx) => {
      const newId = await allocateNextUserId(tx);
      await tx.user.update({
        where: { id: user.id },
        data: { id: newId }
      });
      return {
        username: user.username,
        oldId: user.id,
        newId
      };
    });

    mappings.push(mapping);
    console.log(`[user-id-migration] ${mapping.username}: ${mapping.oldId} -> ${mapping.newId}`);
  }

  await ensureUserIdSequence(prisma);

  return {
    migrated: mappings.length,
    skipped: users.length - mappings.length,
    mappings
  };
}

async function main() {
  try {
    const result = await migrateUserIdsToNumeric();
    console.log('[user-id-migration] Done:', JSON.stringify({
      migrated: result.migrated,
      skipped: result.skipped
    }));
  } catch (error) {
    console.error('[user-id-migration] Failed:', error?.stack || error?.message || error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
