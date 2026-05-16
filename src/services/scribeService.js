const { prisma } = require('../config/prisma');
const { env } = require('../config/env');
const { logger } = require('../utils/logger');
const { getMemorySettings } = require('./memorySettingsService');
const { getProConfig, resolveProApiKeys } = require('./proConfigService');
const { runChatWithFallback } = require('./proProviderService');
const { buildTierModelCandidates, normalizeTier } = require('../constants/proTextModelPools');

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const SUMMARY_DEDUP_WINDOW_MS = 30 * 60 * 1000;
const SUMMARY_TOPIC_PLACEHOLDERS = new Set([
  'не указанная тема',
  'unspecified topic',
  'unknown topic',
  'n/a'
]);
const SUMMARY_INSIGHT_PLACEHOLDERS = new Set([
  'пока без явного инсайта',
  'no clear insight yet',
  'n/a'
]);
const FACT_CATEGORIES = new Set([
  'loss',
  'trauma',
  'win',
  'fear',
  'person',
  'pet',
  'date',
  'health',
  'allergy',
  'boundary',
  'support',
  'goal'
]);
const EMOTIONAL_WEIGHTS = new Set(['low', 'medium', 'high']);
const QWEN_PREFERRED_SCRIBE_SOURCES = new Set([
  'pro_chat',
  'onboarding_personalization_test',
  'inbox_test_completed',
  'personalization_test'
]);
const WORKING_MODELS_CACHE_TTL_MS = 60 * 1000;
let workingModelsCache = {
  expiresAt: 0,
  models: []
};

function normalizeContent(raw) {
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') return item.text || item.content || '';
        return '';
      })
      .join(' ')
      .trim();
  }
  return '';
}

function extractProviderMessage(rawText) {
  const text = `${rawText || ''}`.trim();
  if (!text) return '';

  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message || parsed?.message || text;
  } catch (_error) {
    return text;
  }
}

function stripMarkdownFences(value) {
  const text = `${value || ''}`.trim();
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function extractJsonFragment(value, expectedType) {
  const text = stripMarkdownFences(value);
  if (!text) return expectedType === 'array' ? '[]' : '{}';

  const opening = expectedType === 'array' ? '[' : '{';
  const closing = expectedType === 'array' ? ']' : '}';
  const start = text.indexOf(opening);
  const end = text.lastIndexOf(closing);

  if (start === -1 || end === -1 || end <= start) return text;
  return text.slice(start, end + 1);
}

function parseJsonPayload(value, expectedType) {
  const fragment = extractJsonFragment(value, expectedType);
  const fallback = expectedType === 'array' ? [] : {};

  try {
    const parsed = JSON.parse(fragment);
    if (expectedType === 'array' && Array.isArray(parsed)) return parsed;
    if (expectedType === 'object' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return fallback;
  } catch (_error) {
    return fallback;
  }
}

function parseObjectValue(value) {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch (_error) {
    return {};
  }
}

function clampMood(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const rounded = Math.round(number);
  return Math.min(10, Math.max(1, rounded));
}

function uniqueStringArray(value, max = 5) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];

  for (const item of value) {
    const next = `${item || ''}`.trim();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    result.push(next);
    if (result.length >= max) break;
  }

  return result;
}

function normalizeSummaryPayload(raw) {
  const discussed = uniqueStringArray(raw.discussed, 5);
  const techniques = uniqueStringArray(raw.techniques, 6);
  const homeworkRaw = `${raw.homework || ''}`.trim();

  return {
    topic: `${raw.topic || ''}`.trim() || 'Не указанная тема',
    mood: clampMood(raw.mood),
    discussed,
    insight: `${raw.insight || ''}`.trim() || 'Пока без явного инсайта',
    techniques,
    homework: homeworkRaw || null
  };
}

function normalizeSummaryTextValue(value) {
  return `${value || ''}`.trim().toLowerCase();
}

