const { prisma } = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { logger } = require('../utils/logger');
const { getMemorySettings } = require('./memorySettingsService');
const { summarizeConversation, summarizeSession, extractFacts, updateProfile } = require('./scribeService');
const { getOnboardingPersonalizationConfig } = require('./onboardingPersonalizationService');
const SUMMARY_DISABLED_SOURCES = new Set([
  'inbox_test_completed',
  'onboarding_personalization_test',
  'pro_chat_sync'
]);

function safeJsonParse(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function normalizeTextValue(value, maxLength = 200) {
  return `${value || ''}`.trim().slice(0, maxLength);
}

function normalizeUniqueTextList(list, maxItems = 6, maxLength = 120) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const normalized = [];

  for (const item of list) {
    const next = normalizeTextValue(item, maxLength);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    normalized.push(next);
    if (normalized.length >= maxItems) break;
  }

  return normalized;
}

function countWords(value) {
  return `${value || ''}`
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function limitWords(value, maxWords) {
  const words = `${value || ''}`
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length <= maxWords) return words.join(' ');
  return `${words.slice(0, maxWords).join(' ')}…`;
}

function stringifyProfile(profileJson) {
  if (!profileJson) return '';
  const profileObject = safeJsonParse(profileJson, null);
  if (!profileObject || typeof profileObject !== 'object') return limitWords(profileJson, 200);
  return limitWords(JSON.stringify(profileObject), 200);
}

function formatSummaryForPrompt(summaryRow) {
  const parsed = safeJsonParse(summaryRow?.summary, null);
  if (parsed && typeof parsed === 'object') {
    return JSON.stringify(parsed);
  }

  const fallback = `${summaryRow?.summary || ''}`.trim();
  return fallback;
}

function normalizeSummaryOutput(row) {
  const parsedSummary = safeJsonParse(row.summary, row.summary);
  const parsedTopics = safeJsonParse(row.topics, []);

  return {
    id: row.id,
    userId: row.userId,
    chatId: row.chatId,
    summary: parsedSummary,
    mood: row.mood,
    topics: Array.isArray(parsedTopics) ? parsedTopics : [],
    homework: row.homework,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

async function getMemoryContext(userId, _chatId, options = {}) {
  const maxProfileWords = Number.isFinite(Number(options.maxProfileWords))
    ? Math.max(80, Math.min(500, Number(options.maxProfileWords)))
    : 200;
  const maxSummaryWords = Number.isFinite(Number(options.maxSummaryWords))
    ? Math.max(120, Math.min(800, Number(options.maxSummaryWords)))
    : 300;
  const maxPendingFacts = Number.isFinite(Number(options.maxPendingFacts))
    ? Math.max(5, Math.min(100, Number(options.maxPendingFacts)))
    : 30;
  const summaryTake = Number.isFinite(Number(options.summaryTake))
    ? Math.max(1, Math.min(8, Number(options.summaryTake)))
    : 3;

  const [profileRow, summariesRows, pendingFactsRows] = await Promise.all([
    prisma.userMemoryProfile.findUnique({
      where: { userId },
      select: { profileJson: true, isDeleted: true }
    }),
    prisma.sessionSummary.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: summaryTake,
      select: {
        id: true,
        summary: true,
        createdAt: true
      }
    }),
    prisma.userFact.findMany({
      where: {
        userId,
        archived: false,
        deletedAt: null
      },
      orderBy: [{ shouldFollowup: 'desc' }, { updatedAt: 'desc' }],
      take: maxPendingFacts,
      select: {
        id: true,
        category: true,
        detail: true,
        emotionalWeight: true,
        shouldFollowup: true,
        followupDate: true
      }
    })
  ]);

  const profile = profileRow?.isDeleted
    ? ''
    : limitWords(stringifyProfile(profileRow?.profileJson || ''), maxProfileWords);

  let remainingWords = maxSummaryWords;
  const recentSummaries = [];
  for (const row of summariesRows) {
    const plain = formatSummaryForPrompt(row);
    if (!plain) continue;
    const clipped = limitWords(plain, Math.min(120, remainingWords));
    const used = countWords(clipped);
    if (!used) continue;
    remainingWords = Math.max(0, remainingWords - used);
    recentSummaries.push({
      id: row.id,
      summary: clipped,
      createdAt: row.createdAt
    });
    if (remainingWords <= 0) break;
  }

  const pendingFacts = pendingFactsRows.map((fact) => ({
    id: fact.id,
    category: fact.category,
    detail: fact.detail,
    emotionalWeight: fact.emotionalWeight,
    shouldFollowup: fact.shouldFollowup,
    followupDate: fact.followupDate
  }));

  if (!profile && !recentSummaries.length && !pendingFacts.length) {
    return {};
  }

  return {
    profile,
    recentSummaries,
    pendingFacts
  };
}

