const crypto = require('crypto');

/**
 * hashToken — безопасное хранение случайных токенов.
 *
 * Если нужно сохранить token в базе, лучше сохранить не сам token, а sha256 hash.
 * Тогда при утечке базы нельзя сразу использовать оригинальный token.
 */
function hashToken(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

module.exports = { hashToken };

