const express = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireAuth } = require('../middlewares/auth');
const { getModes, getLevels } = require('../controllers/modesController');

/**
 * modesRoutes.js — справочники режимов и уровней.
 *
 * Клиент запрашивает эти данные, чтобы показать пользователю доступные режимы
 * общения и уровни/категории без жёсткого хардкода в приложении.
 */
const router = express.Router();

router.use(requireAuth);

router.get('/modes', asyncHandler(getModes));
router.get('/levels', asyncHandler(getLevels));

module.exports = { modesRoutes: router };