async function clearMemory(userId, type) {
  const mode = `${type || 'all'}`.trim().toLowerCase();
  const deletedAt = new Date();

  if (!['all', 'profile', 'old'].includes(mode)) {
    throw new AppError(400, 'Некорректный тип очистки памяти');
  }

  if (mode === 'profile') {
    await prisma.userMemoryProfile.upsert({
      where: { userId },
      create: {
        userId,
        profileJson: '{}',
        isDeleted: true,
        deletedAt
      },
      update: {
        isDeleted: true,
        deletedAt
      }
    });
    return { type: mode };
  }

  if (mode === 'old') {
    const olderThan = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const removed = await prisma.sessionSummary.updateMany({
      where: {
        userId,
        deletedAt: null,
        createdAt: {
          lt: olderThan
        }
      },
      data: {
        deletedAt
      }
    });
    return { type: mode, deletedSummaries: removed.count };
  }

  const result = await prisma.$transaction(async (tx) => {
    const [summaries, facts] = await Promise.all([
      tx.sessionSummary.updateMany({
        where: { userId, deletedAt: null },
        data: { deletedAt }
      }),
      tx.userFact.updateMany({
        where: { userId, deletedAt: null },
        data: { archived: true, deletedAt }
      })
    ]);

    await tx.userMemoryProfile.upsert({
      where: { userId },
      create: {
        userId,
        profileJson: '{}',
        isDeleted: true,
        deletedAt
      },
      update: {
        isDeleted: true,
        deletedAt
      }
    });

    return {
      type: mode,
      deletedSummaries: summaries.count,
      deletedFacts: facts.count
    };
  });

  return result;
}

async function restoreMemory(userId, type = 'all') {
  const mode = `${type || 'all'}`.trim().toLowerCase();
  if (!['all', 'profile'].includes(mode)) {
    throw new AppError(400, 'Некорректный тип восстановления памяти');
  }

  if (mode === 'profile') {
    const restored = await prisma.userMemoryProfile.updateMany({
      where: { userId },
      data: {
        isDeleted: false,
        deletedAt: null
      }
    });

    return {
      type: mode,
      restoredProfiles: restored.count
    };
  }

  const result = await prisma.$transaction(async (tx) => {
    const [profile, summaries, facts] = await Promise.all([
      tx.userMemoryProfile.updateMany({
        where: { userId },
        data: {
          isDeleted: false,
          deletedAt: null
        }
      }),
      tx.sessionSummary.updateMany({
        where: {
          userId,
          NOT: { deletedAt: null }
        },
        data: {
          deletedAt: null
        }
      }),
      tx.userFact.updateMany({
        where: {
          userId,
          NOT: { deletedAt: null }
        },
        data: {
          deletedAt: null,
          archived: false
        }
      })
    ]);

    return {
      type: mode,
      restoredProfiles: profile.count,
      restoredSummaries: summaries.count,
      restoredFacts: facts.count
    };
  });

  return result;
}