function isPlaceholderSummary(summary) {
  if (!summary || typeof summary !== 'object') return true;
  const hasNoSignals =
    summary.mood == null &&
    (!Array.isArray(summary.discussed) || summary.discussed.length === 0) &&
    (!Array.isArray(summary.techniques) || summary.techniques.length === 0) &&
    !`${summary.homework || ''}`.trim();

  if (!hasNoSignals) return false;

  const topic = normalizeSummaryTextValue(summary.topic);
  const insight = normalizeSummaryTextValue(summary.insight);
  const topicLooksPlaceholder = SUMMARY_TOPIC_PLACEHOLDERS.has(topic);
  const insightLooksPlaceholder = SUMMARY_INSIGHT_PLACEHOLDERS.has(insight);

  return topicLooksPlaceholder || insightLooksPlaceholder;
}

function buildSummaryDedupKey(summary) {
  const normalized = normalizeSummaryPayload(summary || {});
  return JSON.stringify({
    topic: `${normalized.topic || ''}`.trim().toLowerCase(),
    mood: normalized.mood == null ? null : Number(normalized.mood),
    discussed: Array.isArray(normalized.discussed)
      ? normalized.discussed.map((item) => `${item || ''}`.trim().toLowerCase())
      : [],
    insight: `${normalized.insight || ''}`.trim().toLowerCase(),
    techniques: Array.isArray(normalized.techniques)
      ? normalized.techniques.map((item) => `${item || ''}`.trim().toLowerCase())
      : [],
    homework: `${normalized.homework || ''}`.trim().toLowerCase() || null
  });
}

