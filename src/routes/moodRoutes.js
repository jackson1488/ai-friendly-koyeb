const express = require('express');
const { requireAuth } = require('../middlewares/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const { createMood, listMood } = require('../controllers/moodController');

/**
 * moodRoutes.js — трекинг настроения.
 *
 * Пользователь сохраняет настроение, а Alma потом может учитывать baseline и историю
 * в памяти/контексте.
 */
const router = express.Router();

router.use(requireAuth);

router.post('/mood', asyncHandler(createMood));
router.get('/mood', asyncHandler(listMood));

module.exports = { moodRoutes: router };