async function rebuildMemoryForUser(userId) {
  const config = await prisma.appConfig.findUnique({
    where: { id: 1 },
    select: { featureFlagsJson: true }
  });
  const memorySettings = getMemorySettings(config?.featureFlagsJson);

  const chats = await prisma.chat.findMany({
    where: {
      userId,
      isDeleted: false
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true }
  });

  const reset = await clearMemory(userId, 'all');
  const report = {
    reset,
    analyzedChats: 0,
    summariesCreated: 0,
    factsUpdatedInChats: 0,
    errors: []
  };

  for (const chat of chats) {
    const messages = await prisma.message.findMany({
      where: { chatId: chat.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { role: true, content: true }
    });

    if (!messages.length) continue;
    report.analyzedChats += 1;

    const factsWindow = Number(memorySettings?.factsWindowMessages || 60);
    const messagesForFacts = factsWindow > 0 ? messages.slice(-factsWindow) : messages;

    try {
      await summarizeSession(userId, chat.id, {
        source: 'memory_rebuild'
      });
      report.summariesCreated += 1;
    } catch (error) {
      report.errors.push({
        chatId: chat.id,
        stage: 'summary',
        error: error.message
      });
    }

    try {
      await extractFacts(userId, messagesForFacts, {
        source: 'memory_rebuild'
      });
      report.factsUpdatedInChats += 1;
    } catch (error) {
      report.errors.push({
        chatId: chat.id,
        stage: 'facts',
        error: error.message
      });
    }
  }

  try {
    await updateProfile(userId, {
      source: 'memory_rebuild'
    });
  } catch (error) {
    report.errors.push({
      chatId: null,
      stage: 'profile',
      error: error.message
    });
  }

  report.ok = report.errors.length === 0;
  return report;
}

async function getMemoryForUser(userId) {
  const [profileRow, summariesRows, factsRows] = await Promise.all([
    prisma.userMemoryProfile.findUnique({
      where: { userId },
      select: { profileJson: true, isDeleted: true, createdAt: true, updatedAt: true }
    }),
    prisma.sessionSummary.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 10
    }),
    prisma.userFact.findMany({
      where: {
        userId,
        archived: false,
        deletedAt: null
      },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }]
    })
  ]);

  return {
    profile: profileRow?.isDeleted ? {} : safeJsonParse(profileRow?.profileJson || '{}', {}),
    summaries: summariesRows.map(normalizeSummaryOutput),
    facts: factsRows
  };
}

async function deleteMemoryFact(userId, factId) {
  const deletedAt = new Date();
  const deleted = await prisma.userFact.updateMany({
    where: {
      id: factId,
      userId,
      deletedAt: null
    },
    data: {
      archived: true,
      deletedAt
    }
  });

  if (!deleted.count) {
    throw new AppError(404, 'Факт памяти не найден');
  }

  return { deleted: true, id: factId };
}

function getOnboardingStateFromProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const source =
    profile.onboardingPersonalization &&
    typeof profile.onboardingPersonalization === 'object' &&
    !Array.isArray(profile.onboardingPersonalization)
      ? profile.onboardingPersonalization
      : null;

  return source || null;
}

function normalizeCampaignVersion(value, fallback = 0) {
  const number = Number.parseInt(`${value ?? ''}`.trim(), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(99999, number));
}

function getPersonalizationAnswersFromProfile(profile, onboardingOverride = null) {
  const source =
    onboardingOverride && typeof onboardingOverride === 'object' && !Array.isArray(onboardingOverride)
      ? onboardingOverride
      : getOnboardingStateFromProfile(profile);

  if (!source) return null;

  return {
    stressCoping: normalizeTextValue(source.stressCoping, 120),
    anxietyTriggers: normalizeUniqueTextList(source.anxietyTriggers, 6, 120),
    supportStyle: normalizeTextValue(source.supportStyle, 120),
    baselineMood: normalizeTextValue(source.baselineMood, 80),
    supportFocus: normalizeTextValue(source.supportFocus, 120),
    personalNote: normalizeTextValue(source.personalNote, 1200),
    imageAttachment: normalizeTextValue(source.imageAttachment, 1200)
  };
}

