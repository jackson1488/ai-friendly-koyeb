const { prisma } = require('../config/prisma');
const { env } = require('../config/env');
const { defaultSystemPrompt, defaultSafetyPrompt } = require('../config/constants');
const { DEFAULT_MEMORY_SETTINGS, withMemorySettings } = require('./memorySettingsService');
const { DEFAULT_LANGUAGE_POLICY, withLanguagePolicy } = require('./languagePolicyService');
const { DEFAULT_PRO_CONFIG, withProConfig } = require('./proConfigService');
const {
  DEFAULT_ONBOARDING_PERSONALIZATION,
  withOnboardingPersonalizationConfig
} = require('./onboardingPersonalizationService');
const { hashPassword } = require('../utils/password');
const { logger } = require('../utils/logger');
const { allocateNextUserId } = require('./userIdService');
const { allocatePublicId } = require('./publicIdService');
const {
  DEFAULT_PRIVACY_MARKDOWN,
  DEFAULT_TERMS_MARKDOWN,
  DEFAULT_FAQ_ITEMS,
  DEFAULT_SUPPORT_INFO,
  DEFAULT_APP_INFO,
  looksLikePlaceholderMarkdown
} = require('../constants/aboutDefaults');

const aiModesSeed = [
  {
    key: 'listener',
    name: 'Слушатель',
    emoji: '🫂',
    systemPrompt:
      'Режим: СЛУШАТЕЛЬ.\n' +
      'Цель: эмоциональная поддержка и чувство контакта.\n' +
      'Структура ответа: 1) отрази состояние, 2) дай одну мягкую опору, 3) задай один короткий уточняющий вопрос.\n' +
      'Тон спокойный, бережный, без назиданий.\n' +
      'Не перегружай советами и не спорь с переживаниями пользователя.'
  },
  {
    key: 'cbt',
    name: 'CBT-сессия',
    emoji: '🧩',
    systemPrompt:
      'Режим: CBT.\n' +
      'Цель: связать мысль, эмоцию и поведение, затем найти более реалистичный взгляд.\n' +
      'Работай с одной мыслью за раз, коротко и конкретно.\n' +
      'Используй сократические вопросы: «Какие факты за и против?», «Что бы ты сказала близкому человеку?»\n' +
      'Не ставь диагнозы, не обесценивай и не спорь.'
  },
  {
    key: 'crisis',
    name: 'Антикризис',
    emoji: '🆘',
    systemPrompt:
      'Режим: АНТИКРИЗИС.\n' +
      'Короткие, спокойные, устойчивые фразы без лишней информации.\n' +
      'Порядок: сначала стабилизация (дыхание, опора, заземление), затем безопасный следующий шаг.\n' +
      'При риске жизни/самоповреждения обязательно направляй к срочной помощи: 150, 112, 103.\n' +
      'Никаких длинных рассуждений и сложных техник.'
  },
  {
    key: 'motivation',
    name: 'Мотивация',
    emoji: '🔥',
    systemPrompt:
      'Режим: МОТИВАЦИЯ.\n' +
      'Фокус на действии здесь и сейчас: один шаг на 2-10 минут.\n' +
      'Помогай убрать барьеры и выбрать старт с минимальным сопротивлением.\n' +
      'Поддерживай энергию без давления, стыда и обвинений.\n' +
      'Заканчивай вопросом о ближайшем конкретном действии.'
  },
  {
    key: 'meditation',
    name: 'Медитация',
    emoji: '🌿',
    systemPrompt:
      'Режим: МЕДИТАЦИЯ.\n' +
      'Говори медленно, мягко, короткими фразами.\n' +
      'Веди практику пошагово: дыхание, тело, внимание к текущему моменту.\n' +
      'Удерживай ровный ритм и безопасный темп.\n' +
      'Не переходи в анализ проблем, пока идёт практика.'
  },
  {
    key: 'journal',
    name: 'Дневник',
    emoji: '📓',
    systemPrompt:
      'Режим: ДНЕВНИК.\n' +
      'Помоги структурировать день: факт, чувство, вывод, следующий шаг.\n' +
      'Задавай короткие направляющие вопросы без допроса.\n' +
      'Поддерживай ясность и бережный тон, не спорь с переживаниями.\n' +
      'Помогай завершать запись небольшим практичным итогом.'
  }
];

