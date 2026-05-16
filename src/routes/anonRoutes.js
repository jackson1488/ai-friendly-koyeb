const express = require('express');
const { requireAuth } = require('../middlewares/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const {
  moderateAnonMessage,
  reportAnonMessage,
  getMyAnonSessions,
  getAnonSessionMessages,
  hideAnonSession,
  restoreAnonSession
} = require('../controllers/anonController');

/**
 * anonRoutes.js — anonymous chat/support history и жалобы.
 *
 * Socket отвечает за realtime-общение.
 * Эти REST routes нужны для истории, скрытия/восстановления сессии и жалоб.
 */
const router = express.Router();

router.use(requireAuth);

router.post('/anon/moderation', asyncHandler(moderateAnonMessage));
router.post('/anon/report', asyncHandler(reportAnonMessage));
router.get('/anon/sessions', asyncHandler(getMyAnonSessions));
router.get('/anon/sessions/:sessionId/messages', asyncHandler(getAnonSessionMessages));
router.delete('/anon/sessions/:sessionId', asyncHandler(hideAnonSession));
router.post('/anon/sessions/:sessionId/restore', asyncHandler(restoreAnonSession));

module.exports = { anonRoutes: router };