function normalizePersonalizationPayload(payload = {}) {
  return {
    stressCoping: normalizeTextValue(payload.stressCoping, 120),
    anxietyTriggers: normalizeUniqueTextList(payload.anxietyTriggers, 6, 120),
    supportStyle: normalizeTextValue(payload.supportStyle, 120),
    baselineMood: normalizeTextValue(payload.baselineMood, 80),
    supportFocus: normalizeTextValue(payload.supportFocus, 120),
    personalNote: normalizeTextValue(payload.personalNote, 1200),
    imageAttachment: normalizeTextValue(payload.imageAttachment, 1200)
  };
}

function normalizeConversationRole(role) {
  const normalized = `${role || ''}`.trim().toLowerCase();
  if (normalized === 'assistant') return 'ASSISTANT';
  if (normalized === 'system') return 'SYSTEM';
  return 'USER';
}

function normalizeConversationContent(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        if (typeof item.text === 'string') return item.text;
        if (typeof item.content === 'string') return item.content;
        if (typeof item.transcript === 'string') return item.transcript;
        if (item.type === 'image_url') return '[image]';
        if (item.type === 'audio') return '[audio]';
        if (item.type === 'video') return '[video]';
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim();
    if (typeof value.content === 'string') return value.content.trim();
    if (typeof value.transcript === 'string') return value.transcript.trim();
  }
  return '';
}

function normalizeConversationMessages(messages, maxMessages = 40) {
  const source = Array.isArray(messages) ? messages : [];
  const normalized = [];

  for (const item of source) {
    const content = normalizeConversationContent(item?.content);
    if (!content) continue;
    normalized.push({
      role: normalizeConversationRole(item?.role),
      content
    });
  }

  if (!normalized.length) return [];
  const safeLimit = Math.max(4, Math.min(120, Number(maxMessages) || 40));
  if (normalized.length <= safeLimit) return normalized;
  return normalized.slice(-safeLimit);
}

function buildPersonalizationMemoryMessages(answers) {
  const triggers = Array.isArray(answers?.anxietyTriggers) ? answers.anxietyTriggers.filter(Boolean) : [];
  const lines = [
    'Пользователь завершил персонализирующий тест.',
    `Как справляется со стрессом: ${answers?.stressCoping || 'не указано'}.`,
    `Триггеры тревоги: ${triggers.length ? triggers.join(', ') : 'не указаны'}.`,
    `Предпочитаемый стиль поддержки: ${answers?.supportStyle || 'не указан'}.`,
    `Базовое настроение: ${answers?.baselineMood || 'не указано'}.`,
    `Фокус поддержки: ${answers?.supportFocus || 'не указан'}.`
  ];

  const note = `${answers?.personalNote || ''}`.trim();
  if (note) {
    lines.push(`Личная заметка пользователя: ${note}`);
  }

  const imageAttachment = `${answers?.imageAttachment || ''}`.trim();
  if (imageAttachment) {
    lines.push(`Вложение пользователя для контекста: ${imageAttachment}`);
  }

  return [{ role: 'USER', content: lines.join('\n') }];
}