const aiLevelsSeed = [
  {
    key: 'fast',
    name: 'Alma Быстрая',
    emoji: '⚡',
    description: 'Самый быстрый ответ',
    primaryModel: 'arcee-ai/trinity-mini:free',
    fallbackModel: 'openrouter/auto'
  },
  {
    key: 'normal',
    name: 'Alma Обычная',
    emoji: '🟢',
    description: 'Баланс скорости и качества',
    primaryModel: 'qwen/qwen3-next-80b-a3b-instruct:free',
    fallbackModel: 'openrouter/auto'
  },
  {
    key: 'pro',
    name: 'Alma Думающая',
    emoji: '🔵',
    description: 'Более глубокий и вдумчивый ответ',
    primaryModel: 'google/gemma-3-27b-it:free',
    fallbackModel: 'openrouter/auto'
  },
  {
    key: 'ultra',
    name: 'Alma Лучшая',
    emoji: '🟣',
    description: 'Максимальное качество ответа',
    primaryModel: 'qwen/qwen3-next-80b-a3b-instruct:free',
    fallbackModel: 'openrouter/auto'
  }
];

const brokenModelKeys = new Set([
  'tngtech/deepseek-r1t2-chimera:free',
  'mistralai/mistral-7b-instruct:free',
  'meta-llama/llama-3.1-8b-instruct:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'meta-llama/llama-4-maverick:free',
  'google/gemma-3-4b-it:free'
]);

function hasMojibake(value) {
  const text = `${value || ''}`;
  return /(?:Р.|С.){3,}/.test(text) || /\?{3,}/.test(text);
}

function shouldUpgradeSystemPrompt(value) {
  const text = `${value || ''}`.trim().toLowerCase();
  const missesTemplateTokens =
    !text.includes('${memory_block}') ||
    !text.includes('${mood_block}') ||
    !text.includes('${mode_prompt}');

  return (
    !text ||
    hasMojibake(value) ||
    missesTemplateTokens ||
    text.includes('8-800-2000-122')
  );
}

function shouldUpgradeSafetyPrompt(value) {
  const text = `${value || ''}`.trim().toLowerCase();
  const missingCurrentHotline = !text.includes('150');
  return !text || hasMojibake(value) || text.includes('8-800-2000-122') || missingCurrentHotline;
}

function shouldUpgradeModePrompt(value) {
  const text = `${value || ''}`.trim().toLowerCase();
  if (!text) return true;
  if (hasMojibake(value)) return true;
  if (text.includes('8-800-2000-122')) return true;
  if (text.includes('abc: activating event')) return true;
  return !text.includes('режим:');
}

function shouldUpgradeModel(value) {
  const text = `${value || ''}`.trim().toLowerCase();
  if (!text) return true;
  return (
    text === 'openai/gpt-4o-mini' ||
    text === 'openai/gpt-4.1-mini' ||
    brokenModelKeys.has(text)
  );
}

function shouldReplaceLevelModel(value) {
  const text = `${value || ''}`.trim().toLowerCase();
  if (!text) return true;
  return brokenModelKeys.has(text);
}

async function ensureAdminSeed() {
  const existing = await prisma.user.findUnique({ where: { username: 'admin' } });
  if (!existing) {
    const passwordHash = await hashPassword(env.adminSeedPassword);
    const adminUserId = await allocateNextUserId(prisma);
    const adminPublicId = await allocatePublicId(prisma);
    await prisma.user.create({
      data: {
        id: adminUserId,
        publicId: adminPublicId,
        username: 'admin',
        displayName: 'Администратор',
        passwordHash,
        role: 'ADMIN',
        termsAcceptedAt: new Date(),
        termsVersion: env.termsVersion,
        theme: 'dark'
      }
    });
    logger.info('Создан администратор по умолчанию', { username: 'admin' });
  }
}

