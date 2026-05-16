const express = require('express');
const { requireAuth } = require('../middlewares/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const { personalizationImageUpload } = require('../middlewares/uploadMiddleware');
const {
  getMemory,
  deleteMemory,
  removeFact,
  getPersonalizationTest,
  savePersonalizationTest,
  postponePersonalizationTest,
  uploadPersonalizationTestImage
} = require('../controllers/memoryController');

/**
 * memoryRoutes.js — память пользователя и персонализационный тест.
 *
 * Память — это данные, которые Alma использует в следующих чатах.
 * Поэтому routes защищены requireAuth: каждый пользователь работает только со своей
 * памятью и своими ответами теста.
 */
const router = express.Router();

router.use(requireAuth);

// Основная память профиля.
router.get('/memory', asyncHandler(getMemory));
router.delete('/memory', asyncHandler(deleteMemory));
router.delete('/memory/facts/:factId', asyncHandler(removeFact));

// Онбординг/персонализация: получить тест, сохранить ответы, отложить на потом.
router.get('/memory/personalization-test', asyncHandler(getPersonalizationTest));
router.post('/memory/personalization-test', asyncHandler(savePersonalizationTest));
router.post('/memory/personalization-test/later', asyncHandler(postponePersonalizationTest));

// Картинка для вопроса/теста приходит в multipart поле "image".
router.post(
  '/memory/personalization-test/image',
  personalizationImageUpload.single('image'),
  asyncHandler(uploadPersonalizationTestImage)
);

module.exports = { memoryRoutes: router };
