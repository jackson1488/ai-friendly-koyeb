const { prisma } = require('../config/prisma');
const { allocatePublicId } = require('../services/publicIdService');

async function backfillPublicIds() {
  const users = await prisma.user.findMany({
    where: {
      OR: [{ publicId: null }, { publicId: '' }]
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      username: true
    }
  });

  if (!users.length) {
    console.log('[public-id] Nothing to backfill.');
    return { updated: 0 };
  }

  let updated = 0;
  for (const user of users) {
    const publicId = await allocatePublicId(prisma);
    await prisma.user.update({
      where: { id: user.id },
      data: { publicId }
    });
    updated += 1;
    console.log(`[public-id] ${user.username}: ${publicId}`);
  }

  return { updated };
}

async function main() {
  try {
    const result = await backfillPublicIds();
    console.log('[public-id] Done:', JSON.stringify(result));
  } catch (error) {
    console.error('[public-id] Failed:', error?.stack || error?.message || error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();

