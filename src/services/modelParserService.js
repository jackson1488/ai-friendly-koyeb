const { prisma } = require('../config/prisma');
const { env } = require('../config/env');
const { logger } = require('../utils/logger');

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';

function getOpenRouterApiKey() {
  const apiKey = `${env.openRouterApiKey || ''}`.trim();
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY не настроен');
  }
  return apiKey;
}

function normalizeProviderMessage(rawText) {
  const text = `${rawText || ''}`.trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message || parsed?.message || text;
  } catch (_error) {
    return text;
  }
}

async function parseModels() {
  const apiKey = getOpenRouterApiKey();

  const response = await fetch(OPENROUTER_MODELS_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  if (!response.ok) {
    const details = normalizeProviderMessage(await response.text()) || response.statusText;
    throw new Error(`Не удалось получить список моделей OpenRouter: ${details}`);
  }

  const payload = await response.json();
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const freeModels = rows.filter((item) => `${item?.id || ''}`.trim().endsWith(':free'));

  const now = new Date();
  const modelIds = freeModels.map((item) => `${item.id}`.trim()).filter(Boolean);

  const existingRows = await prisma.availableModel.findMany({
    where: {
      modelId: {
        in: modelIds.length ? modelIds : ['__none__']
      }
    },
    select: { modelId: true }
  });

  const existingSet = new Set(existingRows.map((item) => item.modelId));
  let added = 0;

  for (const model of freeModels) {
    const modelId = `${model.id || ''}`.trim();
    if (!modelId) continue;
    if (!existingSet.has(modelId)) added += 1;

    await prisma.availableModel.upsert({
      where: { modelId },
      create: {
        modelId,
        name: `${model.name || modelId}`.trim(),
        isFree: true,
        isWorking: true, // Изначальный статус
        updatedAt: now
      },
      update: {
        name: `${model.name || modelId}`.trim(),
        isFree: true,
        // Мы НЕ ПЕРЕЗАПИСЫВАЕМ isWorking, responseMs, lastTested
        updatedAt: now
      }
    });
  }

  // Больше не сбрасываем статус других моделей пачкой, чтобы не портить тесты
  const markedNotWorking = { count: 0 };

  logger.info('Парсер моделей OpenRouter выполнен', {
    found: freeModels.length,
    added,
    removed: markedNotWorking.count
  });

  return {
    found: freeModels.length,
    added,
    removed: markedNotWorking.count
  };
}

async function testModel(modelId) {
  const normalizedModelId = `${modelId || ''}`.trim();
  if (!normalizedModelId) {
    throw new Error('modelId обязателен для теста модели');
  }

  const apiKey = getOpenRouterApiKey();
  const startedAt = Date.now();
  const now = new Date();

  try {
    const response = await fetch(OPENROUTER_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost',
        'X-Title': 'AI Friendly Model Tester'
      },
      body: JSON.stringify({
        model: normalizedModelId,
        stream: false,
        messages: [{ role: 'user', content: 'Привет' }]
      })
    });

    if (!response.ok) {
      const details = normalizeProviderMessage(await response.text()) || response.statusText;
      throw new Error(details);
    }

    const responseMs = Date.now() - startedAt;
    const existing = await prisma.availableModel.findUnique({
      where: { modelId: normalizedModelId },
      select: { name: true }
    });

    await prisma.availableModel.upsert({
      where: { modelId: normalizedModelId },
      create: {
        modelId: normalizedModelId,
        name: existing?.name || normalizedModelId,
        isFree: normalizedModelId.endsWith(':free'),
        isWorking: true,
        responseMs,
        lastTested: now,
        updatedAt: now
      },
      update: {
        isWorking: true,
        responseMs,
        lastTested: now,
        updatedAt: now
      }
    });

    return { ok: true, responseMs };
  } catch (error) {
    const existing = await prisma.availableModel.findUnique({
      where: { modelId: normalizedModelId },
      select: { name: true }
    });

    await prisma.availableModel.upsert({
      where: { modelId: normalizedModelId },
      create: {
        modelId: normalizedModelId,
        name: existing?.name || normalizedModelId,
        isFree: normalizedModelId.endsWith(':free'),
        isWorking: false,
        lastTested: now,
        updatedAt: now
      },
      update: {
        isWorking: false,
        lastTested: now,
        updatedAt: now
      }
    });

    logger.warn('Тест модели завершился ошибкой', {
      modelId: normalizedModelId,
      error: error.message
    });

    return { ok: false, error: error.message };
  }
}

module.exports = {
  parseModels,
  testModel
};

