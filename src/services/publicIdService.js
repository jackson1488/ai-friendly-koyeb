const crypto = require('crypto');

const MIN_PUBLIC_ID_LENGTH = 9;
const MAX_PUBLIC_ID_LENGTH = 11;
const MAX_ALLOCATE_ATTEMPTS = 30;

function randomDigit(min, max) {
  return crypto.randomInt(min, max + 1);
}

function generatePublicIdCandidate() {
  const length = randomDigit(MIN_PUBLIC_ID_LENGTH, MAX_PUBLIC_ID_LENGTH);
  let value = `${randomDigit(1, 9)}`;
  for (let index = 1; index < length; index += 1) {
    value += `${randomDigit(0, 9)}`;
  }
  return value;
}

async function allocatePublicId(client) {
  for (let attempt = 0; attempt < MAX_ALLOCATE_ATTEMPTS; attempt += 1) {
    const candidate = generatePublicIdCandidate();
    const exists = await client.user.findUnique({
      where: { publicId: candidate },
      select: { id: true }
    });
    if (!exists) return candidate;
  }

  throw new Error('Не удалось сгенерировать уникальный publicId');
}

module.exports = {
  MIN_PUBLIC_ID_LENGTH,
  MAX_PUBLIC_ID_LENGTH,
  generatePublicIdCandidate,
  allocatePublicId
};