async function shouldSkipDuplicateSummary(userId, chatId, summary) {
  const threshold = new Date(Date.now() - SUMMARY_DEDUP_WINDOW_MS);
  const recent = await prisma.sessionSummary.findMany({
    where: {
      userId,
      chatId,
      deletedAt: null,
      createdAt: { gte: threshold }
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 5,
    select: { summary: true }
  });

  if (!recent.length) return false;
  const nextKey = buildSummaryDedupKey(summary);

  for (const row of recent) {
    const parsed = parseJsonPayload(row.summary, 'object');
    const existingSummary = normalizeSummaryPayload(parsed);
    if (buildSummaryDedupKey(existingSummary) === nextKey) {
      return true;
    }
  }

  return false;
}

function normalizeFactItem(raw) {
  const detail = `${raw?.detail || ''}`.trim();
  if (!detail) return null;

  const normalizedDetail = detail.toLowerCase();
  const categoryRaw = `${raw?.category || ''}`.trim().toLowerCase();
  let category = FACT_CATEGORIES.has(categoryRaw) ? categoryRaw : 'person';

  if (/аллерг|анафилакс|anaphyl|allerg/i.test(detail)) category = 'allergy';
  if (/умер|погиб|потер[яьи]|утрат/i.test(normalizedDetail)) category = 'loss';
  if (/больниц|скорая|врач|лекарств|инъекц|приступ/i.test(normalizedDetail)) category = 'health';

  const emotionalRaw = `${raw?.emotionalWeight || ''}`.trim().toLowerCase();
  let emotionalWeight = EMOTIONAL_WEIGHTS.has(emotionalRaw) ? emotionalRaw : 'medium';
  if (category === 'loss' || category === 'allergy' || category === 'trauma') {
    emotionalWeight = 'high';
  }

  const shouldFollowup =
    Boolean(raw?.shouldFollowup) ||
    category === 'loss' ||
    category === 'allergy' ||
    category === 'health' ||
    category === 'trauma' ||
    category === 'fear';

  return {
    category,
    detail: detail.slice(0, 800),
    emotionalWeight,
    shouldFollowup
  };
}

function normalizeProfilePayload(raw) {
  return {
    coreIssues: uniqueStringArray(raw.coreIssues, 10),
    triggers: uniqueStringArray(raw.triggers, 10),
    progress: `${raw.progress || ''}`.trim() || 'Пока без обновлений прогресса',
    preferredMode: `${raw.preferredMode || ''}`.trim() || 'listener',
    importantFacts: uniqueStringArray(raw.importantFacts, 12)
  };
}

function mapRole(role) {
  if (role === 'USER' || role === 'user') return 'Пользователь';
  if (role === 'ASSISTANT' || role === 'assistant') return 'Alma';
  return 'Система';
}

function normalizeRoleForConversation(role) {
  const normalized = `${role || ''}`.trim().toLowerCase();
  if (normalized === 'assistant') return 'ASSISTANT';
  if (normalized === 'system') return 'SYSTEM';
  return 'USER';
}

function normalizeConversationMessages(messages) {
  const source = Array.isArray(messages) ? messages : [];
  const normalized = [];

  for (const row of source) {
    const content = normalizeContent(row?.content);
    if (!content) continue;
    normalized.push({
      role: normalizeRoleForConversation(row?.role),
      content
    });
  }

  return normalized;
}

function normalizeScribeSource(value, fallback = 'default') {
  const source = `${value || ''}`.trim().toLowerCase();
  return source || fallback;
}

function isQwenModel(value) {
  const model = `${value || ''}`.trim().toLowerCase();
  if (!model) return false;
  return model.startsWith('qwen/') || model.startsWith('qwen') || model.startsWith('qwq') || model.startsWith('qvq');
}

function shouldPreferQwenForSource(source) {
  const normalized = normalizeScribeSource(source);
  if (!normalized) return false;
  if (QWEN_PREFERRED_SCRIBE_SOURCES.has(normalized)) return true;
  if (normalized.startsWith('pro_chat')) return true;
  if (normalized.startsWith('personalization_test')) return true;
  return false;
}

async function resolveScribeRuntimeConfig() {
  const config = await prisma.appConfig.findUnique({
    where: { id: 1 },
    select: { openrouterApiKey: true, featureFlagsJson: true }
  });

  const memorySettings = getMemorySettings(config?.featureFlagsJson);
  const preferredScribeModel = `${memorySettings?.scribeModel || ''}`.trim();
  const proConfig = getProConfig(config?.featureFlagsJson);
  const proApiKeys = resolveProApiKeys(proConfig);

  return {
    openRouterApiKey: `${config?.openrouterApiKey || env.openRouterApiKey || ''}`.trim(),
    preferredScribeModel,
    proConfig,
    proApiKeys
  };
}

async function getWorkingScribeModels() {
  if (workingModelsCache.expiresAt > Date.now()) {
    return workingModelsCache.models;
  }

  try {
    const rows = await prisma.availableModel.findMany({
      where: { isWorking: true },
      orderBy: [{ modelId: 'asc' }],
      select: { modelId: true }
    });

    const models = rows
      .map((row) => `${row.modelId || ''}`.trim())
      .filter(Boolean);

    workingModelsCache = {
      expiresAt: Date.now() + WORKING_MODELS_CACHE_TTL_MS,
      models
    };

    return models;
  } catch (error) {
    logger.warn('Scribe: failed to load working model list', { error: error.message });
    return [];
  }
}

function buildOpenRouterScribeModelQueue({ preferredScribeModel, workingModels }) {
  const queue = [];
  const push = (value) => {
    const model = `${value || ''}`.trim();
    if (!model || queue.includes(model)) return;
    queue.push(model);
  };

  const normalizedWorking = Array.isArray(workingModels)
    ? workingModels.map((item) => `${item || ''}`.trim()).filter(Boolean)
    : [];
  const hasWorking = normalizedWorking.length > 0;
  const workingSet = new Set(normalizedWorking);
  const pushIfAllowed = (model, options = {}) => {
    const normalized = `${model || ''}`.trim();
    if (!normalized) return;
    if (isQwenModel(normalized)) return;
    if (normalized !== 'openrouter/auto' && hasWorking && !workingSet.has(normalized)) {
      return;
    }
    if (normalized === 'openrouter/auto' && options.deferAuto) return;
    push(normalized);
  };

  pushIfAllowed(preferredScribeModel, { deferAuto: true });
  pushIfAllowed(env.scribeModel, { deferAuto: true });
  for (const model of env.scribeModelCandidates || []) {
    pushIfAllowed(model, { deferAuto: true });
  }

  if (hasWorking) {
    for (const model of normalizedWorking) {
      pushIfAllowed(model, { deferAuto: true });
    }
  }

  push('openrouter/auto');

  return queue;
}

function normalizeQwenProviderModel(value) {
  let model = `${value || ''}`.trim();
  if (!model) return '';
  if (`${model}`.toLowerCase() === 'openrouter/auto') return '';
  if (model.includes('/')) {
    model = model.slice(model.lastIndexOf('/') + 1);
  }
  model = model.replace(/:.*$/, '').trim();
  if (!model || `${model}`.toLowerCase() === 'auto') return '';
  return model;
}

function buildQwenProviderScribeModelQueue({ proConfig, preferredScribeModel, modelTier }) {
  const queue = [];
  const push = (value) => {
    const normalized = normalizeQwenProviderModel(value);
    if (!normalized || queue.includes(normalized)) return;
    queue.push(normalized);
  };

  const tierCandidates = buildTierModelCandidates(
    normalizeTier(modelTier || 'standard'),
    Array.isArray(proConfig?.textModels) ? proConfig.textModels : []
  );
  for (const model of tierCandidates) {
    if (isQwenModel(model)) push(model);
  }

  if (isQwenModel(preferredScribeModel)) push(preferredScribeModel);
  if (isQwenModel(env.scribeModel)) push(env.scribeModel);
  for (const model of env.scribeModelCandidates || []) {
    if (isQwenModel(model)) push(model);
  }

  push('qwen-plus');
  push('qwen-turbo');

  return queue;
}

function resolveQwenScribeTemperature(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0.7;
  if (!Number.isInteger(numeric)) return numeric;
  if (numeric <= 0) return 0.1;
  if (numeric >= 2) return 1.9;
  return numeric + 0.1;
}

async function runScribeModel(messages, options = {}) {
  const { openRouterApiKey, preferredScribeModel, proConfig, proApiKeys } = await resolveScribeRuntimeConfig();
  const source = normalizeScribeSource(options?.source);
  const modelTier = normalizeTier(options?.modelTier || 'standard');

  if (shouldPreferQwenForSource(source)) {
    const qwenBaseUrl = `${proConfig?.baseUrl || ''}`.trim();
    const qwenModelQueue = buildQwenProviderScribeModelQueue({
      proConfig,
      preferredScribeModel,
      modelTier
    });

    if (!qwenBaseUrl || !Array.isArray(proApiKeys) || !proApiKeys.length || !qwenModelQueue.length) {
      throw new Error('Qwen provider is not configured for scribeService');
    }

    try {
      const qwenTemperature = resolveQwenScribeTemperature(env.scribeTemperature);
      const result = await runChatWithFallback({
        apiKeys: proApiKeys,
        baseUrl: qwenBaseUrl,
        modelCandidates: qwenModelQueue,
        messages,
        temperature: qwenTemperature,
        maxTokens: env.scribeMaxTokens
      });
      const content = normalizeContent(result?.text);
      if (!content) {
        throw new Error('Empty scribe response');
      }
      return content;
    } catch (error) {
      logger.warn('Scribe: qwen provider request failed', {
        source,
        modelCount: qwenModelQueue.length,
        error: error.message
      });
      throw new Error(`Qwen provider error (scribe): ${error?.message || 'no available models'}`);
    }
  }

  if (!openRouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured for scribeService');
  }

  const workingModels = await getWorkingScribeModels();
  const modelQueue = buildOpenRouterScribeModelQueue({
    preferredScribeModel,
    workingModels
  });
  let lastError = null;

  for (const model of modelQueue) {
    try {
      const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openRouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost',
          'X-Title': 'AI Friendly Scribe'
        },
        body: JSON.stringify({
          model,
          stream: false,
          max_tokens: env.scribeMaxTokens,
          temperature: env.scribeTemperature,
          messages
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        const providerMessage = extractProviderMessage(errorText) || response.statusText;
        throw new Error(providerMessage);
      }

      const data = await response.json();
      const content = normalizeContent(data?.choices?.[0]?.message?.content);
      if (!content) {
        throw new Error('Пустой ответ scribe-модели');
      }

      return content;
    } catch (error) {
      lastError = error;
      logger.warn('Scribe: модель недоступна, переключаемся на fallback', {
        source,
        model,
        error: error.message
      });
    }
  }

  throw new Error(`Ошибка OpenRouter (scribe): ${lastError?.message || 'нет доступных моделей'}`);
}

async function summarizeSession(userId, chatId, options = {}) {
  const chatMessages = await prisma.message.findMany({
    where: { chatId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { role: true, content: true, createdAt: true }
  });

  return summarizeConversation(userId, chatMessages, {
    chatId,
    source: options?.source || 'default'
  });
}

async function summarizeConversation(userId, messages, options = {}) {
  const normalizedMessages = normalizeConversationMessages(messages);
  if (!normalizedMessages.length) return null;
  const chatId = `${options?.chatId || ''}`.trim() || null;
  const source = normalizeScribeSource(options?.source);
  const modelTier = normalizeTier(options?.modelTier || 'standard');

  const dialogText = normalizedMessages.map((item) => `[${mapRole(item.role)}] ${item.content}`).join('\n');

  const raw = await runScribeModel([
    {
      role: 'system',
      content:
        'Ты — медицинский секретарь психолога. Сожми эту терапевтическую сессию строго в JSON. Верни ТОЛЬКО JSON без пояснений: { topic: string, mood: number (1-10), discussed: string[] (3-5 пунктов), insight: string, techniques: string[], homework: string | null }. Максимум 150 слов. Только факты.'
    },
    {
      role: 'user',
      content: dialogText
    }
  ], { source, modelTier });

  const parsed = parseJsonPayload(raw, 'object');
  const summary = normalizeSummaryPayload(parsed);
  if (isPlaceholderSummary(summary)) {
    return null;
  }

  const duplicated = await shouldSkipDuplicateSummary(userId, chatId, summary);
  if (duplicated) {
    return null;
  }

  await prisma.sessionSummary.create({
    data: {
      userId,
      chatId,
      summary: JSON.stringify(summary),
      mood: summary.mood,
      topics: JSON.stringify(summary.discussed),
      homework: summary.homework
    }
  });

  return summary;
}

async function extractFacts(userId, messages, options = {}) {
  const prepared = normalizeConversationMessages(messages);
  if (!prepared.length) return [];
  const source = normalizeScribeSource(options?.source);
  const modelTier = normalizeTier(options?.modelTier || 'standard');

  const dialogText = prepared
    .map((item) => `[${mapRole(item.role)}] ${item.content}`)
    .filter(Boolean)
    .join('\n');

  if (!dialogText.trim()) return [];

  const raw = await runScribeModel([
    {
      role: 'system',
      content:
        "Прочитай диалог и извлеки только важные факты о пользователе, которые полезны в следующих сессиях. " +
        "Особенно важны: утраты, травма, страхи, здоровье, аллергии, опасные эпизоды, значимые отношения и границы. " +
        "Категории: loss, trauma, win, fear, person, pet, date, health, allergy, boundary, support, goal. " +
        "Верни ТОЛЬКО JSON массив: [{ category, detail, emotionalWeight:'low|medium|high', shouldFollowup:boolean }]. " +
        "detail должен быть конкретным и коротким (до 20 слов), без воды. " +
        "Не дублируй факты и не выдумывай. Если фактов нет — []"
    },
    {
      role: 'user',
      content: dialogText
    }
  ], { source, modelTier });

  const parsed = parseJsonPayload(raw, 'array');
  const facts = parsed.map(normalizeFactItem).filter(Boolean);
  if (!facts.length) return [];

  const followupDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const persisted = [];

  for (const fact of facts) {
    const existing = await prisma.userFact.findUnique({
      where: {
        userId_detail: {
          userId,
          detail: fact.detail
        }
      },
      select: {
        id: true,
        followupDate: true
      }
    });

    const updated = await prisma.userFact.upsert({
      where: {
        userId_detail: {
          userId,
          detail: fact.detail
        }
      },
      create: {
        userId,
        category: fact.category,
        detail: fact.detail,
        emotionalWeight: fact.emotionalWeight,
        shouldFollowup: fact.shouldFollowup,
        followupDate: fact.shouldFollowup ? followupDate : null,
        archived: false,
        deletedAt: null
      },
      update: {
        category: fact.category,
        emotionalWeight: fact.emotionalWeight,
        shouldFollowup: fact.shouldFollowup,
        archived: false,
        deletedAt: null,
        followupDate: fact.shouldFollowup ? existing?.followupDate || followupDate : null
      }
    });

    persisted.push(updated);
  }

  return persisted;
}

async function classifyMessageImportance(text, options = {}) {
  const payload = `${text || ''}`.trim();
  if (!payload) {
    return { shouldStore: false, impact: 'none', reason: 'empty' };
  }
  const source = normalizeScribeSource(options?.source);
  const modelTier = normalizeTier(options?.modelTier || 'standard');

  const raw = await runScribeModel([
    {
      role: 'system',
      content:
        'Оцени, влияет ли сообщение пользователя на долгосрочную память ассистента. ' +
        'Возвращай ТОЛЬКО JSON: { shouldStore: boolean, impact: "none|low|high", reason: string }. ' +
        'shouldStore=true только если в сообщении есть устойчиво важные данные: ' +
        'личные факты, здоровье, аллергии, утраты, травма, границы, отношения, цели, повторяющиеся проблемы. ' +
        'Приветствия и короткие служебные реплики обычно shouldStore=false.'
    },
    {
      role: 'user',
      content: payload
    }
  ], { source, modelTier });

  const parsed = parseJsonPayload(raw, 'object');
  const impact = ['none', 'low', 'high'].includes(`${parsed.impact || ''}`.toLowerCase())
    ? `${parsed.impact}`.toLowerCase()
    : 'low';
  const shouldStore = Boolean(parsed.shouldStore) || impact === 'high';

  return {
    shouldStore,
    impact,
    reason: `${parsed.reason || ''}`.trim() || 'n/a'
  };
}

async function updateProfile(userId, options = {}) {
  const source = normalizeScribeSource(options?.source);
  const modelTier = normalizeTier(options?.modelTier || 'standard');
  const [recentSummaries, recentFacts, currentProfile] = await Promise.all([
    prisma.sessionSummary.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        summary: true,
        mood: true,
        topics: true,
        homework: true,
        createdAt: true
      }
    }),
    prisma.userFact.findMany({
      where: { userId, archived: false, deletedAt: null },
      orderBy: [{ shouldFollowup: 'desc' }, { updatedAt: 'desc' }],
      take: 20,
      select: {
        category: true,
        detail: true,
        emotionalWeight: true,
        shouldFollowup: true
      }
    }),
    prisma.userMemoryProfile.findUnique({
      where: { userId },
      select: { profileJson: true }
    })
  ]);

  const summariesText = recentSummaries
    .map((item) => {
      const summary = `${item.summary || ''}`.trim();
      const mood = item.mood ?? 'n/a';
      return `[${item.createdAt.toISOString()}] mood=${mood} ${summary}`;
    })
    .join('\n');

  const factsText = recentFacts
    .map((fact) => {
      const followup = fact.shouldFollowup ? 'followup=yes' : 'followup=no';
      return `[${fact.category}|${fact.emotionalWeight}|${followup}] ${fact.detail}`;
    })
    .join('\n');

  const raw = await runScribeModel([
    {
      role: 'system',
      content:
        'Текущий профиль: {current_profile}\n' +
        'Последние сессии: {summaries}\n' +
        'Факты пользователя: {facts}\n' +
        'Обнови профиль: добавь устойчивые паттерны, триггеры, прогресс и критичные факты безопасности (здоровье, аллергии, утраты).\n' +
        'Никакой воды. Верни ТОЛЬКО JSON: { coreIssues: string[], triggers: string[], progress: string, preferredMode: string, importantFacts: string[] }'
    },
    {
      role: 'user',
      content:
        `Текущий профиль: ${currentProfile?.profileJson || '{}'}\n` +
        `Последние сессии:\n${summariesText || '[]'}\n` +
        `Факты пользователя:\n${factsText || '[]'}`
    }
  ], { source, modelTier });

  const parsed = parseJsonPayload(raw, 'object');
  const profile = normalizeProfilePayload(parsed);
  const currentProfileObject = parseObjectValue(currentProfile?.profileJson || '{}');
  const onboardingPersonalization =
    currentProfileObject?.onboardingPersonalization &&
    typeof currentProfileObject.onboardingPersonalization === 'object' &&
    !Array.isArray(currentProfileObject.onboardingPersonalization)
      ? currentProfileObject.onboardingPersonalization
      : null;

  if (onboardingPersonalization) {
    profile.onboardingPersonalization = onboardingPersonalization;
  }

  await prisma.userMemoryProfile.upsert({
    where: { userId },
    create: {
      userId,
      profileJson: JSON.stringify(profile)
    },
    update: {
      profileJson: JSON.stringify(profile)
    }
  });

  return profile;
}

module.exports = {
  summarizeConversation,
  summarizeSession,
  extractFacts,
  updateProfile,
  classifyMessageImportance
};
