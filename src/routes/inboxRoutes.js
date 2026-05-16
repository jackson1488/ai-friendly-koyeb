const express = require('express');
const { requireAuth } = require('../middlewares/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const { getInboxFeed, getInboxItem, updateInboxState } = require('../controllers/inboxController');

/**
 * inboxRoutes.js — пользовательские уведомления/карточки внутри приложения.
 *
 * Inbox хранит новости, системные карточки, тесты и статусы доставки.
 * Socket может принести карточку сразу, но REST feed нужен для гарантированной
 * синхронизации после оффлайна или перезапуска приложения.
 */
const router = express.Router();

router.use(requireAuth);

router.get('/inbox/feed', asyncHandler(getInboxFeed));
router.get('/inbox/:itemId', asyncHandler(getInboxItem));
router.post('/inbox/:itemId/state', asyncHandler(updateInboxState));

module.exports = { inboxRoutes: router };
