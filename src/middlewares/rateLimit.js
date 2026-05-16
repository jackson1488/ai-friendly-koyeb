const rateLimit = require('express-rate-limit');

/**
 * rateLimit.js — простая защита от спама запросами.
 *
 * Это не полноценная анти-DDoS система. Это локальный ограничитель Express:
 * один IP не должен бесконечно бить login/API и грузить сервер.
 */

const authRateLimit = rateLimit({
  // Авторизация чувствительная: пароль можно подбирать.
  // Поэтому лимит жёстче: 40 попыток за 15 минут.
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      message: 'Слишком много попыток авторизации. Попробуйте позже.'
    }
  }
});

const apiRateLimit = rateLimit({
  // Общий API лимит мягче: 120 запросов в минуту.
  // Нужен, чтобы случайный бесконечный loop на клиенте не положил backend.
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      message: 'Слишком много запросов. Снизьте частоту.'
    }
  }
});

module.exports = { authRateLimit, apiRateLimit };
