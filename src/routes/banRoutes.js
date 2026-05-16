const express = require('express');
const { requireAuth } = require('../middlewares/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const { getMyBan, createAppeal, getMyAppeals } = require('../controllers/banController');

/**
 * banRoutes.js — бан пользователя и апелляции.
 *
 * Пользователь может:
 * - посмотреть свой текущий бан;
 * - отправить appeal;
 * - посмотреть свои appeals.
 */
const router = express.Router();

router.use(requireAuth);

router.get('/bans/me', asyncHandler(getMyBan));
router.post('/appeals', asyncHandler(createAppeal));
router.get('/appeals/me', asyncHandler(getMyAppeals));

module.exports = { banRoutes: router };
