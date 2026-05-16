const express = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const {
  register,
  login,
  refresh,
  logout,
  getMe,
  patchMe,
  patchMyPassword,
  deleteMe
} = require('../controllers/authController');
const { uploadAvatar } = require('../controllers/avatarController');
const { requireAuth } = require('../middlewares/auth');
const { authRateLimit } = require('../middlewares/rateLimit');
const { upload } = require('../middlewares/uploadMiddleware');

/**
 * authRoutes.js — маршруты аккаунта и сессии.
 *
 * Как читать этот файл:
 * router.post('/auth/login', middleware1, middleware2, controller)
 *
 * Значит запрос идёт так:
 * 1. Express поймал URL;
 * 2. middleware проверили лимиты/токен/файл;
 * 3. controller выполняет основную работу;
 * 4. asyncHandler отправит ошибку в общий errorHandler, если controller упал.
 */
const router = express.Router();

// Публичные auth routes. Токен ещё не нужен, но нужен rate limit,
// чтобы login/register/refresh нельзя было бесконечно спамить.
router.post('/auth/register', authRateLimit, asyncHandler(register));
router.post('/auth/login', authRateLimit, asyncHandler(login));
router.post('/auth/refresh', authRateLimit, asyncHandler(refresh));
router.post('/auth/logout', asyncHandler(logout));

// Routes текущего пользователя. Здесь уже нужен JWT, поэтому стоит requireAuth.
router.get('/me', requireAuth, asyncHandler(getMe));
router.patch('/me', requireAuth, asyncHandler(patchMe));
router.patch('/me/password', requireAuth, asyncHandler(patchMyPassword));
router.delete('/me', requireAuth, asyncHandler(deleteMe));

// Аватар приходит как multipart/form-data с полем "avatar".
// upload.single сначала сохраняет файл, потом controller записывает ссылку в профиль.
router.post('/me/avatar', requireAuth, upload.single('avatar'), asyncHandler(uploadAvatar));

module.exports = { authRoutes: router };