async function compressConversationToMemory(userId, messages, options = {}) {
  const normalized = normalizeConversationMessages(messages, options.maxMessages || 40);
  if (!normalized.length) {
    return { summarized: false, factsCount: 0, profileUpdated: false };
  }
  const source = `${options.source || 'default'}`.trim().toLowerCase();
  const modelTier = `${options.modelTier || 'standard'}`.trim().toLowerCase();

  let summarized = false;
  let factsCount = 0;
  let profileUpdated = false;
  const canIncludeSummary =
    options.includeSummary !== false && !SUMMARY_DISABLED_SOURCES.has(source);

  if (canIncludeSummary) {
    try {
      const summary = await summarizeConversation(userId, normalized, {
        chatId: options.chatId || null,
        source: source || 'default',
        modelTier
      });
      summarized = Boolean(summary);
    } catch (error) {
      logger.warn('Memory compression: summary failed', {
        userId,
        source: source || 'unknown',
        error: error?.message || 'unknown'
      });
    }
  }

  try {
    const facts = await extractFacts(userId, normalized, {
      source: source || 'default',
      modelTier
    });
    factsCount = Array.isArray(facts) ? facts.length : 0;
  } catch (error) {
    logger.warn('Memory compression: fact extraction failed', {
      userId,
      source: source || 'unknown',
      error: error?.message || 'unknown'
    });
  }

  try {
    await updateProfile(userId, {
      source: source || 'default',
      modelTier
    });
    profileUpdated = true;
  } catch (error) {
    logger.warn('Memory compression: profile update failed', {
      userId,
      source: source || 'unknown',
      error: error?.message || 'unknown'
    });
  }

  return { summarized, factsCount, profileUpdated };
}

function buildPersonalizationStatus({ campaign, onboarding, answers }) {
  const campaignVersion = normalizeCampaignVersion(campaign?.campaignVersion, 1) || 1;
  const completedVersion = normalizeCampaignVersion(
    onboarding?.completedVersion,
    onboarding?.completedAt ? 1 : 0
  );
  const dismissedVersion = normalizeCampaignVersion(onboarding?.dismissedVersion, 0);

  const completed = Boolean(onboarding?.completedAt) && completedVersion >= campaignVersion;
  const pending = Boolean(campaign?.enabled) && !completed;
  const showFullscreenPrompt = pending && dismissedVersion < campaignVersion;
  const showListReminder = pending && dismissedVersion >= campaignVersion;

  return {
    pending,
    completed,
    showFullscreenPrompt,
    showListReminder,
    campaign: {
      enabled: Boolean(campaign?.enabled),
      campaignVersion,
      alertTitle: `${campaign?.alertTitle || ''}`.trim(),
      alertMessage: `${campaign?.alertMessage || ''}`.trim(),
      startButtonLabel: `${campaign?.startButtonLabel || ''}`.trim(),
      laterButtonLabel: `${campaign?.laterButtonLabel || ''}`.trim(),
      listHintText: `${campaign?.listHintText || ''}`.trim(),
      testCard:
        campaign?.testCard && typeof campaign.testCard === 'object'
          ? campaign.testCard
          : null,
      testQuestions: Array.isArray(campaign?.testQuestions) ? campaign.testQuestions : []
    },
    invitedAt: onboarding?.invitedAt || null,
    dismissedAt: onboarding?.dismissedAt || null,
    completedAt: onboarding?.completedAt || null,
    completedVersion,
    dismissedVersion,
    answers: answers || null
  };
}

async function loadPersonalizationContext(userId) {
  const [profileRow, configRow] = await Promise.all([
    prisma.userMemoryProfile.findUnique({
      where: { userId },
      select: { profileJson: true, isDeleted: true }
    }),
    prisma.appConfig.findUnique({
      where: { id: 1 },
      select: { featureFlagsJson: true }
    })
  ]);

  const profile =
    profileRow && !profileRow.isDeleted ? safeJsonParse(profileRow.profileJson || '{}', {}) : {};
  const onboarding = getOnboardingStateFromProfile(profile) || {};
  const campaign = getOnboardingPersonalizationConfig(configRow?.featureFlagsJson || '{}');

  return {
    profile,
    onboarding,
    campaign
  };
}