async function ensureAppConfigSeed() {
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  if (!config) {
    await prisma.appConfig.create({
      data: {
        id: 1,
        systemPrompt: defaultSystemPrompt,
        safetyPrompt: defaultSafetyPrompt,
        openrouterModel: env.openRouterModel,
        openrouterApiKey: env.openRouterApiKey || null,
        featureFlagsJson: JSON.stringify({
          crisisDetection: true,
          moodTracking: true,
          memory: DEFAULT_MEMORY_SETTINGS,
          languagePolicy: DEFAULT_LANGUAGE_POLICY,
          proAssistant: DEFAULT_PRO_CONFIG,
          onboardingPersonalization: DEFAULT_ONBOARDING_PERSONALIZATION
        })
      }
    });
    logger.info('Создана запись AppConfig по умолчанию', { id: 1 });
    return;
  }

  const data = {};

  if (shouldUpgradeSystemPrompt(config.systemPrompt)) {
    data.systemPrompt = defaultSystemPrompt;
  }
  if (shouldUpgradeSafetyPrompt(config.safetyPrompt)) {
    data.safetyPrompt = defaultSafetyPrompt;
  }
  if (shouldUpgradeModel(config.openrouterModel)) {
    data.openrouterModel = env.openRouterModel;
  }
  if (!config.openrouterApiKey && env.openRouterApiKey) {
    data.openrouterApiKey = env.openRouterApiKey;
  }
  const ensuredMemoryFlags = withMemorySettings(config.featureFlagsJson, {});
  const ensuredLanguageFlags = withLanguagePolicy(ensuredMemoryFlags.featureFlagsJson, {});
  const ensuredProFlags = withProConfig(ensuredLanguageFlags.featureFlagsJson, {});
  const ensuredOnboardingFlags = withOnboardingPersonalizationConfig(
    ensuredProFlags.featureFlagsJson,
    {}
  );
  if (ensuredOnboardingFlags.featureFlagsJson !== `${config.featureFlagsJson || ''}`.trim()) {
    data.featureFlagsJson = ensuredOnboardingFlags.featureFlagsJson;
  }

  if (Object.keys(data).length > 0) {
    await prisma.appConfig.update({
      where: { id: 1 },
      data
    });
    logger.info('Обновлены настройки AppConfig по умолчанию', { keys: Object.keys(data) });
  }
}

async function ensureAiModesSeed() {
  for (let index = 0; index < aiModesSeed.length; index += 1) {
    const item = aiModesSeed[index];
    const existing = await prisma.aiMode.findUnique({ where: { key: item.key } });

    if (!existing) {
      await prisma.aiMode.create({
        data: {
          ...item,
          isActive: true,
          sortOrder: index
        }
      });
      continue;
    }

    const data = { sortOrder: index };
    if (hasMojibake(existing.name) || !existing.name) data.name = item.name;
    if (hasMojibake(existing.emoji) || !existing.emoji) data.emoji = item.emoji;
    if (shouldUpgradeModePrompt(existing.systemPrompt)) {
      data.systemPrompt = item.systemPrompt;
    }

    if (Object.keys(data).length > 0) {
      await prisma.aiMode.update({ where: { id: existing.id }, data });
    }
  }
}

