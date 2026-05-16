const { prisma } = require('../config/prisma');

const USER_ID_SEQUENCE_KEY = 'user_id';
const USER_ID_START = 100000000n; // 9-digit start

function isNumericUserId(value) {
  return /^[0-9]+$/.test(`${value || ''}`.trim());
}

function toBigInt(value, fallback = 0n) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value.trim()) {
    try {
      return BigInt(value.trim());
    } catch (_error) {
      return fallback;
    }
  }
  return fallback;
}

async function ensureIdSequenceTable(client) {
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "IdSequence" (
      "key" TEXT NOT NULL PRIMARY KEY,
      "value" BIGINT NOT NULL,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

async function getMaxNumericUserId(client) {
  const rows = await client.$queryRawUnsafe(`
    SELECT MAX(CAST("id" AS INTEGER)) AS "maxId"
    FROM "User"
    WHERE "id" <> ''
      AND "id" NOT GLOB '*[^0-9]*';
  `);

  const maxRaw = Array.isArray(rows) && rows[0] ? rows[0].maxId : null;
  return toBigInt(maxRaw, 0n);
}

async function ensureUserIdSequence(client = prisma) {
  await ensureIdSequenceTable(client);

  const maxExisting = await getMaxNumericUserId(client);
  const minValue = USER_ID_START - 1n;
  const expectedFloor = maxExisting > minValue ? maxExisting : minValue;

  const current = await client.idSequence.findUnique({
    where: { key: USER_ID_SEQUENCE_KEY },
    select: { value: true }
  });

  if (!current) {
    await client.idSequence.create({
      data: {
        key: USER_ID_SEQUENCE_KEY,
        value: expectedFloor
      }
    });
    return;
  }

  const currentValue = toBigInt(current.value, minValue);
  if (currentValue < expectedFloor) {
    await client.idSequence.update({
      where: { key: USER_ID_SEQUENCE_KEY },
      data: { value: expectedFloor }
    });
  }
}

async function allocateNextUserId(client = prisma) {
  await ensureUserIdSequence(client);

  const updated = await client.idSequence.update({
    where: { key: USER_ID_SEQUENCE_KEY },
    data: {
      value: {
        increment: 1n
      }
    },
    select: { value: true }
  });

  return `${updated.value}`;
}

module.exports = {
  USER_ID_START,
  USER_ID_SEQUENCE_KEY,
  isNumericUserId,
  ensureUserIdSequence,
  allocateNextUserId
};