async function persistOnboardingState(userId, profile, onboardingPatch) {
  const safeProfile =
    profile && typeof profile === 'object' && !Array.isArray(profile) ? { ...profile } : {};
  const previous = getOnboardingStateFromProfile(safeProfile) || {};
  const nextOnboarding = {
    ...previous,
    ...(onboardingPatch && typeof onboardingPatch === 'object' && !Array.isArray(onboardingPatch)
      ? onboardingPatch
      : {})
  };

  const nextProfile = {
    ...safeProfile,
    onboardingPersonalization: nextOnboarding
  };

  await prisma.userMemoryProfile.upsert({
    where: { userId },
    create: {
      userId,
      profileJson: JSON.stringify(nextProfile),
      isDeleted: false,
      deletedAt: null
    },
    update: {
      profileJson: JSON.stringify(nextProfile),
      isDeleted: false,
      deletedAt: null
    }
  });

  return { nextProfile, nextOnboarding };
}

async function getPersonalizationTestForUser(userId) {
  const context = await loadPersonalizationContext(userId);
  const { campaign, profile } = context;
  const campaignVersion = normalizeCampaignVersion(campaign?.campaignVersion, 1) || 1;

  let onboarding = context.onboarding || {};

  if (campaign.enabled) {
    const invitedVersion = normalizeCampaignVersion(onboarding?.invitedVersion, 0);
    if (!onboarding?.invitedAt || invitedVersion < campaignVersion) {
      const nowIso = new Date().toISOString();
      const persisted = await persistOnboardingState(userId, profile, {
        invitedAt: onboarding?.invitedAt || nowIso,
        invitedVersion: campaignVersion,
        updatedAt: nowIso
      });
      onboarding = persisted.nextOnboarding;
    }
  }

  const answers = getPersonalizationAnswersFromProfile(profile, onboarding);
  return buildPersonalizationStatus({ campaign, onboarding, answers });
}

async function savePersonalizationTestForUser(userId, payload = {}) {
  const context = await loadPersonalizationContext(userId);
  const { profile, onboarding, campaign } = context;
  const answers = normalizePersonalizationPayload(payload);
  const nowIso = new Date().toISOString();
  const campaignVersion = normalizeCampaignVersion(campaign?.campaignVersion, 1) || 1;

  const persisted = await persistOnboardingState(userId, profile, {
    ...answers,
    invitedAt: onboarding?.invitedAt || nowIso,
    invitedVersion: Math.max(
      normalizeCampaignVersion(onboarding?.invitedVersion, 0),
      campaignVersion
    ),
    completedAt: nowIso,
    completedVersion: campaignVersion,
    updatedAt: nowIso
  });

  await compressConversationToMemory(userId, buildPersonalizationMemoryMessages(answers), {
    includeSummary: false,
    source: 'onboarding_personalization_test',
    maxMessages: 12
  });

  return buildPersonalizationStatus({
    campaign,
    onboarding: persisted.nextOnboarding,
    answers: normalizePersonalizationPayload(persisted.nextOnboarding)
  });
}

async function postponePersonalizationTestForUser(userId) {
  const context = await loadPersonalizationContext(userId);
  const { profile, onboarding, campaign } = context;
  const nowIso = new Date().toISOString();
  const campaignVersion = normalizeCampaignVersion(campaign?.campaignVersion, 1) || 1;

  const persisted = await persistOnboardingState(userId, profile, {
    invitedAt: onboarding?.invitedAt || nowIso,
    invitedVersion: Math.max(
      normalizeCampaignVersion(onboarding?.invitedVersion, 0),
      campaignVersion
    ),
    dismissedAt: nowIso,
    dismissedVersion: campaignVersion,
    updatedAt: nowIso
  });

  return buildPersonalizationStatus({
    campaign,
    onboarding: persisted.nextOnboarding,
    answers: getPersonalizationAnswersFromProfile(persisted.nextProfile, persisted.nextOnboarding)
  });
}

module.exports = {
  getMemoryContext,
  compressConversationToMemory,
  clearMemory,
  restoreMemory,
  rebuildMemoryForUser,
  getMemoryForUser,
  deleteMemoryFact,
  getPersonalizationTestForUser,
  savePersonalizationTestForUser,
  postponePersonalizationTestForUser
};

