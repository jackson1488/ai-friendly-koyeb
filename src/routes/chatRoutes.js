const express = require('express');
const { requireAuth } = require('../middlewares/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const {
  createChat,
  listChats,
  getChatMessages,
  updateChat,
  editChatMessage,
  deleteChat
} = require('../controllers/chatController');

/**
 * chatRoutes.js — обычные пользовательские чаты.
 *
 * Это не PRO и не anon-chat. Это основной список обычных чатов пользователя.
 * Все routes ниже защищены requireAuth: чужой человек не должен видеть или менять
 * чужие чаты.
 */
const router = express.Router();

// Один раз вешаем requireAuth на весь router. Всё, что ниже, автоматически защищено.
router.use(requireAuth);

router.post('/chats', asyncHandler(createChat));
router.get('/chats', asyncHandler(listChats));
router.get('/chats/:id/messages', asyncHandler(getChatMessages));
router.patch('/chats/:id', asyncHandler(updateChat));
router.patch('/chats/:chatId/messages/:messageId', asyncHandler(editChatMessage));
router.delete('/chats/:id', asyncHandler(deleteChat));

module.exports = { chatRoutes: router };