async function ensureAiLevelsSeed() {
  for (let index = 0; index < aiLevelsSeed.length; index += 1) {
    const item = aiLevelsSeed[index];
    const existing = await prisma.aiLevel.findUnique({ where: { key: item.key } });

    if (!existing) {
      await prisma.aiLevel.create({
        data: {
          ...item,
          isActive: true,
          sortOrder: index
        }
      });
      continue;
    }

    const data = {
      sortOrder: index,
      name: item.name,
      emoji: item.emoji,
      description: item.description
    };

    if (shouldReplaceLevelModel(existing.primaryModel)) {
      data.primaryModel = item.primaryModel;
    }
    if (shouldReplaceLevelModel(existing.fallbackModel)) {
      data.fallbackModel = item.fallbackModel;
    }
    if (existing.key === 'normal' && normalizeModel(existing.fallbackModel) === 'google/gemma-3-27b-it:free') {
      data.fallbackModel = 'openrouter/auto';
    }

    await prisma.aiLevel.update({ where: { id: existing.id }, data });
  }
}

function normalizeModel(value) {
  return `${value || ''}`.trim().toLowerCase();
}

async function ensureAboutModuleSeed() {
  const [privacyDoc, termsDoc] = await Promise.all([
    prisma.legalDocument.findUnique({ where: { type: 'PRIVACY_POLICY' } }),
    prisma.legalDocument.findUnique({ where: { type: 'TERMS_OF_SERVICE' } })
  ]);

  if (!privacyDoc) {
    await prisma.legalDocument.create({
      data: { type: 'PRIVACY_POLICY', content: DEFAULT_PRIVACY_MARKDOWN }
    });
  } else if (looksLikePlaceholderMarkdown(privacyDoc.content)) {
    await prisma.legalDocument.update({
      where: { id: privacyDoc.id },
      data: { content: DEFAULT_PRIVACY_MARKDOWN }
    });
  }

  if (!termsDoc) {
    await prisma.legalDocument.create({
      data: { type: 'TERMS_OF_SERVICE', content: DEFAULT_TERMS_MARKDOWN }
    });
  } else if (looksLikePlaceholderMarkdown(termsDoc.content)) {
    await prisma.legalDocument.update({
      where: { id: termsDoc.id },
      data: { content: DEFAULT_TERMS_MARKDOWN }
    });
  }

  await prisma.supportInfo.upsert({
    where: { id: 1 },
    create: { ...DEFAULT_SUPPORT_INFO },
    update: {}
  });

  await prisma.appInfo.upsert({
    where: { id: 1 },
    create: { ...DEFAULT_APP_INFO },
    update: {}
  });

  const existingFaq = await prisma.faqItem.findMany({
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }]
  });

  if (!existingFaq.length) {
    await prisma.faqItem.createMany({
      data: DEFAULT_FAQ_ITEMS.map((item, index) => ({
        question: item.question,
        answer: item.answer,
        category: item.category,
        color: item.color,
        order: index
      }))
    });
    return;
  }

  const faqLooksLikeLegacyStub =
    existingFaq.length <= 3 &&
    existingFaq.every((item) => {
      const question = `${item.question || ''}`.trim().toLowerCase();
      return (
        question.includes('как начать работу') ||
        question.includes('где посмотреть историю уведомлений') ||
        question.includes('как связаться с поддержкой')
      );
    });

  if (faqLooksLikeLegacyStub) {
    await prisma.$transaction([
      prisma.faqItem.deleteMany({}),
      prisma.faqItem.createMany({
        data: DEFAULT_FAQ_ITEMS.map((item, index) => ({
          question: item.question,
          answer: item.answer,
          category: item.category,
          color: item.color,
          order: index
        }))
      })
    ]);
  }
}

async function applySqlitePragmas() {
  try {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
    await prisma.$queryRawUnsafe('PRAGMA synchronous = NORMAL;');
  } catch (error) {
    logger.warn('Не удалось применить PRAGMA для SQLite', { error: error.message });
  }
}

async function seedDefaults() {
  await applySqlitePragmas();
  await ensureAdminSeed();
  await ensureAppConfigSeed();
  await ensureAiModesSeed();
  await ensureAiLevelsSeed();
  await ensureAboutModuleSeed();
}

module.exports = { seedDefaults };
