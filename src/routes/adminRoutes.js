const express = require('express');
const { requireAuth, requireAdmin } = require('../middlewares/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const {
  listUsers,
  getUserById,
  getUserChats,
  getChatMessages,
  setUserBlock,
  resetUserPassword,
  deleteUser,
  getConfig,
  patchConfig,
  getAuditLogs,
  getCrisisEvents,
  getUserSessions,
  getUserLoginEvents,
  kickUserSession,
  kickAllUserSessions
} = require('../controllers/adminController');
const {
  listActiveSessions,
  getSessionMessages,
  sendSessionMessage,
  deleteSessionMessage,
  muteSessionUser,
  endSession
} = require('../controllers/adminModerationController');
const { adminResetCloudPassword } = require('../controllers/cloudPasswordController');
const {
  adminListInboxItems,
  adminCreateInboxItem,
  adminPublishInboxItem,
  adminCancelInboxItem
} = require('../controllers/inboxController');

/**
 * adminRoutes.js — JSON API для админских действий.
 *
 * Это не EJS-страницы `/admin`. Это именно API под админку/модерацию.
 * Весь router закрыт сразу двумя проверками:
 * - requireAuth: пользователь должен быть залогинен;
 * - requireAdmin: роль должна быть ADMIN.
 */
const router = express.Router();

router.use(requireAuth, requireAdmin);

// Пользователи, карточка пользователя, чаты, сессии и события входа.
router.get('/admin/users', asyncHandler(listUsers));
router.get('/admin/users/:id', asyncHandler(getUserById));
router.get('/admin/users/:id/chats', asyncHandler(getUserChats));
router.get('/admin/users/:id/sessions', asyncHandler(getUserSessions));
router.get('/admin/users/:id/login-events', asyncHandler(getUserLoginEvents));
router.post('/admin/users/:id/sessions/kick-all', asyncHandler(kickAllUserSessions));
router.post('/admin/users/:id/sessions/:sessionId/kick', asyncHandler(kickUserSession));

// Просмотр сообщений конкретного обычного чата.
router.get('/admin/chats/:chatId/messages', asyncHandler(getChatMessages));

// Управление аккаунтом пользователя: блокировка, пароль, удаление.
router.patch('/admin/users/:id/block', asyncHandler(setUserBlock));
router.patch('/admin/users/:id/password', asyncHandler(resetUserPassword));
router.delete('/admin/users/:id', asyncHandler(deleteUser));

// Глобальная конфигурация приложения и технические журналы.
router.get('/admin/config', asyncHandler(getConfig));
router.patch('/admin/config', asyncHandler(patchConfig));
router.get('/admin/audit', asyncHandler(getAuditLogs));
router.get('/admin/crisis', asyncHandler(getCrisisEvents));

// Модерация активных anonymous support sessions.
router.get('/admin/sessions/active', asyncHandler(listActiveSessions));
router.get('/admin/sessions/:sessionId/messages', asyncHandler(getSessionMessages));
router.post('/admin/sessions/:sessionId/message', asyncHandler(sendSessionMessage));
router.post('/admin/sessions/:sessionId/delete-message', asyncHandler(deleteSessionMessage));
router.post('/admin/sessions/:sessionId/mute', asyncHandler(muteSessionUser));
router.post('/admin/sessions/:sessionId/end', asyncHandler(endSession));

// Cloud password сбрасывается отдельно, потому что это чувствительная функция.
router.post('/admin/reset-cloud-password', asyncHandler(adminResetCloudPassword));

// Inbox рассылки: создать, опубликовать, отменить.
router.get('/admin/inbox/items', asyncHandler(adminListInboxItems));
router.post('/admin/inbox/items', asyncHandler(adminCreateInboxItem));
router.post('/admin/inbox/items/:itemId/publish', asyncHandler(adminPublishInboxItem));
router.post('/admin/inbox/items/:itemId/cancel', asyncHandler(adminCancelInboxItem));

module.exports = { adminApiRoutes: router };
