const express = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireAuth, requireAdmin } = require('../middlewares/auth');
const { developerPhotoUpload } = require('../middlewares/uploadMiddleware');
const {
  listDevelopers,
  createDeveloper,
  updateDeveloper,
  deleteDeveloper,
  reorderDevelopers,
  getLegalDocument,
  updateLegalDocument,
  listFaq,
  createFaq,
  updateFaq,
  deleteFaq,
  getSupport,
  updateSupport,
  getAppInfo,
  updateAppInfo,
  getAboutSummary
} = require('../controllers/aboutController');

/**
 * aboutRoutes.js — раздел "О приложении".
 *
 * Сервер здесь является источником правды:
 * frontend только читает данные и кеширует их, а редактирование идёт через admin.
 *
 * Обычный пользователь может читать:
 * - summary;
 * - команду;
 * - legal документы;
 * - FAQ;
 * - поддержку;
 * - app info.
 *
 * Только ADMIN может создавать/редактировать/удалять.
 */
const router = express.Router();

router.get('/about/summary', requireAuth, asyncHandler(getAboutSummary));

// Команда разработчиков. Фото приходит как multipart поле "photo".
router.get('/developers', requireAuth, asyncHandler(listDevelopers));
router.post(
  '/developers',
  requireAuth,
  requireAdmin,
  developerPhotoUpload.single('photo'),
  asyncHandler(createDeveloper)
);
router.put(
  '/developers/:id',
  requireAuth,
  requireAdmin,
  developerPhotoUpload.single('photo'),
  asyncHandler(updateDeveloper)
);
router.delete('/developers/:id', requireAuth, requireAdmin, asyncHandler(deleteDeveloper));
router.patch('/developers/reorder', requireAuth, requireAdmin, asyncHandler(reorderDevelopers));

// Юридические документы: privacy / terms.
router.get('/legal/:type', requireAuth, asyncHandler(getLegalDocument));
router.put('/legal/:type', requireAuth, requireAdmin, asyncHandler(updateLegalDocument));

// FAQ: вопросы, ответы, категории и цвета тегов.
router.get('/faq', requireAuth, asyncHandler(listFaq));
router.post('/faq', requireAuth, requireAdmin, asyncHandler(createFaq));
router.put('/faq/:id', requireAuth, requireAdmin, asyncHandler(updateFaq));
router.delete('/faq/:id', requireAuth, requireAdmin, asyncHandler(deleteFaq));

// Поддержка: контакты, статус онлайн/офлайн, среднее время ответа.
router.get('/support', requireAuth, asyncHandler(getSupport));
router.put('/support', requireAuth, requireAdmin, asyncHandler(updateSupport));

// Общая информация о приложении: название, версия, описание, лого, socials.
router.get('/app-info', requireAuth, asyncHandler(getAppInfo));
router.put('/app-info', requireAuth, requireAdmin, asyncHandler(updateAppInfo));

module.exports = { aboutRoutes: router };
