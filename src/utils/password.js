const bcrypt = require('bcryptjs');

/**
 * password.js — хэширование и проверка паролей.
 *
 * В базе нельзя хранить обычный пароль текстом.
 * Поэтому при регистрации сохраняется bcrypt hash, а при входе bcrypt сравнивает
 * введённый пароль с этим hash.
 */

async function hashPassword(password) {
  // 12 rounds — нормальный баланс: достаточно безопасно, но не слишком медленно
  // для обычного сервера.
  return bcrypt.hash(password, 12);
}

async function comparePassword(password, hash) {
  // compare сам учитывает salt, который уже зашит внутри bcrypt hash.
  return bcrypt.compare(password, hash);
}

module.exports = { hashPassword, comparePassword };

