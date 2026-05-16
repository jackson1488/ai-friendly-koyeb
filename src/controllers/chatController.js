const { z } = require('zod');
const { prisma } = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { getIo } = require('../socket/io');
const { userRoom } = require('../socket/rooms');
const { bumpChatGeneration } = require('../socket/chatGeneration');
const { softDeleteChatForUser } = require('../services/deletionService');

/**
 * chatController.js — обычные чаты пользователя.
 *
 * Здесь нет генерации AI ответа. Этот controller отвечает за CRUD чатов и сообщений:
 * - создать чат;
 * - показать список;
 * - показать сообщения;
 * - переименовать;
 * - отредактировать пользовательское сообщение;
 * - soft-delete чат.
 */

const createChatSchema = z.object({
  title: z.string().min(1).max(120).optional()
});

const updateChatSchema = z.object({
  title: z.string().min(1).max(120)
});

const editMessageSchema = z.object({
  content: z.string().min(1).max(4000)
});

function safeTitle(title) {
  // Если title пустой, даём нормальное имя. slice защищает от слишком длинного текста.
  if (!title || !title.trim()) return 'Новый чат';
  return title.trim().slice(0, 120);
}

function toClientRole(role) {
  // В базе роли UPPER_CASE, на клиенте используются lowercase.
  if (role === 'USER') return 'user';
  if (role === 'ASSISTANT') return 'assistant';
  return 'system';
}

function normalizeMessage(message) {
  // Приводим сообщение из Prisma-формата к формату, который ждёт frontend.
  return {
    ...message,
    role: toClientRole(message.role)
  };
}

async function ensureChatOwnedByUser(chatId, userId, { includeDeleted = false } = {}) {
  // Это главная защита от доступа к чужому чату.
  // Любое действие с chatId сначала проходит через эту проверку.
  const chat = await prisma.chat.findFirst({
    where: {
      id: chatId,
      userId,
      ...(includeDeleted ? {} : { isDeleted: false })
    }
  });

  if (!chat) {
    throw new AppError(404, 'Чат не найден');
  }

  return chat;
}

async function createChat(req, res) {
  const data = createChatSchema.parse(req.body || {});

  const chat = await prisma.chat.create({
    data: {
      userId: req.user.id,
      title: safeTitle(data.title)
    }
  });

  res.status(201).json({ chat });
}

async function listChats(req, res) {
  const chats = await prisma.chat.findMany({
    where: {
      userId: req.user.id,
      isDeleted: false,
      // Не показываем пустые черновики в списке чатов пользователя.
      // Чат появляется в списке только после первого USER сообщения.
      messages: {
        some: {
          role: 'USER'
        }
      }
    },
    orderBy: { updatedAt: 'desc' },
    include: {
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1
      }
    }
  });

  const normalizedChats = chats.map((chat) => {
    let lastMessage = null;
    if (chat.messages && chat.messages.length > 0) {
      const msg = chat.messages[0];
      lastMessage = {
        content: msg.content,
        role: toClientRole(msg.role),
        createdAt: msg.createdAt
      };
    }
    const { messages, ...chatWithoutMessages } = chat;
    return {
      ...chatWithoutMessages,
      lastMessage
    };
  });

  res.json({ chats: normalizedChats });
}

async function getChatMessages(req, res) {
  const { id: chatId } = req.params;
  const chat = await ensureChatOwnedByUser(chatId, req.user.id);

  const messages = await prisma.message.findMany({
    where: { chatId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
  });

  // Пустые assistant сообщения не отдаём: они могут появиться как временные draft/stream.
  const normalized = messages
    .filter((message) => !(message.role === 'ASSISTANT' && !message.content.trim()))
    .map(normalizeMessage);

  res.json({ chat, messages: normalized });
}

async function updateChat(req, res) {
  const { id: chatId } = req.params;
  const data = updateChatSchema.parse(req.body || {});
  await ensureChatOwnedByUser(chatId, req.user.id);

  const chat = await prisma.chat.update({
    where: { id: chatId },
    data: {
      title: safeTitle(data.title),
      updatedAt: new Date()
    }
  });

  res.json({ chat });
}

async function editChatMessage(req, res) {
  const { chatId, messageId } = req.params;
  const data = editMessageSchema.parse(req.body || {});
  const nextContent = data.content.trim();

  if (!nextContent) {
    throw new AppError(400, 'Сообщение не может быть пустым');
  }

  await ensureChatOwnedByUser(chatId, req.user.id);

  const orderedMessages = await prisma.message.findMany({
    where: { chatId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      role: true
    }
  });

  const targetIndex = orderedMessages.findIndex((message) => message.id === messageId);
  if (targetIndex === -1) {
    throw new AppError(404, 'Сообщение не найдено');
  }

  const targetMessage = orderedMessages[targetIndex];
  if (targetMessage.role !== 'USER') {
    throw new AppError(400, 'Можно редактировать только сообщения пользователя');
  }

  // Если пользователь редактирует старое сообщение, все ответы после него становятся
  // невалидными. Поэтому удаляем хвост диалога после target message.
  const idsToDelete = orderedMessages.slice(targetIndex + 1).map((message) => message.id);

  const updated = await prisma.$transaction(async (tx) => {
    const updatedMessage = await tx.message.update({
      where: { id: messageId },
      data: { content: nextContent }
    });

    if (idsToDelete.length > 0) {
      await tx.message.deleteMany({
        where: { id: { in: idsToDelete } }
      });
    }

    await tx.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() }
    });

    return updatedMessage;
  });

  // Увеличиваем generation, чтобы текущая streaming-генерация по старому контексту
  // не продолжила писать ответ после редактирования.
  bumpChatGeneration(chatId);

  const io = getIo();
  if (io) {
    // Синхронизируем все устройства пользователя: web, native, второй браузер.
    io.to(userRoom(req.user.id)).emit('chat:messageUpdated', {
      chatId,
      message: normalizeMessage(updated)
    });
    io.to(userRoom(req.user.id)).emit('chat:messagesReset', {
      chatId,
      fromMessageId: messageId,
      removedCount: idsToDelete.length
    });
  }

  res.json({
    success: true,
    message: normalizeMessage(updated),
    removedCount: idsToDelete.length
  });
}

async function deleteChat(req, res) {
  const { id: chatId } = req.params;
  await ensureChatOwnedByUser(chatId, req.user.id);

  // Soft delete: чат скрывается, но данные можно восстановить/почистить позже.
  await softDeleteChatForUser(chatId, req.user.id, 'deleted_by_user');
  res.json({ success: true });
}

module.exports = {
  createChat,
  listChats,
  getChatMessages,
  updateChat,
  editChatMessage,
  deleteChat
};
