const { z } = require('zod');
const { AppError } = require('../utils/errors');
const { registerPushEndpoint, unregisterPushEndpoint } = require('../services/inboxPushService');

/**
 * pushController.js — регистрация push token устройства.
 *
 * Важно:
 * - socket работает только онлайн;
 * - push token нужен серверу, чтобы доставить уведомление, когда приложение закрыто;
 * - controller только валидирует вход и вызывает inboxPushService.
 */

const pushEndpointSchema = z.object({
  pushToken: z.string().trim().min(8).max(512),
  provider: z.string().trim().max(32).optional().default('expo'),
  platform: z.string().trim().max(32).optional().default('unknown'),
  locale: z.string().trim().max(16).optional().default('ru'),
  timeZone: z.string().trim().max(80).optional().default('Asia/Bishkek')
});

async function registerMyPushEndpoint(req, res) {
  // req.user уже поставил requireAuth. Значит endpoint привязываем к текущему userId.
  const payload = pushEndpointSchema.parse(req.body || {});

  try {
    const endpoint = await registerPushEndpoint(req.user.id, payload);
    res.json({ success: true, endpoint });
  } catch (error) {
    // Ошибки сервиса превращаем в понятный 400, чтобы клиент понял: payload/token плохой.
    throw new AppError(400, error.message || 'Failed to register push endpoint');
  }
}

async function unregisterMyPushEndpoint(req, res) {
  // Удаление endpoint нужно при logout, смене устройства или сбросе push token.
  const payload = pushEndpointSchema.parse(req.body || {});

  try {
    const result = await unregisterPushEndpoint(req.user.id, payload);
    res.json({ success: true, ...result });
  } catch (error) {
    throw new AppError(400, error.message || 'Failed to unregister push endpoint');
  }
}

module.exports = {
  registerMyPushEndpoint,
  unregisterMyPushEndpoint
};
