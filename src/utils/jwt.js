const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { env } = require('../config/env');

/**
 * jwt.js — выпуск и проверка токенов.
 *
 * Access token:
 * - короткоживущий;
 * - отправляется клиентом в Authorization header;
 * - нужен почти для каждого API запроса.
 *
 * Refresh token:
 * - живёт дольше;
 * - используется, чтобы получить новый access token;
 * - хранит jti/tokenId, чтобы конкретную сессию можно было удалить из базы.
 */

function signAccessToken(user, options = {}) {
  // sid = id refreshToken-сессии в базе.
  // sv = sessionVersion пользователя. Если sv в токене не совпал с базой,
  // значит админ/система завершили старые сессии.
  const sessionId = options.sessionId || null;
  const sessionVersion =
    Number.isFinite(Number(options.sessionVersion))
      ? Number(options.sessionVersion)
      : Number(user?.sessionVersion || 0);

  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      username: user.username,
      displayName: user.displayName,
      sid: sessionId,
      sv: sessionVersion
    },
    env.jwtSecret,
    { expiresIn: env.jwtAccessExpires }
  );
}

function signRefreshToken(userId) {
  // tokenId кладём и в JWT, и в базу. Так refresh token можно отозвать точечно.
  const tokenId = crypto.randomUUID();
  const token = jwt.sign(
    {
      sub: userId,
      jti: tokenId,
      type: 'refresh'
    },
    env.jwtSecret,
    { expiresIn: `${env.jwtRefreshExpiresDays}d` }
  );
  return { token, tokenId };
}

function verifyToken(token) {
  // jwt.verify бросит ошибку, если подпись неверная или срок истёк.
  return jwt.verify(token, env.jwtSecret);
}

function signAdminPanelToken(user) {
  // Отдельный secret для админ-панели. Это изолирует web-cookie админки
  // от обычных пользовательских API токенов.
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      panel: true
    },
    env.adminPanelSecret,
    { expiresIn: '8h' }
  );
}

function verifyAdminPanelToken(token) {
  // Проверка cookie-токена админки.
  return jwt.verify(token, env.adminPanelSecret);
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyToken,
  signAdminPanelToken,
  verifyAdminPanelToken
};

