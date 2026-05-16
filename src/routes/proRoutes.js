const express = require('express');
const { requireAuth } = require('../middlewares/auth');
const { loadProState, requireProAccess } = require('../middlewares/proAccess');
const { asyncHandler } = require('../utils/asyncHandler');
const {
  getProAccess,
  listProChats,
  syncProChats,
  createProChatCompletion,
  createProChatCompletionStream,
  analyzeImage,
  generateImage,
  editImage,
  generateVideo,
  getVideoTaskStatus,
  getVoiceRealtimeConfig,
  getVoiceRealtimeWebviewPage,
  createProFileAnalysis,
  createProVoiceMessage
} = require('../controllers/proController');

/**
 * proRoutes.js — весь PRO API.
 *
 * Важный порядок:
 * 1. requireAuth — сначала узнаём пользователя;
 * 2. loadProState — загружаем PRO конфиг и права;
 * 3. requireProAccess — ставим только на routes, где PRO реально нужен.
 *
 * `/pro/access` оставлен без requireProAccess специально: клиент должен уметь
 * спросить "есть ли у меня PRO" даже тогда, когда PRO отобрали.
 */
const router = express.Router();

router.use(requireAuth);
router.use(loadProState);

// Проверка статуса PRO для UI: показывать кнопку, блокировать экран, обновлять state.
router.get('/pro/access', asyncHandler(getProAccess));

// Синхронизация и хранение PRO-чатов.
router.get('/pro/chats', requireProAccess, asyncHandler(listProChats));
router.post('/pro/chats/sync', requireProAccess, asyncHandler(syncProChats));

// Голосовой realtime и голосовое сообщение.
router.get('/pro/voice/realtime-config', requireProAccess, asyncHandler(getVoiceRealtimeConfig));
router.get('/pro/voice/realtime-webview', requireProAccess, asyncHandler(getVoiceRealtimeWebviewPage));
router.post('/pro/voice/message', requireProAccess, asyncHandler(createProVoiceMessage));

// Текстовый PRO чат: обычный JSON ответ и streaming ответ.
router.post('/pro/chat', requireProAccess, asyncHandler(createProChatCompletion));
router.post('/pro/chat/stream', requireProAccess, asyncHandler(createProChatCompletionStream));

// Анализ файлов и медиа-генерация.
router.post('/pro/file/analyze', requireProAccess, asyncHandler(createProFileAnalysis));
router.post('/pro/image/analyze', requireProAccess, asyncHandler(analyzeImage));
router.post('/pro/image/generate', requireProAccess, asyncHandler(generateImage));
router.post('/pro/image/edit', requireProAccess, asyncHandler(editImage));
router.post('/pro/video/generate', requireProAccess, asyncHandler(generateVideo));
router.get('/pro/video/tasks/:taskId', requireProAccess, asyncHandler(getVideoTaskStatus));

module.exports = { proRoutes: router };
