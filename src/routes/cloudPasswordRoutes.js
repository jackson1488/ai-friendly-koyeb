const express = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireAuth } = require('../middlewares/auth');
const {
  getCloudPasswordStatus,
  setCloudPassword,
  verifyCloudPassword,
  deleteCloudPassword
} = require('../controllers/cloudPasswordController');

/**
 * cloudPasswordRoutes.js — облачный пароль пользователя.
 *
 * Это отдельный защитный слой внутри аккаунта: пользователь может поставить,
 * проверить или удалить cloud password.
 */
const router = express.Router();

router.get('/cloud-password/status', requireAuth, asyncHandler(getCloudPasswordStatus));
router.post('/cloud-password/set', requireAuth, asyncHandler(setCloudPassword));
router.post('/cloud-password/verify', requireAuth, asyncHandler(verifyCloudPassword));
router.delete('/cloud-password', requireAuth, asyncHandler(deleteCloudPassword));

module.exports = { cloudPasswordRoutes: router };
