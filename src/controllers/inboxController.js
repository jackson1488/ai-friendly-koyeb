const { z } = require('zod');
const { logger } = require('../utils/logger');
const {
  createInboxItemByAdmin,
  getInboxFeedForUser,
  getInboxItemForUser,
  updateInboxStateForUser,
  listInboxItemsForAdmin,
  publishInboxItemNow,
  cancelInboxItem
} = require('../services/inboxService');
const { compressConversationToMemory } = require('../services/memoryService');

/**
 * inboxController.js — HTTP-слой для Inbox.
 *
 * Inbox — это внутренняя лента карточек:
 * - тесты;
 * - новости;
 * - системные уведомления.
 *
 * Controller здесь только:
 * - валидирует body/query/params;
 * - вызывает inboxService;
 * - если тест завершён, отправляет ответы в память пользователя.
 */

const inboxStateSchema = z.object({
  state: z.enum(['UNREAD', 'SEEN', 'SKIPPED', 'COMPLETED', 'DISMISSED']),
  progress: z.record(z.any()).optional().default({})
});

const createInboxSchema = z.object({
  type: z.enum(['TEST', 'NEWS', 'SYSTEM']).optional().default('SYSTEM'),
  scope: z.enum(['GLOBAL', 'USER', 'SEGMENT']).optional().default('GLOBAL'),
  status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'CANCELED']).optional(),
  title: z.string().trim().min(1).max(180),
  message: z.string().trim().min(1).max(2000),
  payload: z.record(z.any()).optional().default({}),
  templateKey: z.string().trim().max(120).optional().default(''),
  segmentKey: z.string().trim().max(120).optional().default(''),
  targetUserIds: z.array(z.string().trim().min(1).max(128)).optional().default([]),
  scheduledAt: z.string().trim().optional().nullable(),
  expiresAt: z.string().trim().optional().nullable(),
  publishNow: z.boolean().optional().default(false)
});

function buildInboxTestMemoryMessages(item, progress) {
  // Memory compressor умеет работать с сообщениями формата role/content.
  // Поэтому ответы теста превращаем в одно "псевдо-сообщение пользователя".
  const payload = progress && typeof progress === 'object' && !Array.isArray(progress) ? progress : {};
  const entries = Object.entries(payload).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    return `${value ?? ''}`.trim().length > 0;
  });
  const answersBlock = entries
    .map(([key, value]) => {
      if (Array.isArray(value)) return `${key}: ${value.join(', ')}`;
      if (value && typeof value === 'object') return `${key}: ${JSON.stringify(value)}`;
      return `${key}: ${value}`;
    })
    .join('\n');

  const lines = [
    'Пользователь завершил тест из Inbox.',
    `Название теста: ${item?.title || 'Тест'}.`,
    `Описание: ${item?.message || ''}`.trim()
  ];
  if (answersBlock) {
    lines.push('Ответы пользователя:', answersBlock);
  }

  return [{ role: 'USER', content: lines.filter(Boolean).join('\n') }];
}

async function getInboxFeed(req, res) {
  // Feed поддерживает since/limit: клиент может тянуть только дельту после оффлайна.
  const result = await getInboxFeedForUser(req.user.id, {
    since: req.query?.since || null,
    limit: req.query?.limit || null
  });
  res.json(result);
}

async function getInboxItem(req, res) {
  // Детальная страница карточки: новости, системное уведомление или тест.
  const itemId = `${req.params.itemId || ''}`.trim();
  const item = await getInboxItemForUser(req.user.id, itemId);
  res.json({ item });
}

async function updateInboxState(req, res) {
  // Состояние хранится отдельно на пользователя: один item может быть global,
  // но у каждого пользователя свой progress/seen/completed.
  const payload = inboxStateSchema.parse(req.body || {});
  const itemId = `${req.params.itemId || ''}`.trim();
  const result = await updateInboxStateForUser(req.user.id, itemId, payload);

  if (result?.type === 'TEST' && result?.state === 'COMPLETED') {
    const progressPayload =
      payload?.progress && typeof payload.progress === 'object' && !Array.isArray(payload.progress)
        ? payload.progress
        : {};

    // Завершённый тест должен попасть в память, чтобы Alma учитывала ответы в чатах.
    // Ошибка памяти не должна ломать завершение теста, поэтому catch только логирует.
    await compressConversationToMemory(
      req.user.id,
      buildInboxTestMemoryMessages(result, progressPayload),
      {
        includeSummary: false,
        source: 'inbox_test_completed',
        maxMessages: 12
      }
    ).catch((error) => {
      logger.warn('Inbox test memory sync failed', {
        userId: req.user.id,
        itemId,
        error: error?.message || 'unknown'
      });
    });
  }

  res.json({ success: true, item: result });
}

async function adminListInboxItems(req, res) {
  // Админка смотрит историю/черновики/запланированные карточки.
  const items = await listInboxItemsForAdmin({
    status: req.query?.status || '',
    limit: req.query?.limit || null
  });
  res.json({ items });
}

async function adminCreateInboxItem(req, res) {
  // Создание карточки админом. Service уже решает draft/publish/schedule/delivery.
  const payload = createInboxSchema.parse(req.body || {});
  const item = await createInboxItemByAdmin(req.user.id, payload);
  res.json({ success: true, item });
}

async function adminPublishInboxItem(req, res) {
  // Принудительная публикация существующего item.
  const itemId = `${req.params.itemId || ''}`.trim();
  const item = await publishInboxItemNow(itemId);
  res.json({ success: true, item });
}

async function adminCancelInboxItem(req, res) {
  // Отмена item. Уже доставленные user states при этом не удаляем здесь.
  const itemId = `${req.params.itemId || ''}`.trim();
  const item = await cancelInboxItem(itemId);
  res.json({ success: true, item });
}

module.exports = {
  getInboxFeed,
  getInboxItem,
  updateInboxState,
  adminListInboxItems,
  adminCreateInboxItem,
  adminPublishInboxItem,
  adminCancelInboxItem
};
