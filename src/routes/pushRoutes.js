const express = require('express');
const { requireAuth } = require('../middlewares/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const { registerMyPushEndpoint, unregisterMyPushEndpoint } = require('../controllers/pushController');

/**
 * pushRoutes.js — регистрация push endpoint устройства.
 *
 * Socket работает только когда приложение онлайн.
 * Push endpoint нужен, чтобы сервер мог доставлять inbox/system уведомления,
 * когда приложение закрыто или телефон временно оффлайн.
 */
const router = express.Router();

router.use(requireAuth);

router.post('/push/endpoints/register', asyncHandler(registerMyPushEndpoint));
router.post('/push/endpoints/unregister', asyncHandler(unregisterMyPushEndpoint));

module.exports = { pushRoutes: router };
