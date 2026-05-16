const { z } = require('zod');
const {
  clearMemory,
  getMemoryForUser,
  deleteMemoryFact,
  getPersonalizationTestForUser,
  savePersonalizationTestForUser,
  postponePersonalizationTestForUser
} = require('../services/memoryService');
const { persistBufferForUser } = require('../utils/mediaStorage');

/**
 * memoryController.js — HTTP-слой для памяти пользователя.
 *
 * Важно разделять:
 * - controller принимает HTTP req/res;
 * - memoryService решает бизнес-логику памяти;
 * - mediaStorage сохраняет картинки на диск.
 */

const personalizationSchema = z.object({
  stressCoping: z.string().trim().min(1).max(120),
  anxietyTriggers: z.array(z.string().trim().min(1).max(120)).min(1).max(6),
  supportStyle: z.string().trim().min(1).max(120),
  baselineMood: z.string().trim().min(1).max(80),
  supportFocus: z.string().trim().min(1).max(120),
  personalNote: z.string().trim().max(1200).optional().default(''),
  imageAttachment: z.string().trim().max(1200).optional().default('')
});

async function getMemory(req, res) {
  // Отдаём всё, что frontend показывает в разделе памяти.
  const data = await getMemoryForUser(req.user.id);
  res.json(data);
}

async function deleteMemory(req, res) {
  // type может быть all/facts/profile и т.п. Конкретную интерпретацию знает service.
  const type = `${req.query.type || 'all'}`.trim().toLowerCase();
  const result = await clearMemory(req.user.id, type);
  res.json({ success: true, ...result });
}

async function removeFact(req, res) {
  // Удаляет один сохранённый факт из памяти пользователя.
  const factId = `${req.params.factId || ''}`.trim();
  const result = await deleteMemoryFact(req.user.id, factId);
  res.json({ success: true, ...result });
}

async function getPersonalizationTest(req, res) {
  // Возвращает текущий тест, прогресс и ответы, если они уже есть.
  const result = await getPersonalizationTestForUser(req.user.id);
  res.json(result);
}

async function savePersonalizationTest(req, res) {
  // Ответы теста валидируем здесь, затем service сохраняет их и обновляет память.
  const payload = personalizationSchema.parse(req.body || {});
  const result = await savePersonalizationTestForUser(req.user.id, payload);
  res.json({ success: true, ...result });
}

async function postponePersonalizationTest(req, res) {
  // Кнопка "Позже": тест не пройден, но пользователь явно отложил его.
  const result = await postponePersonalizationTestForUser(req.user.id);
  res.json({ success: true, ...result });
}

async function uploadPersonalizationTestImage(req, res) {
  // Файл лежит в памяти multer-а, потому что route использует memoryStorage.
  const file = req.file;
  if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length) {
    return res.status(400).json({ error: { message: 'Image file is required' } });
  }

  const normalizedMime = `${file.mimetype || ''}`.trim().toLowerCase();
  if (!normalizedMime.startsWith('image/')) {
    return res.status(400).json({ error: { message: 'Only image uploads are allowed' } });
  }

  const persisted = await persistBufferForUser({
    userId: req.user.id,
    segments: ['personalization-test'],
    prefix: 'note_image',
    mimeType: normalizedMime,
    buffer: file.buffer,
    req
  });

  if (!persisted?.publicUrl) {
    return res.status(500).json({ error: { message: 'Failed to store uploaded image' } });
  }

  return res.json({
    success: true,
    imageUrl: persisted.publicUrl,
    mimeType: persisted.mimeType,
    size: persisted.size
  });
}

module.exports = {
  getMemory,
  deleteMemory,
  removeFact,
  getPersonalizationTest,
  savePersonalizationTest,
  postponePersonalizationTest,
  uploadPersonalizationTestImage
};
