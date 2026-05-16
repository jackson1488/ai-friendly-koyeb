const express = require('express');
const WebSocket = require('ws');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { prisma } = require('../config/prisma');
const { comparePassword, hashPassword } = require('../utils/password');
const { signAdminPanelToken } = require('../utils/jwt');
const { requireAdminPanelAuth } = require('../middlewares/adminPanelAuth');
const { writeAuditLog } = require('../services/auditService');
const { parseModels } = require('../services/modelParserService');
const { getDashboardMetrics } = require('../controllers/adminController');
const { clearMemory, rebuildMemoryForUser, restoreMemory } = require('../services/memoryService');
const { getTierModelPools, buildTierModelCandidates, normalizeTier } = require('../constants/proTextModelPools');
const {
  ACCOUNT_DELETION_RETENTION_DAYS,
  getSoftDeletePurgeAt,
  softDeleteUserAccount,
  hardDeleteUserAccount,
  restoreUserAccount,
  restoreChatForUser,
  restoreProChatForUser,
  purgeChatById,
  purgeAnonSessionById
} = require('../services/deletionService');
const { getMemorySettings, withMemorySettings } = require('../services/memorySettingsService');
const {
  SUPPORTED_CHAT_LANGUAGE_CODES,
  getLanguageLabel,
  getLanguagePolicy,
  withLanguagePolicy
} = require('../services/languagePolicyService');
const {
  getProConfig,
  hasProAccess,
  withProConfig,
  resolveProApiKey,
  resolveProApiKeys,
  getUserProOverride,
  getEffectiveProConfigForUser,
  setUserProAccess,
  setUserProOverride,
  listToText
} = require('../services/proConfigService');
const { revokeAllUserSessions, revokeSingleUserSession } = require('../services/sessionSecurityService');
const { BAN_SCOPE, getActiveBanForUser, syncGlobalBlockState } = require('../services/banService');
const { getIo } = require('../socket/io');
const { userRoom } = require('../socket/rooms');
const { adminEndSession } = require('../socket/anonSupportSocket');
const {
  DEFAULT_ONBOARDING_TEST_QUESTIONS,
  getOnboardingPersonalizationConfig,
  withOnboardingPersonalizationConfig
} = require('../services/onboardingPersonalizationService');
const {
  runChatWithFallback,
  runImageGenerationWithFallback,
  runImageEditWithFallback,
  runVideoGenerationWithFallback,
  runTranscriptionWithFallback,
  runSpeechSynthesisWithFallback
} = require('../services/proProviderService');
const {
  createInboxItemByAdmin,
  listInboxItemsForAdmin,
  getInboxItemForAdmin,
  updateInboxItemByAdmin,
  publishInboxItemNow,
  cancelInboxItem
} = require('../services/inboxService');
const { persistBufferForUser } = require('../utils/mediaStorage');
const {
  ROLE_COLORS,
  DEFAULT_PRIVACY_MARKDOWN,
  DEFAULT_TERMS_MARKDOWN,
  DEFAULT_FAQ_ITEMS,
  DEFAULT_SUPPORT_INFO,
  DEFAULT_APP_INFO
} = require('../constants/aboutDefaults');

const router = express.Router();
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const modelPresets = [
  'openrouter/auto',
  'google/gemma-3-27b-it:free',
  'arcee-ai/trinity-mini:free',
  'qwen/qwen3-next-80b-a3b-instruct:free'
];
const ADMIN_TEST_IMAGE_URL = 'https://dummyimage.com/512x512/111/ffffff.png&text=AI+Test';
const ADMIN_MODEL_TEST_RESULTS_KEY = 'adminModelTestResults';
const PRO_MODEL_CATEGORY_DEFS = [
  { key: 'pro_text', listKey: 'textModels', label: 'PRO text', typeGroup: 'text' },
  { key: 'pro_vision', listKey: 'visionModels', label: 'PRO vision', typeGroup: 'vision' },
  { key: 'pro_image_gen', listKey: 'imageGenModels', label: 'Image generation', typeGroup: 'image' },
  { key: 'pro_image_edit', listKey: 'imageEditModels', label: 'Image editing', typeGroup: 'image' },
  { key: 'pro_video_gen', listKey: 'videoGenModels', label: 'Video generation', typeGroup: 'video' },
  { key: 'pro_voice_asr', listKey: 'voiceAsrModels', label: 'Voice ASR', typeGroup: 'voice' },
  { key: 'pro_voice_tts', listKey: 'voiceTtsModels', label: 'Voice TTS', typeGroup: 'voice' },
  {
    key: 'pro_voice_realtime',
    listKey: 'voiceRealtimeModels',
    label: 'Voice realtime',
    typeGroup: 'realtime'
  }
];
const TEXT_POOL_CATEGORY_DEFS = [
  { key: 'pool_fast', tier: 'fast', label: 'Text pool fast', typeGroup: 'text' },
  { key: 'pool_standard', tier: 'standard', label: 'Text pool standard', typeGroup: 'text' },
  { key: 'pool_best', tier: 'best', label: 'Text pool best', typeGroup: 'text' }
];
const INBOX_TYPE_GROUP_META = {
  alerts: {
    key: 'alerts',
    label: 'Новости и системные',
    types: ['NEWS', 'SYSTEM'],
    description: 'Основной inbox: новости и системные уведомления.'
  },
  all: {
    key: 'all',
    label: 'История inbox',
    types: ['NEWS', 'SYSTEM'],
    description: 'История рассылок только по NEWS/SYSTEM.'
  }
};
const ADMIN_IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'bmp',
  'avif',
  'heic',
  'heif'
]);

function getFileExt(value) {
  const fileName = `${value || ''}`.trim().toLowerCase();
  if (!fileName) return '';
  const index = fileName.lastIndexOf('.');
  if (index < 0) return '';
  return fileName.slice(index + 1).replace(/[^a-z0-9]/g, '');
}

function isLikelyImageUpload(file) {
  const mime = `${file?.mimetype || ''}`.trim().toLowerCase();
  if (mime.startsWith('image/')) return true;
  const ext = getFileExt(file?.originalname || '');
  return ADMIN_IMAGE_EXTENSIONS.has(ext);
}

const INBOX_IMAGE_UPLOAD = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (isLikelyImageUpload(file)) {
      cb(null, true);
      return;
    }
    cb(new Error('Only image uploads are allowed'));
  }
});

const ABOUT_DEVELOPER_UPLOAD = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const uploadDir = path.resolve(__dirname, '../../uploads/developers');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: (_req, file, cb) => {
      const ext = getFileExt(file?.originalname || '') || 'jpg';
      cb(null, `dev_${Date.now()}_${Math.random().toString(16).slice(2, 10)}.${ext}`);
    }
  }),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (isLikelyImageUpload(file)) {
      cb(null, true);
      return;
    }
    cb(new Error('Only image uploads are allowed'));
  }
});

function safeJsonParse(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function parseProMessagesJson(value) {
  const parsed = safeJsonParse(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function maskSecret(value) {
  const text = `${value || ''}`.trim();
  if (!text) return '';
  if (text.length <= 10) return '********';
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function parseCheckbox(value) {
  return value === 'true' || value === 'on' || value === '1';
}

function parseAccessMode(value) {
  const mode = `${value || ''}`.trim().toLowerCase();
  return mode === 'all' ? 'all' : 'allowlist';
}

function emitProAccessUpdateToUser(userId, payload = {}) {
  const safeUserId = `${userId || ''}`.trim();
  if (!safeUserId) return;
  const io = getIo();
  if (!io) return;
  io.to(userRoom(safeUserId)).emit('pro:access:updated', {
    scope: 'user',
    userId: safeUserId,
    updatedAt: new Date().toISOString(),
    ...payload
  });
}

function emitProAccessUpdateGlobal(payload = {}) {
  const io = getIo();
  if (!io) return;
  io.emit('pro:access:updated', {
    scope: 'global',
    updatedAt: new Date().toISOString(),
    ...payload
  });
}

const PRO_CONFIG_SECTION_META = {
  general: { key: 'general', label: 'Общие' },
  provider: { key: 'provider', label: 'Провайдер и ключи' },
  models: { key: 'models', label: 'Модели' },
  features: { key: 'features', label: 'Функции и лимиты' },
  allowlist: { key: 'allowlist', label: 'Allowlist' },
  prompt: { key: 'prompt', label: 'Промпт' }
};

const PRO_CONFIG_SECTION_KEYS = Object.keys(PRO_CONFIG_SECTION_META);

function normalizeProConfigSection(value) {
  const key = `${value || ''}`.trim().toLowerCase();
  if (PRO_CONFIG_SECTION_KEYS.includes(key)) return key;
  return 'general';
}

function buildProConfigSectionNav(currentSection) {
  const activeSection = normalizeProConfigSection(currentSection);
  return PRO_CONFIG_SECTION_KEYS.map((key) => ({
    key,
    label: PRO_CONFIG_SECTION_META[key].label,
    href: `/admin/pro-config/${key}`,
    active: key === activeSection
  }));
}

function parseOptionalPositiveInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

const ABOUT_SECTION_META = {
  developers: { key: 'developers', label: 'Команда' },
  legal: { key: 'legal', label: 'Юридические документы' },
  faq: { key: 'faq', label: 'FAQ' },
  support: { key: 'support', label: 'Поддержка' },
  app: { key: 'app', label: 'Приложение' }
};
const ABOUT_SECTION_KEYS = Object.keys(ABOUT_SECTION_META);
const ABOUT_ROLE_OPTIONS = Object.keys(ROLE_COLORS);

function normalizeAboutSection(value) {
  const key = `${value || ''}`.trim().toLowerCase();
  if (ABOUT_SECTION_KEYS.includes(key)) return key;
  return 'developers';
}

function buildAboutSectionNav(currentSection) {
  const active = normalizeAboutSection(currentSection);
  return ABOUT_SECTION_KEYS.map((key) => ({
    key,
    label: ABOUT_SECTION_META[key].label,
    href: `/admin/about/${key}`,
    active: key === active
  }));
}

function parseContributionList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => `${item || ''}`.trim())
      .filter(Boolean)
      .slice(0, 30);
  }

  const text = `${value || ''}`.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parseContributionList(parsed);
  } catch (_error) {
    // continue as plain text
  }

  return text
    .split(/[\n,;]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 30);
}

function normalizeFaqColor(value, fallback = '#667eea') {
  const color = `${value || ''}`.trim();
  if (!color) return fallback;
  return /^#?[0-9a-fA-F]{6}$/.test(color) ? (color.startsWith('#') ? color : `#${color}`) : fallback;
}

function mapLegalTypeFromParam(value) {
  const key = `${value || ''}`.trim().toLowerCase();
  if (key === 'privacy' || key === 'privacy_policy') return 'PRIVACY_POLICY';
  if (key === 'terms' || key === 'terms_of_service') return 'TERMS_OF_SERVICE';
  return null;
}

function toPublicDeveloperPhotoUrl(_req, fileName) {
  if (!fileName) return null;
  return `/uploads/developers/${encodeURIComponent(fileName)}`;
}

function toDeveloperPayload(row) {
  let contribution = [];
  try {
    const parsed = JSON.parse(`${row?.contribution || '[]'}`);
    contribution = parseContributionList(parsed);
  } catch (_error) {
    contribution = parseContributionList(row?.contribution);
  }
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    roleColor: ROLE_COLORS[row.role] || '#667eea',
    bio: row.bio,
    photo: row.photo || null,
    github: row.github || null,
    linkedin: row.linkedin || null,
    contribution,
    order: row.order,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function emitAboutEvent(eventName, payload = {}) {
  try {
    const io = getIo();
    if (io) io.emit(eventName, payload);
  } catch (_error) {
    // Ignore realtime emit failures.
  }
}

function resolveDeveloperPhotoPath(photoUrl) {
  const text = `${photoUrl || ''}`.trim();
  if (!text) return '';
  const baseDir = path.resolve(__dirname, '../../uploads/developers');
  const normalizeRelative = (candidate) => {
    const relative = decodeURIComponent(
      `${candidate || ''}`.trim().replace(/^\/uploads\/developers\//i, '').replace(/^uploads\/developers\//i, '')
    );
    if (!relative) return '';
    const resolved = path.resolve(baseDir, relative);
    const delta = path.relative(baseDir, resolved);
    if (!delta || delta.startsWith('..') || path.isAbsolute(delta)) return '';
    return resolved;
  };

  if (text.startsWith('/uploads/developers/') || text.startsWith('uploads/developers/')) {
    return normalizeRelative(text);
  }

  try {
    const parsed = new URL(text);
    if (!parsed.pathname.startsWith('/uploads/developers/')) return '';
    return normalizeRelative(parsed.pathname);
  } catch (_error) {
    return '';
  }
}

function deleteDeveloperPhotoByUrl(photoUrl) {
  const filePath = resolveDeveloperPhotoPath(photoUrl);
  if (!filePath || !fs.existsSync(filePath)) return;
  try {
    fs.unlinkSync(filePath);
  } catch (_error) {
    // Ignore cleanup errors.
  }
}

function normalizeInboxType(value) {
  const next = `${value || ''}`.trim().toUpperCase();
  if (next === 'TEST' || next === 'NEWS' || next === 'SYSTEM') return next;
  return 'SYSTEM';
}

function normalizeInboxComposeType(value) {
  const next = `${value || ''}`.trim().toUpperCase();
  if (next === 'NEWS' || next === 'SYSTEM') return next;
  return 'NEWS';
}

function normalizeInboxHistoryType(value) {
  const next = `${value || ''}`.trim().toUpperCase();
  if (next === 'NEWS' || next === 'SYSTEM' || next === 'ALL') return next;
  return 'NEWS';
}

function normalizeInboxScope(value) {
  const next = `${value || ''}`.trim().toUpperCase();
  if (next === 'GLOBAL' || next === 'USER' || next === 'SEGMENT') return next;
  return 'GLOBAL';
}

function normalizeInboxTypeGroup(value) {
  const key = `${value || ''}`.trim().toLowerCase();
  if (key === 'all') return 'all';
  return 'alerts';
}

function buildInboxTypeTabs(activeGroup = 'alerts') {
  const safeActive = normalizeInboxTypeGroup(activeGroup);
  return Object.values(INBOX_TYPE_GROUP_META).map((item) => ({
    ...item,
    active: item.key === safeActive,
    href:
      item.key === 'all'
        ? `/admin/inbox?group=${encodeURIComponent(item.key)}&history=NEWS`
        : `/admin/inbox?group=${encodeURIComponent(item.key)}&kind=NEWS`
  }));
}

function buildInboxComposeTabs(group = 'alerts', composeType = 'NEWS') {
  const safeGroup = normalizeInboxTypeGroup(group);
  const safeComposeType = normalizeInboxComposeType(composeType);
  const kinds = [
    { key: 'NEWS', label: 'Новости' },
    { key: 'SYSTEM', label: 'Системные' }
  ];

  return kinds.map((item) => ({
    ...item,
    active: item.key === safeComposeType,
    href: `/admin/inbox?group=${encodeURIComponent(safeGroup)}&kind=${encodeURIComponent(item.key)}`
  }));
}

function buildInboxHistoryTabs(group = 'all', historyType = 'ALL') {
  const safeGroup = normalizeInboxTypeGroup(group);
  const safeHistoryType = normalizeInboxHistoryType(historyType);
  const tabs = [
    { key: 'ALL', label: 'Все' },
    { key: 'NEWS', label: 'Новости' },
    { key: 'SYSTEM', label: 'Системные' }
  ];
  return tabs.map((tab) => ({
    ...tab,
    active: tab.key === safeHistoryType,
    href: `/admin/inbox?group=${encodeURIComponent(safeGroup)}&history=${encodeURIComponent(tab.key)}`
  }));
}

function getInboxTypesByGroup(group = 'alerts') {
  const key = normalizeInboxTypeGroup(group);
  const meta = INBOX_TYPE_GROUP_META[key] || INBOX_TYPE_GROUP_META.alerts;
  return Array.isArray(meta.types) ? meta.types : [];
}

function isInboxTypeAllowedForGroup(type, group = 'alerts') {
  const allowed = getInboxTypesByGroup(group);
  if (!allowed.length) return true;
  return allowed.includes(normalizeInboxType(type));
}

function parseInboxJsonSafe(value) {
  try {
    const parsed = JSON.parse(`${value || '{}'}`);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch (_error) {
    return {};
  }
}

function parseInboxPayloadFromForm(body = {}, options = {}) {
  const payload = parseInboxJsonSafe(body.payloadJson);
  const route = `${body.route || ''}`.trim();
  const primaryLabel = `${body.primaryLabel || ''}`.trim();
  const secondaryLabel = `${body.secondaryLabel || ''}`.trim();
  const imageUrl = `${options.uploadedImageUrl || body.imageUrl || ''}`.trim();
  const markdown = `${body.markdown || ''}`.trim();
  const detailText = `${body.detailText || ''}`.trim();
  const pushTitle = `${body.pushTitle || ''}`.trim();
  const pushBody = `${body.pushBody || ''}`.trim();
  const titleRu = `${body.titleRu || ''}`.trim();
  const titleKy = `${body.titleKy || ''}`.trim();
  const messageRu = `${body.messageRu || ''}`.trim();
  const messageKy = `${body.messageKy || ''}`.trim();
  const quietHoursStart = `${body.quietHoursStart || ''}`.trim();
  const quietHoursEnd = `${body.quietHoursEnd || ''}`.trim();
  const ctaLabel = `${body.ctaLabel || ''}`.trim();
  const ctaRoute = `${body.ctaRoute || ''}`.trim();
  const ctaUrl = `${body.ctaUrl || ''}`.trim();
  const repeatEveryMinutes = Number.parseInt(`${body.repeatEveryMinutes || ''}`.trim(), 10);
  const maxOccurrences = Number.parseInt(`${body.maxOccurrences || ''}`.trim(), 10);
  const repeatUntil = `${body.repeatUntil || ''}`.trim();

  let blocks = [];
  try {
    const parsed = JSON.parse(`${body.blocksJson || '[]'}`);
    if (Array.isArray(parsed)) {
      blocks = parsed.filter((item) => item && typeof item === 'object').slice(0, 40);
    }
  } catch (_error) {
    blocks = [];
  }

  if (route.startsWith('/')) payload.route = route;
  if (primaryLabel) payload.primaryLabel = primaryLabel.slice(0, 80);
  if (secondaryLabel) payload.secondaryLabel = secondaryLabel.slice(0, 80);
  if (imageUrl) payload.imageUrl = imageUrl.slice(0, 2000);
  if (detailText) payload.content = detailText.slice(0, 30000);
  if (markdown) payload.markdown = markdown.slice(0, 12000);
  if (pushTitle) payload.pushTitle = pushTitle.slice(0, 180);
  if (pushBody) payload.pushBody = pushBody.slice(0, 1200);
  if (blocks.length) payload.blocks = blocks;

  if (titleRu || titleKy) {
    payload.titleByLocale = {
      ...(payload.titleByLocale && typeof payload.titleByLocale === 'object' ? payload.titleByLocale : {}),
      ...(titleRu ? { ru: titleRu.slice(0, 180) } : {}),
      ...(titleKy ? { ky: titleKy.slice(0, 180) } : {})
    };
  }

  if (messageRu || messageKy) {
    payload.messageByLocale = {
      ...(payload.messageByLocale && typeof payload.messageByLocale === 'object' ? payload.messageByLocale : {}),
      ...(messageRu ? { ru: messageRu.slice(0, 2000) } : {}),
      ...(messageKy ? { ky: messageKy.slice(0, 2000) } : {})
    };
  }

  if (ctaLabel && (ctaRoute.startsWith('/') || /^https?:\/\//i.test(ctaUrl))) {
    const currentCtas = Array.isArray(payload.ctas)
      ? payload.ctas.filter((item) => item && typeof item === 'object')
      : [];
    const primaryCta = {
      type: 'primary',
      label: ctaLabel.slice(0, 80),
      route: ctaRoute.startsWith('/') ? ctaRoute : undefined,
      url: /^https?:\/\//i.test(ctaUrl) ? ctaUrl.slice(0, 2000) : undefined
    };
    payload.ctas = [primaryCta, ...currentCtas.filter((item) => item.type !== 'primary')].slice(0, 5);
  }

  if (Number.isFinite(repeatEveryMinutes) && repeatEveryMinutes > 0) {
    payload.schedule = {
      ...(payload.schedule && typeof payload.schedule === 'object' ? payload.schedule : {}),
      repeatEveryMinutes: Math.min(60 * 24 * 14, Math.max(1, repeatEveryMinutes)),
      ...(Number.isFinite(maxOccurrences) && maxOccurrences > 0
        ? { maxOccurrences: Math.min(1000, Math.max(1, maxOccurrences)) }
        : {}),
      ...(repeatUntil ? { repeatUntil } : {})
    };
  }

  if (/^\d{1,2}:\d{2}$/.test(quietHoursStart) && /^\d{1,2}:\d{2}$/.test(quietHoursEnd)) {
    payload.delivery = {
      ...(payload.delivery && typeof payload.delivery === 'object' ? payload.delivery : {}),
      quietHours: {
        start: quietHoursStart,
        end: quietHoursEnd
      }
    };
  }

  return payload;
}

async function persistAdminInboxImage(req, file, { userScope = 'global' } = {}) {
  if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length) return '';
  const rawMime = `${file.mimetype || ''}`.trim().toLowerCase();
  const ext = getFileExt(file?.originalname || '');
  const fallbackMimeByExt = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    avif: 'image/avif',
    heic: 'image/heic',
    heif: 'image/heif'
  };
  const mimeType = rawMime.startsWith('image/')
    ? rawMime
    : fallbackMimeByExt[ext] || '';
  if (!mimeType.startsWith('image/')) return '';

  const adminId = `${req?.admin?.id || 'admin'}`.trim();
  const targetUserId = `${userScope || 'global'}`.trim().replace(/[^\w.-]/g, '_');
  const persisted = await persistBufferForUser({
    userId: `admin_${adminId}`,
    segments: ['inbox', targetUserId],
    prefix: 'inbox_image',
    mimeType,
    buffer: file.buffer,
    req
  });
  const relativePath = `${persisted?.relativePath || ''}`.trim().replace(/\\/g, '/');
  if (relativePath) return `/uploads/${relativePath}`;
  return `${persisted?.publicUrl || ''}`.trim();
}

function buildMemoryPersonalizedTestDraft({ user, profileOverview }) {
  const overview = profileOverview && typeof profileOverview === 'object' ? profileOverview : {};
  const ageText = Number.isFinite(Number(overview.age)) ? `Возраст: ${Number(overview.age)}.` : '';
  const goals = Array.isArray(overview.goals) ? overview.goals.filter(Boolean).slice(0, 3) : [];
  const struggles = Array.isArray(overview.struggles) ? overview.struggles.filter(Boolean).slice(0, 3) : [];
  const supports = Array.isArray(overview.supports) ? overview.supports.filter(Boolean).slice(0, 3) : [];

  const goalsText = goals.length ? `Цели: ${goals.join(', ')}.` : 'Цели пока не указаны.';
  const strugglesText = struggles.length
    ? `Основные сложности: ${struggles.join(', ')}.`
    : 'Сложности пока не отмечены.';
  const supportsText = supports.length ? `Что помогает: ${supports.join(', ')}.` : 'Поддерживающие факторы пока не отмечены.';

  const username = `${user?.displayName || user?.username || 'пользователя'}`.trim();
  const title = `Персональный тест для ${username}`;
  const message = `${ageText} ${goalsText} ${strugglesText} ${supportsText}`.replace(/\s+/g, ' ').trim();

  return {
    title: title.slice(0, 180),
    message: message.slice(0, 2000),
    payload: {
      route: '/personalization-test',
      primaryLabel: 'Пройти тест',
      secondaryLabel: 'Позже',
      testQuestions: DEFAULT_ONBOARDING_TEST_QUESTIONS,
      generatedBy: 'admin-memory',
      generatedAt: new Date().toISOString(),
      memorySnapshot: {
        age: Number.isFinite(Number(overview.age)) ? Number(overview.age) : null,
        goals,
        struggles,
        supports
      }
    }
  };
}

function extractFirstJsonObject(text) {
  const source = `${text || ''}`.trim();
  if (!source) return '';
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return '';
  return source.slice(start, end + 1);
}

function buildTestGenerationMemoryPayload({ user, profileOverview }) {
  const overview = profileOverview && typeof profileOverview === 'object' ? profileOverview : {};
  const goals = Array.isArray(overview.goals) ? overview.goals.slice(0, 8) : [];
  const struggles = Array.isArray(overview.struggles) ? overview.struggles.slice(0, 8) : [];
  const supports = Array.isArray(overview.supports) ? overview.supports.slice(0, 8) : [];
  const focusAreas = Array.isArray(overview.focusAreas) ? overview.focusAreas.slice(0, 8) : [];
  const factHighlights = Array.isArray(overview.factHighlights) ? overview.factHighlights.slice(0, 10) : [];

  return {
    user: {
      id: `${user?.id || ''}`.trim(),
      username: `${user?.username || ''}`.trim(),
      displayName: `${user?.displayName || ''}`.trim(),
      age: Number.isFinite(Number(overview.age)) ? Number(overview.age) : null
    },
    memory: {
      goals,
      struggles,
      supports,
      focusAreas,
      factHighlights
    }
  };
}

function isQwenLikeModel(modelId) {
  const normalized = `${modelId || ''}`.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.startsWith('qwen') ||
    normalized.startsWith('qwen/') ||
    normalized.startsWith('qwq') ||
    normalized.startsWith('qvq')
  );
}

function normalizeQwenProviderModelId(modelId) {
  let normalized = `${modelId || ''}`.trim();
  if (!normalized) return '';
  if (normalized.toLowerCase() === 'openrouter/auto') return '';
  if (normalized.includes('/')) {
    normalized = normalized.slice(normalized.lastIndexOf('/') + 1);
  }
  normalized = normalized.replace(/:.*$/, '').trim();
  if (!normalized || normalized.toLowerCase() === 'auto') return '';
  return normalized;
}

function buildQwenPreferredModelCandidates(proConfig, tier = 'standard') {
  const cfg = proConfig && typeof proConfig === 'object' ? proConfig : {};
  const source = buildTierModelCandidates(
    normalizeTier(tier || 'standard'),
    Array.isArray(cfg.textModels) ? cfg.textModels : []
  );

  const unique = [];
  for (const item of source) {
    const model = `${item || ''}`.trim();
    if (!model || !isQwenLikeModel(model)) continue;
    const providerModel = normalizeQwenProviderModelId(model);
    if (!providerModel || unique.includes(providerModel)) continue;
    unique.push(providerModel);
  }

  if (!unique.includes('qwen-plus')) unique.push('qwen-plus');
  if (!unique.includes('qwen-turbo')) unique.push('qwen-turbo');

  return unique;
}

async function generateAiPersonalizedTestDraft({ user, profileOverview, proConfig }) {
  const baseDraft = buildMemoryPersonalizedTestDraft({ user, profileOverview });
  const cfg = proConfig && typeof proConfig === 'object' ? proConfig : {};
  const apiKeys = resolveProApiKeys(cfg);
  const baseUrl = `${cfg.baseUrl || ''}`.trim();
  const modelCandidates = buildQwenPreferredModelCandidates(cfg, 'standard');

  if (!apiKeys.length || !baseUrl || !modelCandidates.length) {
    return {
      ...baseDraft,
      payload: {
        ...baseDraft.payload,
        generatedBy: 'admin-memory-fallback'
      },
      source: 'memory'
    };
  }

  const memoryPayload = buildTestGenerationMemoryPayload({ user, profileOverview });
  const systemPrompt =
    'Ты генерируешь только краткую карточку персонального психологического теста. Верни только JSON-объект без markdown и пояснений.' +
    ' JSON формат: {"title":"...","message":"...","primaryLabel":"...","secondaryLabel":"..."}.' +
    ' title <= 180 символов, message <= 2000 символов, мягкий эмпатичный тон.';

  const userPrompt = `Построй персональный черновик карточки теста по данным памяти пользователя.\nДанные:\n${JSON.stringify(
    memoryPayload,
    null,
    2
  )}`;

  const ai = await runChatWithFallback({
    apiKeys,
    baseUrl,
    modelCandidates,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.5,
    maxTokens: 650
  });

  const parsed = safeJsonParse(extractFirstJsonObject(ai?.text), null);
  if (!parsed || typeof parsed !== 'object') {
    return {
      ...baseDraft,
      payload: {
        ...baseDraft.payload,
        generatedBy: 'admin-memory-fallback'
      },
      source: 'memory'
    };
  }

  const nextTitle = `${parsed.title || baseDraft.title || ''}`.trim().slice(0, 180);
  const nextMessage = `${parsed.message || baseDraft.message || ''}`.trim().slice(0, 2000);
  const primaryLabel = `${parsed.primaryLabel || baseDraft.payload?.primaryLabel || 'Пройти тест'}`
    .trim()
    .slice(0, 80);
  const secondaryLabel = `${parsed.secondaryLabel || baseDraft.payload?.secondaryLabel || 'Позже'}`
    .trim()
    .slice(0, 80);

  return {
    title: nextTitle || baseDraft.title,
    message: nextMessage || baseDraft.message,
    payload: {
      ...baseDraft.payload,
      primaryLabel,
      secondaryLabel,
      generatedBy: 'admin-ai',
      generatedAt: new Date().toISOString(),
      modelUsed: `${ai?.modelUsed || ''}`.trim() || null
    },
    source: 'ai',
    modelUsed: `${ai?.modelUsed || ''}`.trim() || null
  };
}

async function generateAiPersonalizedTestDraftV2({
  user,
  profileOverview,
  proConfig,
  openrouterFallback = {}
}) {
  const baseDraft = buildMemoryPersonalizedTestDraft({ user, profileOverview });
  const cfg = proConfig && typeof proConfig === 'object' ? proConfig : {};
  const baseUrl = `${cfg.baseUrl || ''}`.trim();
  const qwenApiKeys = resolveProApiKeys(cfg);
  const qwenCandidates = buildQwenPreferredModelCandidates(cfg);
  const fallbackOpenrouterApiKey = `${openrouterFallback?.apiKey || ''}`.trim();

  if (!baseUrl) {
    return {
      ...baseDraft,
      payload: {
        ...baseDraft.payload,
        testQuestions: normalizeAiGeneratedQuestions(baseDraft.payload?.testQuestions, DEFAULT_ONBOARDING_TEST_QUESTIONS),
        generatedBy: 'admin-memory-fallback'
      },
      source: 'memory'
    };
  }

  const memoryPayload = buildTestGenerationMemoryPayload({ user, profileOverview });
  const baseQuestionSchema = DEFAULT_ONBOARDING_TEST_QUESTIONS.map((item) => ({
    id: item.id,
    type: item.type,
    maxSelections: item.maxSelections,
    options: item.options
  }));

  const systemPrompt =
    'Return only JSON with no markdown and no explanations. ' +
    'Build a personalized onboarding test card and full question set. ' +
    'Output schema: {"title":"","message":"","primaryLabel":"","secondaryLabel":"","testQuestions":[{"id":"","type":"","title":"","hint":"","placeholder":"","maxSelections":1,"options":[]}]}';

  const userPrompt = `Generate a personalized onboarding test draft in Russian.
Requirements:
- title <= 180 chars
- message <= 2000 chars
- button labels <= 80 chars
- include every question id from baseQuestionSchema exactly as-is
- do not change question type
- for non-text questions provide 3-10 options

baseQuestionSchema:
${JSON.stringify(baseQuestionSchema, null, 2)}

userMemory:
${JSON.stringify(memoryPayload, null, 2)}`;

  let ai = null;
  let qwenError = null;

  if (qwenApiKeys.length && qwenCandidates.length) {
    try {
      ai = await runChatWithFallback({
        apiKeys: qwenApiKeys,
        baseUrl,
        modelCandidates: qwenCandidates,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.5,
        maxTokens: 1400
      });
    } catch (error) {
      qwenError = error;
    }
  }

  if (!ai && fallbackOpenrouterApiKey) {
    try {
      ai = await runChatWithFallback({
        apiKeys: [fallbackOpenrouterApiKey],
        baseUrl: OPENROUTER_BASE_URL,
        modelCandidates: ['openrouter/auto'],
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.5,
        maxTokens: 1400
      });
    } catch (_fallbackError) {
      ai = null;
    }
  }

  if (!ai) {
    if (qwenError?.message) {
      logger.warn('Onboarding test AI draft: Qwen unavailable, memory fallback used', {
        userId: `${user?.id || ''}`.trim() || null,
        error: qwenError.message
      });
    }
    return {
      ...baseDraft,
      payload: {
        ...baseDraft.payload,
        testQuestions: normalizeAiGeneratedQuestions(baseDraft.payload?.testQuestions, DEFAULT_ONBOARDING_TEST_QUESTIONS),
        generatedBy: 'admin-memory-fallback'
      },
      source: 'memory'
    };
  }

  const parsed = safeJsonParse(extractFirstJsonObject(ai?.text), null);
  if (!parsed || typeof parsed !== 'object') {
    return {
      ...baseDraft,
      payload: {
        ...baseDraft.payload,
        testQuestions: normalizeAiGeneratedQuestions(baseDraft.payload?.testQuestions, DEFAULT_ONBOARDING_TEST_QUESTIONS),
        generatedBy: 'admin-memory-fallback'
      },
      source: 'memory'
    };
  }

  const nextTitle = `${parsed.title || baseDraft.title || ''}`.trim().slice(0, 180);
  const nextMessage = `${parsed.message || baseDraft.message || ''}`.trim().slice(0, 2000);
  const primaryLabel = `${parsed.primaryLabel || baseDraft.payload?.primaryLabel || 'Пройти тест'}`
    .trim()
    .slice(0, 80);
  const secondaryLabel = `${parsed.secondaryLabel || baseDraft.payload?.secondaryLabel || 'Позже'}`
    .trim()
    .slice(0, 80);
  const aiQuestions = normalizeAiGeneratedQuestions(parsed.testQuestions, DEFAULT_ONBOARDING_TEST_QUESTIONS);

  return {
    title: nextTitle || baseDraft.title,
    message: nextMessage || baseDraft.message,
    payload: {
      ...baseDraft.payload,
      primaryLabel,
      secondaryLabel,
      testQuestions: aiQuestions,
      generatedBy: 'admin-ai',
      generatedAt: new Date().toISOString(),
      modelUsed: `${ai?.modelUsed || ''}`.trim() || null
    },
    source: 'ai',
    modelUsed: `${ai?.modelUsed || ''}`.trim() || null
  };
}

function parseUserIdsText(value) {
  return `${value || ''}`
    .split(/[\n,\s]+/g)
    .map((item) => `${item || ''}`.trim())
    .filter(Boolean)
    .slice(0, 5000);
}

function parseOnboardingQuestionsInput(value) {
  const text = `${value || ''}`.trim();
  if (!text) {
    return [...DEFAULT_ONBOARDING_TEST_QUESTIONS];
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    throw new Error('Некорректный JSON в блоке вопросов теста');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Вопросы теста должны быть массивом JSON');
  }

  const knownIds = new Set(DEFAULT_ONBOARDING_TEST_QUESTIONS.map((item) => item.id));
  for (const row of parsed) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('Каждый вопрос должен быть объектом');
    }
    const id = `${row.id || ''}`.trim();
    if (!knownIds.has(id)) {
      throw new Error(`Неизвестный id вопроса: ${id || 'empty'}`);
    }
  }

  return parsed;
}

function normalizeAiGeneratedQuestions(rawQuestions, fallbackQuestions = DEFAULT_ONBOARDING_TEST_QUESTIONS) {
  const fallbackList =
    Array.isArray(fallbackQuestions) && fallbackQuestions.length
      ? fallbackQuestions
      : DEFAULT_ONBOARDING_TEST_QUESTIONS;
  const source = Array.isArray(rawQuestions) ? rawQuestions : [];
  const byId = new Map();

  for (const row of source) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const id = `${row.id || ''}`.trim();
    if (!id) continue;
    byId.set(id, row);
  }

  return fallbackList.map((fallback) => {
    const fromAi = byId.get(fallback.id) || {};
    const type = `${fallback.type || 'single'}`.trim().toLowerCase();
    const title = `${fromAi.title || fallback.title || ''}`.trim().slice(0, 240) || `${fallback.title || ''}`.trim();
    const hint = `${fromAi.hint || fallback.hint || ''}`.trim().slice(0, 240);
    const placeholder = `${fromAi.placeholder || fallback.placeholder || ''}`.trim().slice(0, 240);
    const rawOptions = Array.isArray(fromAi.options) ? fromAi.options : [];

    let options = [];
    if (type !== 'text') {
      options = rawOptions
        .map((item) => `${item || ''}`.trim().slice(0, 120))
        .filter(Boolean);
      if (!options.length) {
        options = (Array.isArray(fallback.options) ? fallback.options : [])
          .map((item) => `${item || ''}`.trim().slice(0, 120))
          .filter(Boolean);
      }
      options = Array.from(new Set(options)).slice(0, 10);
    }

    const fallbackMax = Number.isFinite(Number(fallback.maxSelections)) ? Number(fallback.maxSelections) : 1;
    const aiMax = Number(fromAi.maxSelections);
    const maxSelections =
      type === 'multi'
        ? Math.max(2, Math.min(10, Number.isFinite(aiMax) ? aiMax : fallbackMax || 3))
        : 1;

    return {
      id: `${fallback.id || ''}`.trim(),
      type,
      title,
      hint,
      placeholder,
      maxSelections,
      options
    };
  });
}

function getOnboardingCardFromBody(body = {}, fallback = {}) {
  const source = body && typeof body === 'object' ? body : {};
  return {
    title: `${source.testCardTitle || fallback.title || ''}`.trim().slice(0, 180),
    message: `${source.testCardMessage || fallback.message || ''}`.trim().slice(0, 2000),
    route: `${source.testCardRoute || fallback.route || '/personalization-test'}`.trim(),
    primaryLabel: `${source.testCardPrimaryLabel || fallback.primaryLabel || ''}`.trim().slice(0, 80),
    secondaryLabel: `${source.testCardSecondaryLabel || fallback.secondaryLabel || ''}`.trim().slice(0, 80),
    imageUrl: `${source.testCardImageUrl || fallback.imageUrl || ''}`.trim().slice(0, 2000)
  };
}

function makeOnboardingTestPayload({ card, testQuestions, campaignVersion, uploadedImageUrl = '' } = {}) {
  const normalizedCard = card && typeof card === 'object' ? card : {};
  const payload = {
    route: `${normalizedCard.route || '/personalization-test'}`.trim().startsWith('/')
      ? `${normalizedCard.route || '/personalization-test'}`.trim()
      : '/personalization-test',
    primaryLabel: `${normalizedCard.primaryLabel || 'Пройти тест'}`.trim().slice(0, 80),
    secondaryLabel: `${normalizedCard.secondaryLabel || 'Позже'}`.trim().slice(0, 80),
    campaignVersion: Number(campaignVersion) || 1,
    testQuestions: Array.isArray(testQuestions) ? testQuestions : DEFAULT_ONBOARDING_TEST_QUESTIONS
  };

  const imageUrl = `${uploadedImageUrl || normalizedCard.imageUrl || ''}`.trim();
  if (imageUrl) {
    payload.imageUrl = imageUrl.slice(0, 2000);
  }

  return payload;
}

async function listOnboardingTargetUsers(limit = 300) {
  const safeLimit = Math.max(20, Math.min(1500, Number(limit) || 300));
  const users = await prisma.user.findMany({
    where: { isDeleted: false },
    select: {
      id: true,
      publicId: true,
      username: true,
      displayName: true,
      createdAt: true
    },
    orderBy: [{ createdAt: 'desc' }],
    take: safeLimit
  });

  return users.map((user) => ({
    id: user.id,
    publicId: user.publicId || '',
    username: user.username || '',
    displayName: user.displayName || user.username || '',
    createdAt: user.createdAt
  }));
}

function parseAdminRedirect(req, fallbackPath) {
  const raw = `${req?.body?.redirectTo || ''}`.trim();
  if (raw.startsWith('/admin/')) return raw;
  return fallbackPath;
}

function addUserDeleteMeta(user) {
  if (!user || typeof user !== 'object') return user;
  const deletedAt = user.deletedAt || null;
  const purgeAt = deletedAt ? getSoftDeletePurgeAt(deletedAt, ACCOUNT_DELETION_RETENTION_DAYS) : null;
  const daysLeft = purgeAt
    ? Math.max(0, Math.ceil((purgeAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;

  return {
    ...user,
    deletionMeta: {
      retentionDays: ACCOUNT_DELETION_RETENTION_DAYS,
      purgeAt,
      daysLeft
    }
  };
}

function parseSelectedLanguageCodes(raw) {
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const normalized = [];
  for (const value of values) {
    const code = `${value || ''}`.trim().toLowerCase();
    if (!SUPPORTED_CHAT_LANGUAGE_CODES.includes(code)) continue;
    if (!normalized.includes(code)) normalized.push(code);
  }
  return normalized;
}

function parseModeRoles(mode) {
  const parts = `${mode || ''}`.toLowerCase().split('_');
  const roleA = parts[0] === 'listen' ? 'listen' : 'talk';
  const roleB = parts[1] === 'listen' ? 'listen' : 'talk';
  return { roleA, roleB };
}

function makeSilentWavBase64(durationMs = 800, sampleRate = 16000) {
  const safeDurationMs = Number.isFinite(Number(durationMs)) ? Math.max(100, Number(durationMs)) : 800;
  const safeSampleRate = Number.isFinite(Number(sampleRate)) ? Math.max(8000, Number(sampleRate)) : 16000;
  const sampleCount = Math.max(1, Math.floor((safeSampleRate * safeDurationMs) / 1000));
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(safeSampleRate, 24);
  buffer.writeUInt32LE(safeSampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer.toString('base64');
}

function parseFeatureFlagsObject(featureFlagsJson) {
  const parsed = safeJsonParse(featureFlagsJson, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed;
}

function parseAdminModelTestResults(featureFlagsJson) {
  const flags = parseFeatureFlagsObject(featureFlagsJson);
  const raw = flags[ADMIN_MODEL_TEST_RESULTS_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const normalized = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const msNumber = Number(value.responseMs);
    const testedAt = `${value.lastTested || ''}`.trim();
    normalized[key] = {
      isWorking: value.isWorking === true,
      responseMs: Number.isFinite(msNumber) ? msNumber : null,
      lastTested: testedAt || null
    };
  }
  return normalized;
}

function withAdminModelTestResult(featureFlagsJson, resultKey, payload) {
  const flags = parseFeatureFlagsObject(featureFlagsJson);
  const current = flags[ADMIN_MODEL_TEST_RESULTS_KEY];
  const next = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
  next[resultKey] = payload;

  const merged = {
    ...flags,
    [ADMIN_MODEL_TEST_RESULTS_KEY]: next
  };

  return JSON.stringify(merged);
}

async function persistAdminModelTestResult({ category, modelId, success, ms }) {
  const resultKey = `${category}:${modelId}`;
  const config = await prisma.appConfig.findUnique({
    where: { id: 1 },
    select: { featureFlagsJson: true }
  });
  if (!config) return;

  const featureFlagsJson = withAdminModelTestResult(config.featureFlagsJson, resultKey, {
    isWorking: Boolean(success),
    responseMs: success && Number.isFinite(ms) ? Math.round(ms) : null,
    lastTested: new Date().toISOString()
  });

  await prisma.appConfig.update({
    where: { id: 1 },
    data: { featureFlagsJson }
  });
}

function buildAdminModelRows({ availableModels, proConfig, adminModelTestResults }) {
  const rows = [];
  const testResults = adminModelTestResults && typeof adminModelTestResults === 'object'
    ? adminModelTestResults
    : {};

  for (const model of availableModels) {
    rows.push({
      rowId: `openrouter:${model.modelId}`,
      modelId: model.modelId,
      name: model.name || model.modelId,
      category: 'openrouter',
      categoryLabel: 'OpenRouter parser',
      typeGroup: 'openrouter',
      isWorking: Boolean(model.isWorking),
      responseMs: Number.isFinite(model.responseMs) ? Number(model.responseMs) : null,
      lastTested: model.lastTested || null
    });
  }

  const tierPools = getTierModelPools();
  const dynamicCategoryDefs = [...PRO_MODEL_CATEGORY_DEFS, ...TEXT_POOL_CATEGORY_DEFS];
  const source = proConfig && typeof proConfig === 'object' ? proConfig : {};
  for (const def of dynamicCategoryDefs) {
    const list = def.listKey
      ? Array.isArray(source[def.listKey])
        ? source[def.listKey]
        : []
      : Array.isArray(tierPools?.[def.tier])
      ? tierPools[def.tier]
      : [];
    const seen = new Set();
    for (const modelIdRaw of list) {
      const modelId = `${modelIdRaw || ''}`.trim();
      if (!modelId) continue;
      if (seen.has(modelId)) continue;
      seen.add(modelId);
      const persisted = testResults[`${def.key}:${modelId}`] || null;
      const persistedDate = persisted?.lastTested ? new Date(persisted.lastTested) : null;
      const normalizedDate =
        persistedDate && Number.isFinite(persistedDate.getTime()) ? persistedDate : null;
      rows.push({
        rowId: `${def.key}:${modelId}`,
        modelId,
        name: modelId,
        category: def.key,
        categoryLabel: def.label,
        typeGroup: def.typeGroup,
        isWorking: persisted ? persisted.isWorking === true : null,
        responseMs: persisted && Number.isFinite(persisted.responseMs) ? persisted.responseMs : null,
        lastTested: normalizedDate
      });
    }
  }

  return rows;
}

function normalizeBaseUrl(value) {
  return `${value || ''}`.trim().replace(/\/+$/, '');
}

function resolveRealtimeProbeUrl(baseUrl, modelId) {
  const normalizedModel = `${modelId || ''}`.trim();
  if (!normalizedModel) {
    throw new Error('Realtime model id is required');
  }

  const fallbackHost = 'dashscope-intl.aliyuncs.com';
  const normalizedBase = normalizeBaseUrl(baseUrl);
  if (!normalizedBase) {
    return `wss://${fallbackHost}/api-ws/v1/realtime?model=${encodeURIComponent(normalizedModel)}`;
  }

  try {
    const parsed = new URL(normalizedBase);
    const host = `${parsed.host || ''}`.trim() || fallbackHost;
    return `wss://${host}/api-ws/v1/realtime?model=${encodeURIComponent(normalizedModel)}`;
  } catch (_error) {
    return `wss://${fallbackHost}/api-ws/v1/realtime?model=${encodeURIComponent(normalizedModel)}`;
  }
}

function probeRealtimeModelWithKey({ apiKey, baseUrl, modelId, timeoutMs = 12000 }) {
  const realtimeUrl = resolveRealtimeProbeUrl(baseUrl, modelId);

  return new Promise((resolve, reject) => {
    let settled = false;
    let socket = null;
    let timer = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (socket) {
        socket.removeAllListeners();
      }
    };

    const finishSuccess = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        socket.close(1000, 'probe-ok');
      } catch (_error) {
        // Ignore close errors.
      }
      resolve();
    };

    const finishError = (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        socket.close(1000, 'probe-failed');
      } catch (_error) {
        // Ignore close errors.
      }
      reject(new Error(`${message || 'Realtime probe failed'}`.trim()));
    };

    timer = setTimeout(() => {
      finishError(`Realtime probe timeout for model ${modelId}`);
    }, timeoutMs);

    socket = new WebSocket(realtimeUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    socket.once('open', () => {
      finishSuccess();
    });

    socket.once('error', (error) => {
      finishError(error?.message || `Realtime websocket error for model ${modelId}`);
    });

    socket.once('close', (code, reason) => {
      if (settled) return;
      const details = `${reason || ''}`.trim();
      finishError(`Realtime socket closed (${code}${details ? `: ${details}` : ''})`);
    });
  });
}

async function runRealtimeProbeWithFallback({ apiKey, apiKeys, baseUrl, modelId }) {
  const chain = [];
  const push = (value) => {
    const normalized = `${value || ''}`.trim();
    if (!normalized || chain.includes(normalized)) return;
    chain.push(normalized);
  };

  push(apiKey);
  if (Array.isArray(apiKeys)) {
    for (const item of apiKeys) push(item);
  }

  if (!chain.length) {
    throw new Error('PRO API key is not configured');
  }

  const errors = [];
  for (const key of chain) {
    try {
      await probeRealtimeModelWithKey({ apiKey: key, baseUrl, modelId });
      return;
    } catch (error) {
      errors.push(error?.message || 'realtime probe failed');
    }
  }

  throw new Error(errors[0] || 'Realtime probe failed');
}

async function testProModelByCategory({ modelId, category, proConfig }) {
  const cfg = proConfig && typeof proConfig === 'object' ? proConfig : {};
  const apiKey = resolveProApiKey(cfg);
  const apiKeys = resolveProApiKeys(cfg);
  const baseUrl = `${cfg.baseUrl || ''}`.trim();

  if (!apiKey && !apiKeys.length) {
    throw new Error('Не найден API ключ PRO режима');
  }

  if (!baseUrl) {
    throw new Error('Не задан baseUrl PRO провайдера');
  }

  const common = {
    apiKey,
    apiKeys,
    baseUrl,
    modelCandidates: [modelId]
  };
  const isTextPoolCategory = TEXT_POOL_CATEGORY_DEFS.some((item) => item.key === category);

  if (category === 'pro_text' || category === 'pro_vision' || isTextPoolCategory) {
    await runChatWithFallback({
      ...common,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      temperature: 0,
      maxTokens: 8
    });
    return;
  }

  if (category === 'pro_voice_realtime') {
    const normalizedModelId = `${modelId || ''}`.trim().toLowerCase();
    const isRealtimeModel = normalizedModelId.includes('realtime');

    if (isRealtimeModel) {
      await runRealtimeProbeWithFallback({
        apiKey,
        apiKeys,
        baseUrl,
        modelId
      });
      return;
    }

    // Non-realtime omni models in this chain are tested via chat fallback.
    await runChatWithFallback({
      ...common,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      temperature: 0,
      maxTokens: 8
    });
    return;
  }

  if (category === 'pro_image_gen') {
    await runImageGenerationWithFallback({
      ...common,
      prompt: 'Minimal abstract gradient test image, no text',
      size: '512*512'
    });
    return;
  }

  if (category === 'pro_image_edit') {
    await runImageEditWithFallback({
      ...common,
      prompt: 'Change image style to simple flat illustration',
      imageUrl: ADMIN_TEST_IMAGE_URL,
      size: '512*512'
    });
    return;
  }

  if (category === 'pro_video_gen') {
    await runVideoGenerationWithFallback({
      ...common,
      prompt: 'Short calm abstract motion, no text',
      size: '1280*720',
      durationSeconds: 2,
      aspectRatio: '16:9'
    });
    return;
  }

  if (category === 'pro_voice_asr') {
    await runTranscriptionWithFallback({
      ...common,
      audioBase64: makeSilentWavBase64(800, 16000),
      mimeType: 'audio/wav',
      language: 'ru'
    });
    return;
  }

  if (category === 'pro_voice_tts') {
    await runSpeechSynthesisWithFallback({
      ...common,
      input: 'Привет. Это тест синтеза речи.',
      voice: 'Chelsie'
    });
    return;
  }

  throw new Error(`Неизвестная категория модели: ${category}`);
}

function normalizeBanLevel(levelRaw) {
  const level = `${levelRaw || ''}`.trim().toUpperCase();
  if (level === 'SOFT' || level === 'HARD' || level === 'PERMANENT') {
    return level;
  }
  return 'HARD';
}

function normalizeBanDurationMinutes(durationMinutesRaw, level, fallbackMinutes = null) {
  if (level === 'PERMANENT') return null;
  const defaultMinutes = Number.isFinite(Number(fallbackMinutes))
    ? Number(fallbackMinutes)
    : level === 'SOFT'
    ? 60
    : 24 * 60;
  const numeric = Number(durationMinutesRaw);
  if (!Number.isFinite(numeric)) return defaultMinutes;
  return Math.min(Math.max(Math.round(numeric), 1), 24 * 180 * 60);
}

function formatAnonReport(logRow) {
  const details = safeJsonParse(logRow?.detailsJson, {}) || {};
  return {
    id: logRow.id,
    createdAt: logRow.createdAt,
    sessionId: logRow.sessionId || details.sessionId || null,
    targetUserId: logRow.userId || details.targetUserId || null,
    targetUsername: details.targetUsername || null,
    reporterId: details.reporterId || null,
    reporterUsername: details.reporterUsername || null,
    messageId: details.messageId || null,
    reason: details.reason || logRow.triggerWord || 'manual_report',
    reportedText: details.reportedText || null
  };
}

function parseUserGoals(rawGoals) {
  if (Array.isArray(rawGoals)) {
    return rawGoals.map((item) => `${item || ''}`.trim()).filter(Boolean);
  }

  const text = `${rawGoals || ''}`.trim();
  if (!text) return [];

  const parsed = safeJsonParse(text, null);
  if (Array.isArray(parsed)) {
    return parsed.map((item) => `${item || ''}`.trim()).filter(Boolean);
  }

  return [];
}

function collectTextValues(source, bucket = [], depth = 0) {
  if (!source || depth > 4 || bucket.length >= 32) return bucket;

  if (typeof source === 'string') {
    const text = source.trim();
    if (text) bucket.push(text);
    return bucket;
  }

  if (Array.isArray(source)) {
    for (const item of source) {
      collectTextValues(item, bucket, depth + 1);
      if (bucket.length >= 32) break;
    }
    return bucket;
  }

  if (typeof source === 'object') {
    for (const value of Object.values(source)) {
      collectTextValues(value, bucket, depth + 1);
      if (bucket.length >= 32) break;
    }
  }

  return bucket;
}

function extractProfileList(profile, keys, limit = 6) {
  const source = profile && typeof profile === 'object' ? profile : {};
  const values = [];

  for (const key of keys) {
    if (!(key in source)) continue;
    collectTextValues(source[key], values);
    if (values.length >= limit) break;
  }

  const uniq = [];
  const seen = new Set();
  for (const item of values) {
    const normalized = item.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    uniq.push(item);
    if (uniq.length >= limit) break;
  }

  return uniq;
}

function buildUserProfileOverview({ user, memoryProfile, recentFacts }) {
  const profile = memoryProfile && typeof memoryProfile === 'object' ? memoryProfile : {};
  const goals = parseUserGoals(user?.goals);

  const struggles = extractProfileList(profile, [
    'struggles',
    'issues',
    'problems',
    'pain_points',
    'painPoints',
    'concerns',
    'fears',
    'triggers',
    'anxieties',
    'stressors'
  ]);

  const supports = extractProfileList(profile, [
    'supports',
    'coping',
    'coping_strategies',
    'copingStrategies',
    'resources',
    'strengths',
    'stabilizers'
  ]);

  const focusAreas = extractProfileList(profile, [
    'focus',
    'focus_areas',
    'focusAreas',
    'topics',
    'themes',
    'interests'
  ]);

  const facts = Array.isArray(recentFacts) ? recentFacts : [];
  const factHighlights = facts
    .map((item) => `${item?.detail || ''}`.trim())
    .filter(Boolean)
    .slice(0, 6);

  return {
    age: Number.isFinite(Number(user?.age)) ? Number(user.age) : null,
    goals,
    struggles,
    supports,
    focusAreas,
    factHighlights
  };
}

router.get('/login', (_req, res) => {
  res.render('login', { error: null });
});

router.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
  const { username, password } = req.body;
  const admin = await prisma.user.findUnique({ where: { username } });

  if (!admin || admin.role !== 'ADMIN') {
    return res.status(401).render('login', { error: 'Неверный логин или пароль' });
  }

  const ok = await comparePassword(password, admin.passwordHash);
  if (!ok) {
    return res.status(401).render('login', { error: 'Неверный логин или пароль' });
  }

  if (admin.isBlocked || admin.isDeleted) {
    return res.status(403).render('login', { error: 'Аккаунт администратора заблокирован' });
  }

  const token = signAdminPanelToken(admin);
  res.cookie('admin_panel_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 8 * 60 * 60 * 1000
  });

  return res.redirect('/admin');
});

router.post('/logout', (_req, res) => {
  res.clearCookie('admin_panel_token');
  res.redirect('/admin/login');
});

router.use(requireAdminPanelAuth);

router.get('/', async (req, res) => {
  const metrics = await getDashboardMetrics();
  const [latestUsers, latestCrises] = await Promise.all([
    prisma.user.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' },
      select: { id: true, username: true, displayName: true, createdAt: true }
    }),
    prisma.crisisEvent.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { username: true } } }
    })
  ]);

  res.render('dashboard', { admin: req.admin, metrics, latestUsers, latestCrises });
});

router.get('/users', async (req, res) => {
  const q = (req.query.q || '').toString();
  const usersRaw = await prisma.user.findMany({
    where: q
      ? {
          OR: [{ username: { contains: q } }, { displayName: { contains: q } }]
        }
      : undefined,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      isBlocked: true,
      isDeleted: true,
      deletedAt: true,
      createdAt: true,
      memoryProfile: {
        select: {
          profileJson: true,
          isDeleted: true,
          updatedAt: true
        }
      },
      _count: {
        select: {
          sessionSummaries: true,
          facts: true
        }
      }
    }
  });

  const users = usersRaw.map((user) => {
    const profileJson = `${user.memoryProfile?.profileJson || ''}`.trim();
    const hasProfile = Boolean(
      !user.memoryProfile?.isDeleted && profileJson && profileJson !== '{}' && profileJson !== 'null'
    );

    return {
      ...user,
      memoryStats: {
        summaries: user._count.sessionSummaries,
        facts: user._count.facts,
        hasProfile,
        profileUpdatedAt: user.memoryProfile?.updatedAt || null
      }
    };
  });

  const memoryTotals = users.reduce(
    (acc, user) => {
      acc.users += 1;
      acc.withProfile += user.memoryStats.hasProfile ? 1 : 0;
      acc.summaries += user.memoryStats.summaries;
      acc.facts += user.memoryStats.facts;
      return acc;
    },
    { users: 0, withProfile: 0, summaries: 0, facts: 0 }
  );

  res.render('users', { admin: req.admin, users, q, memoryTotals });
});

router.get('/users/:id', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    include: {
      chats: { take: 10, orderBy: [{ isDeleted: 'asc' }, { updatedAt: 'desc' }] },
      proChats: { take: 10, orderBy: [{ isDeleted: 'asc' }, { updatedAt: 'desc' }] },
      _count: {
        select: {
          chats: true,
          proChats: true,
          moodEntries: true,
          crisisEvents: true,
          chatSessionsAsA: true,
          chatSessionsAsB: true,
          pushEndpoints: true,
          inboxDeliveries: true
        }
      }
    }
  });

  if (!user) {
    return res.status(404).send('Пользователь не найден');
  }
  const syncedGlobal = await syncGlobalBlockState(user);
  const effectiveUserRaw = syncedGlobal.user || user;
  const effectiveUser = {
    ...effectiveUserRaw,
    _count: effectiveUserRaw?._count || user?._count || {}
  };

  const [
    activeAnonBan,
    activeGlobalBan,
    recentAnonBans,
    recentGlobalBans,
    anonSessionsRaw,
    memoryProfileRow,
    recentFacts,
    appConfigRow
  ] = await Promise.all([
    getActiveBanForUser(effectiveUser.id, BAN_SCOPE.ANON),
    getActiveBanForUser(effectiveUser.id, BAN_SCOPE.GLOBAL),
    prisma.ban.findMany({
      where: { userId: effectiveUser.id, scope: BAN_SCOPE.ANON },
      orderBy: [{ createdAt: 'desc' }],
      take: 8
    }),
    prisma.ban.findMany({
      where: { userId: effectiveUser.id, scope: BAN_SCOPE.GLOBAL },
      orderBy: [{ createdAt: 'desc' }],
      take: 8
    }),
    prisma.chatSession.findMany({
      where: {
        OR: [{ userAId: effectiveUser.id }, { userBId: effectiveUser.id }]
      },
      orderBy: [{ startedAt: 'desc' }],
      take: 20,
      include: {
        userA: {
          select: {
            id: true,
            username: true,
            displayName: true,
            isBlocked: true,
            isDeleted: true
          }
        },
        userB: {
          select: {
            id: true,
            username: true,
            displayName: true,
            isBlocked: true,
            isDeleted: true
          }
        },
        hiddenForUsers: {
          where: { userId: effectiveUser.id },
          orderBy: [{ hiddenAt: 'desc' }],
          take: 1,
          select: {
            userId: true,
            hiddenAt: true
          }
        },
        _count: {
          select: {
            messages: true,
            modActions: true,
            modLogs: true,
            hiddenForUsers: true
          }
        }
      }
    }),
    prisma.userMemoryProfile.findUnique({
      where: { userId: effectiveUser.id },
      select: {
        profileJson: true,
        isDeleted: true,
        updatedAt: true
      }
    }),
    prisma.userFact.findMany({
      where: {
        userId: effectiveUser.id,
        deletedAt: null
      },
      orderBy: [{ shouldFollowup: 'desc' }, { updatedAt: 'desc' }, { createdAt: 'desc' }],
      take: 12,
      select: {
        id: true,
        category: true,
        detail: true,
        emotionalWeight: true,
        shouldFollowup: true,
        createdAt: true
      }
    }),
    prisma.appConfig.findUnique({
      where: { id: 1 },
      select: { featureFlagsJson: true, openrouterApiKey: true, openrouterModel: true }
    })
  ]);

  const sessionIds = anonSessionsRaw.map((item) => item.id);
  const reportRows = sessionIds.length
    ? await prisma.modLog.groupBy({
        by: ['sessionId'],
        where: {
          type: 'USER_REPORT',
          sessionId: { in: sessionIds }
        },
        _count: { _all: true }
      })
    : [];

  const reportsCountBySession = new Map(
    reportRows.map((item) => [item.sessionId, item._count?._all || 0])
  );

  const anonSessions = anonSessionsRaw.map((session) => {
    const isUserA = session.userAId === effectiveUser.id;
    const roles = parseModeRoles(session.mode);
    return {
      ...session,
      roles,
      myRole: isUserA ? roles.roleA : roles.roleB,
      partnerRole: isUserA ? roles.roleB : roles.roleA,
      partner: isUserA ? session.userB : session.userA,
      reportsCount: reportsCountBySession.get(session.id) || 0,
      isHiddenByUser: Boolean(session.hiddenForUsers?.length),
      hiddenAt: session.hiddenForUsers?.[0]?.hiddenAt || null,
      hiddenForUsersCount: session._count?.hiddenForUsers || 0
    };
  });

  const parsedProfile =
    memoryProfileRow && !memoryProfileRow.isDeleted
      ? safeJsonParse(memoryProfileRow.profileJson || '{}', {})
      : {};
  const profileOverview = buildUserProfileOverview({
    user: effectiveUser,
    memoryProfile: parsedProfile,
    recentFacts
  });
  const proConfig = getProConfig(appConfigRow?.featureFlagsJson);
  const userProAllowed = hasProAccess(effectiveUser, proConfig);
  const userProOverride = getUserProOverride(proConfig, effectiveUser.id);
  const userProEffective = getEffectiveProConfigForUser(proConfig, effectiveUser);

  res.render('user-detail', {
    admin: req.admin,
    user: effectiveUser,
    activeAnonBan,
    activeGlobalBan,
    recentAnonBans,
    recentGlobalBans,
    anonSessions,
    profileOverview,
    memoryProfileUpdatedAt: memoryProfileRow?.updatedAt || null,
    proConfig,
    userProAllowed,
    userProOverride,
    userProEffective
  });
});

router.get('/users/:id/security', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      isBlocked: true,
      isDeleted: true,
      deletedAt: true,
      deletedReason: true,
      createdAt: true
    }
  });

  if (!user) {
    return res.status(404).send('Пользователь не найден');
  }

  const [sessions, loginEvents, activeAnonBan, activeGlobalBan] = await Promise.all([
    prisma.refreshToken.findMany({
      where: {
        userId: user.id,
        expiresAt: { gt: new Date() }
      },
      orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }]
    }),
    prisma.loginEvent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 300
    }),
    getActiveBanForUser(user.id, BAN_SCOPE.ANON),
    getActiveBanForUser(user.id, BAN_SCOPE.GLOBAL)
  ]);

  res.render('user-security', {
    admin: req.admin,
    user: addUserDeleteMeta(user),
    sessions,
    loginEvents,
    activeAnonBan,
    activeGlobalBan,
    deletionRetentionDays: ACCOUNT_DELETION_RETENTION_DAYS
  });
});

router.post('/users/:id/sessions/kick-all', async (req, res) => {
  const target = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { id: true, username: true }
  });
  if (!target) return res.status(404).send('Пользователь не найден');

  const result = await revokeAllUserSessions(target.id);
  await writeAuditLog({
    adminId: req.admin.id,
    action: 'USER_ALL_SESSIONS_REVOKED',
    targetUserId: target.id,
    meta: {
      via: 'admin-panel',
      revokedSessions: result.deletedSessions,
      disconnectedSockets: result.disconnectedSockets
    }
  });

  res.redirect(`/admin/users/${target.id}/security?success=1`);
});

router.post('/users/:id/sessions/:sessionId/kick', async (req, res) => {
  const target = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { id: true, username: true }
  });
  if (!target) return res.status(404).send('Пользователь не найден');

  const sessionId = `${req.params.sessionId || ''}`.trim();
  if (!sessionId) return res.status(400).send('Не указан sessionId');

  const result = await revokeSingleUserSession(target.id, sessionId);
  if (!result.deletedSessions) {
    return res.status(404).send('Сессия не найдена');
  }

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'USER_SESSION_REVOKED',
    targetUserId: target.id,
    meta: {
      via: 'admin-panel',
      sessionId,
      disconnectedSockets: result.disconnectedSockets
    }
  });

  res.redirect(`/admin/users/${target.id}/security?success=1`);
});

router.post('/users/:id/memory/rebuild', express.urlencoded({ extended: false }), async (req, res) => {
  const target = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { id: true, username: true }
  });
  if (!target) return res.status(404).send('Пользователь не найден');

  const result = await rebuildMemoryForUser(target.id);
  await writeAuditLog({
    adminId: req.admin.id,
    action: 'USER_MEMORY_REBUILT',
    targetUserId: target.id,
    meta: {
      via: 'admin-panel',
      result
    }
  });

  const redirectTo = `${req.body.redirectTo || `/admin/users/${target.id}`}`.trim();
  const safeRedirect = redirectTo.startsWith('/admin/') ? redirectTo : `/admin/users/${target.id}`;
  const hasErrors = Array.isArray(result.errors) && result.errors.length > 0 ? '1' : '0';
  const separator = safeRedirect.includes('?') ? '&' : '?';

  res.redirect(`${safeRedirect}${separator}memoryRebuilt=1&memoryErrors=${hasErrors}`);
});

router.post('/users/:id/pro-access', express.urlencoded({ extended: false }), async (req, res) => {
  const target = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { id: true, username: true, role: true }
  });
  if (!target) return res.status(404).send('???????????? ?? ??????');

  const config = await prisma.appConfig.findUnique({
    where: { id: 1 },
    select: { featureFlagsJson: true }
  });
  if (!config) return res.status(404).send('???????????? ?????????? ?? ???????');

  const previousConfig = getProConfig(config.featureFlagsJson);
  const hadAccessBefore = hasProAccess(target, previousConfig);
  const nextEnabled = parseCheckbox(req.body.enabled);
  // Keep allowlist in sync, but real quick-toggle access is controlled by per-user override.
  const allowlistSynced = setUserProAccess(config.featureFlagsJson, target.id, nextEnabled);
  const result = setUserProOverride(allowlistSynced.featureFlagsJson, target.id, {
    access: nextEnabled ? 'allow' : 'deny'
  });
  const hasAccessAfter = hasProAccess(target, result.proConfig);

  await prisma.appConfig.update({
    where: { id: 1 },
    data: { featureFlagsJson: result.featureFlagsJson }
  });

  emitProAccessUpdateToUser(target.id, {
    source: 'admin:user-pro-access',
    enabled: hasAccessAfter,
    previousEnabled: hadAccessBefore
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: nextEnabled ? 'USER_PRO_ACCESS_GRANTED' : 'USER_PRO_ACCESS_REVOKED',
    targetUserId: target.id,
    meta: {
      via: 'admin-panel',
      username: target.username
    }
  });

  const fallbackPath = `/admin/users/${target.id}/pro`;
  res.redirect(parseAdminRedirect(req, fallbackPath));
});

router.get('/users/:id/pro', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      isBlocked: true,
      isDeleted: true,
      createdAt: true
    }
  });
  if (!user) return res.status(404).send('Пользователь не найден');

  const appConfig = await prisma.appConfig.findUnique({
    where: { id: 1 },
    select: { featureFlagsJson: true }
  });
  if (!appConfig) return res.status(404).send('Конфигурация приложения не найдена');

  const proConfig = getProConfig(appConfig.featureFlagsJson);
  const userProAllowed = hasProAccess(user, proConfig);
  const userProOverride = getUserProOverride(proConfig, user.id);
  const userProEffective = getEffectiveProConfigForUser(proConfig, user);

  res.render('user-pro', {
    admin: req.admin,
    user,
    proConfig,
    userProAllowed,
    userProOverride,
    userProEffective
  });
});

router.post('/users/:id/pro-override', express.urlencoded({ extended: false }), async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { id: true, username: true }
  });
  if (!user) return res.status(404).send('Пользователь не найден');

  const appConfig = await prisma.appConfig.findUnique({
    where: { id: 1 },
    select: { featureFlagsJson: true }
  });
  if (!appConfig) return res.status(404).send('Конфигурация приложения не найдена');

  const accessRaw = `${req.body.access || 'inherit'}`.trim().toLowerCase();
  const access = accessRaw === 'allow' || accessRaw === 'deny' ? accessRaw : 'inherit';
  const currentConfig = getProConfig(appConfig.featureFlagsJson);
  const effectiveBefore = getEffectiveProConfigForUser(currentConfig, user);
  const beforeLimits =
    effectiveBefore?.limits && typeof effectiveBefore.limits === 'object' ? effectiveBefore.limits : {};
  const hadAccessBefore = hasProAccess(user, currentConfig);

  const maxFileAnalyzeMb = parseOptionalPositiveInt(
    req.body.maxFileAnalyzeMb,
    Math.max(1, Math.round((Number(beforeLimits.maxFileAnalyzeBytes) || 8 * 1024 * 1024) / (1024 * 1024))),
    1,
    20
  );
  const maxVoiceAudioMb = parseOptionalPositiveInt(
    req.body.maxVoiceAudioMb,
    Math.max(1, Math.round((Number(beforeLimits.maxVoiceAudioBase64Chars) || 20 * 1024 * 1024) / (1024 * 1024))),
    1,
    20
  );

  const result = setUserProOverride(appConfig.featureFlagsJson, user.id, {
    access,
    features: {
      imageAnalysisEnabled: parseCheckbox(req.body.imageAnalysisEnabled),
      imageGenerationEnabled: parseCheckbox(req.body.imageGenerationEnabled),
      imageEditingEnabled: parseCheckbox(req.body.imageEditingEnabled),
      videoGenerationEnabled: parseCheckbox(req.body.videoGenerationEnabled),
      voiceMessagesEnabled: parseCheckbox(req.body.voiceMessagesEnabled),
      voiceRealtimeEnabled: parseCheckbox(req.body.voiceRealtimeEnabled),
      fileAnalysisEnabled: parseCheckbox(req.body.fileAnalysisEnabled)
    },
    limits: {
      maxOutputTokens: parseOptionalPositiveInt(
        req.body.maxOutputTokens,
        parseOptionalPositiveInt(beforeLimits.maxOutputTokens, 2048, 128, 8192),
        128,
        8192
      ),
      maxFileAnalyzeBytes: maxFileAnalyzeMb * 1024 * 1024,
      maxImagePromptChars: parseOptionalPositiveInt(
        req.body.maxImagePromptChars,
        parseOptionalPositiveInt(beforeLimits.maxImagePromptChars, 4000, 200, 12000),
        200,
        12000
      ),
      maxVideoPromptChars: parseOptionalPositiveInt(
        req.body.maxVideoPromptChars,
        parseOptionalPositiveInt(beforeLimits.maxVideoPromptChars, 4000, 200, 12000),
        200,
        12000
      ),
      maxVoiceAudioBase64Chars: maxVoiceAudioMb * 1024 * 1024,
      maxVideoDurationSeconds: parseOptionalPositiveInt(
        req.body.maxVideoDurationSeconds,
        parseOptionalPositiveInt(beforeLimits.maxVideoDurationSeconds, 120, 1, 180),
        1,
        180
      ),
      maxMessagesPerRequest: parseOptionalPositiveInt(
        req.body.maxMessagesPerRequest,
        parseOptionalPositiveInt(beforeLimits.maxMessagesPerRequest, 60, 1, 120),
        1,
        120
      ),
      maxImageAnalysesPerDay: parseOptionalPositiveInt(
        req.body.maxImageAnalysesPerDay,
        parseOptionalPositiveInt(beforeLimits.maxImageAnalysesPerDay, 40, 1, 5000),
        1,
        5000
      ),
      maxImageGenerationsPerDay: parseOptionalPositiveInt(
        req.body.maxImageGenerationsPerDay,
        parseOptionalPositiveInt(beforeLimits.maxImageGenerationsPerDay, 5, 1, 5000),
        1,
        5000
      ),
      maxImageEditsPerDay: parseOptionalPositiveInt(
        req.body.maxImageEditsPerDay,
        parseOptionalPositiveInt(beforeLimits.maxImageEditsPerDay, 20, 1, 5000),
        1,
        5000
      ),
      maxVideoGenerationsPerDay: parseOptionalPositiveInt(
        req.body.maxVideoGenerationsPerDay,
        parseOptionalPositiveInt(beforeLimits.maxVideoGenerationsPerDay, 5, 1, 5000),
        1,
        5000
      ),
      maxVoiceMessagesPerDay: parseOptionalPositiveInt(
        req.body.maxVoiceMessagesPerDay,
        parseOptionalPositiveInt(beforeLimits.maxVoiceMessagesPerDay, 80, 1, 5000),
        1,
        5000
      ),
      maxVoiceRealtimeSessionsPerDay: parseOptionalPositiveInt(
        req.body.maxVoiceRealtimeSessionsPerDay,
        parseOptionalPositiveInt(beforeLimits.maxVoiceRealtimeSessionsPerDay, 60, 1, 5000),
        1,
        5000
      ),
      maxFileAnalysesPerDay: parseOptionalPositiveInt(
        req.body.maxFileAnalysesPerDay,
        parseOptionalPositiveInt(beforeLimits.maxFileAnalysesPerDay, 30, 1, 5000),
        1,
        5000
      )
    }
  });
  const hasAccessAfter = hasProAccess(user, result.proConfig);

  await prisma.appConfig.update({
    where: { id: 1 },
    data: { featureFlagsJson: result.featureFlagsJson }
  });

  emitProAccessUpdateToUser(user.id, {
    source: 'admin:user-pro-override',
    enabled: hasAccessAfter,
    previousEnabled: hadAccessBefore
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'USER_PRO_OVERRIDE_UPDATED',
    targetUserId: user.id,
    meta: {
      via: 'admin-panel',
      username: user.username,
      access
    }
  });

  const fallbackPath = `/admin/users/${user.id}/pro?success=1`;
  res.redirect(parseAdminRedirect(req, fallbackPath));
});

async function upsertScopedBan({
  userId,
  scope,
  level,
  reason,
  expiresAt
}) {
  const existingActive = await prisma.ban.findFirst({
    where: {
      userId,
      scope,
      isActive: true
    },
    orderBy: [{ createdAt: 'desc' }]
  });

  if (existingActive) {
    return prisma.ban.update({
      where: { id: existingActive.id },
      data: {
        level,
        reason,
        expiresAt,
        isActive: true
      }
    });
  }

  return prisma.ban.create({
    data: {
      userId,
      scope,
      level,
      reason,
      expiresAt,
      isActive: true
    }
  });
}

router.post('/users/:id/block', express.urlencoded({ extended: false }), async (req, res) => {
  const isBlocked = req.body.isBlocked === 'true';
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).send('Пользователь не найден');

  if (isBlocked) {
    await upsertScopedBan({
      userId: target.id,
      scope: BAN_SCOPE.GLOBAL,
      level: 'PERMANENT',
      reason: 'Нарушение правил',
      expiresAt: null
    });
    await prisma.user.update({ where: { id: target.id }, data: { isBlocked: true } });
    await revokeAllUserSessions(target.id, {
      reason: 'GLOBAL_BLOCKED',
      details: {
        scope: 'GLOBAL',
        timezone: 'Asia/Bishkek',
        reason: 'Нарушение правил',
        ban: {
          scope: 'GLOBAL',
          level: 'PERMANENT',
          reason: 'Нарушение правил',
          expiresAt: null,
          isActive: true
        }
      }
    });
  } else {
    await prisma.$transaction([
      prisma.user.update({ where: { id: target.id }, data: { isBlocked: false } }),
      prisma.ban.updateMany({
        where: {
          userId: target.id,
          scope: BAN_SCOPE.GLOBAL,
          isActive: true
        },
        data: {
          isActive: false,
          expiresAt: new Date()
        }
      })
    ]);
  }

  await writeAuditLog({
    adminId: req.admin.id,
    action: isBlocked ? 'USER_GLOBAL_BLOCKED' : 'USER_GLOBAL_UNBLOCKED',
    targetUserId: target.id,
    meta: { via: 'admin-panel', sourceRoute: 'legacy_block_toggle' }
  });

  res.redirect(parseAdminRedirect(req, `/admin/users/${target.id}`));
});

router.post('/users/:id/anon-ban', express.urlencoded({ extended: false }), async (req, res) => {
  const target = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { id: true, username: true }
  });
  if (!target) return res.status(404).send('Пользователь не найден');

  const level = normalizeBanLevel(req.body.level);
  const durationMinutesInput = Number(req.body.durationMinutes);
  const durationHoursInput = Number(req.body.durationHours);
  const mergedDurationMinutes = Number.isFinite(durationMinutesInput)
    ? durationMinutesInput
    : Number.isFinite(durationHoursInput)
    ? durationHoursInput * 60
    : null;
  const durationMinutes = normalizeBanDurationMinutes(mergedDurationMinutes, level, level === 'SOFT' ? 60 : 24 * 60);
  const reason = `${req.body.reason || ''}`.trim().slice(0, 240) || 'Нарушение правил';
  const expiresAt = level === 'PERMANENT' ? null : new Date(Date.now() + durationMinutes * 60 * 1000);

  await upsertScopedBan({
    userId: target.id,
    scope: BAN_SCOPE.ANON,
    level,
    reason,
    expiresAt
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'USER_ANON_BANNED',
    targetUserId: target.id,
    meta: {
      via: 'admin-panel',
      level,
      reason,
      durationMinutes
    }
  });

  res.redirect(parseAdminRedirect(req, `/admin/users/${target.id}`));
});

router.post('/users/:id/anon-unban', async (req, res) => {
  const target = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { id: true, username: true }
  });
  if (!target) return res.status(404).send('Пользователь не найден');

  const result = await prisma.ban.updateMany({
    where: {
      userId: target.id,
      scope: BAN_SCOPE.ANON,
      isActive: true
    },
    data: {
      isActive: false,
      expiresAt: new Date()
    }
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'USER_ANON_UNBANNED',
    targetUserId: target.id,
    meta: {
      via: 'admin-panel',
      deactivatedBans: result.count
    }
  });

  res.redirect(parseAdminRedirect(req, `/admin/users/${target.id}`));
});

router.post('/users/:id/global-block', express.urlencoded({ extended: false }), async (req, res) => {
  const target = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { id: true, username: true }
  });
  if (!target) return res.status(404).send('Пользователь не найден');

  const level = normalizeBanLevel(req.body.level);
  const durationMinutesInput = Number(req.body.durationMinutes);
  const durationHoursInput = Number(req.body.durationHours);
  const mergedDurationMinutes = Number.isFinite(durationMinutesInput)
    ? durationMinutesInput
    : Number.isFinite(durationHoursInput)
    ? durationHoursInput * 60
    : null;
  const durationMinutes = normalizeBanDurationMinutes(
    mergedDurationMinutes,
    level,
    level === 'SOFT' ? 60 : 24 * 60
  );
  const reason = `${req.body.reason || ''}`.trim().slice(0, 240) || 'Нарушение правил';
  const expiresAt = level === 'PERMANENT' ? null : new Date(Date.now() + durationMinutes * 60 * 1000);

  await prisma.$transaction(async (tx) => {
    const existing = await tx.ban.findFirst({
      where: {
        userId: target.id,
        scope: BAN_SCOPE.GLOBAL,
        isActive: true
      },
      orderBy: [{ createdAt: 'desc' }]
    });

    if (existing) {
      await tx.ban.update({
        where: { id: existing.id },
        data: {
          level,
          reason,
          expiresAt,
          isActive: true
        }
      });
    } else {
      await tx.ban.create({
        data: {
          userId: target.id,
          scope: BAN_SCOPE.GLOBAL,
          level,
          reason,
          expiresAt,
          isActive: true
        }
      });
    }

    await tx.user.update({
      where: { id: target.id },
      data: { isBlocked: true }
    });
  });

  await revokeAllUserSessions(target.id, {
    reason: 'GLOBAL_BLOCKED',
    details: {
      scope: 'GLOBAL',
      timezone: 'Asia/Bishkek',
      reason,
      ban: {
        scope: 'GLOBAL',
        level,
        reason,
        expiresAt,
        isActive: true
      }
    }
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'USER_GLOBAL_BLOCKED',
    targetUserId: target.id,
    meta: {
      via: 'admin-panel',
      level,
      reason,
      durationMinutes
    }
  });

  res.redirect(parseAdminRedirect(req, `/admin/users/${target.id}`));
});

router.post('/users/:id/global-unblock', async (req, res) => {
  const target = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { id: true, username: true }
  });
  if (!target) return res.status(404).send('Пользователь не найден');

  const result = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: target.id },
      data: { isBlocked: false }
    });

    return tx.ban.updateMany({
      where: {
        userId: target.id,
        scope: BAN_SCOPE.GLOBAL,
        isActive: true
      },
      data: {
        isActive: false,
        expiresAt: new Date()
      }
    });
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'USER_GLOBAL_UNBLOCKED',
    targetUserId: target.id,
    meta: {
      via: 'admin-panel',
      deactivatedBans: result.count
    }
  });

  res.redirect(parseAdminRedirect(req, `/admin/users/${target.id}`));
});

router.post('/users/:id/password', express.urlencoded({ extended: false }), async (req, res) => {
  const newPassword = (req.body.newPassword || '').trim();
  if (newPassword.length < 8) {
    return res.status(400).send('Пароль должен быть не короче 8 символов');
  }

  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).send('Пользователь не найден');

  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({
      where: { id: target.id },
      data: {
        passwordHash,
        sessionVersion: { increment: 1 }
      }
    }),
    prisma.refreshToken.deleteMany({ where: { userId: target.id } })
  ]);

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'USER_PASSWORD_RESET',
    targetUserId: target.id,
    meta: { via: 'admin-panel' }
  });

  res.redirect(parseAdminRedirect(req, `/admin/users/${target.id}`));
});

router.post('/users/:id/delete', async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).send('User not found');

  if (target.id === req.admin.id) {
    return res.status(400).send('Cannot delete your own account');
  }
  if (target.role === 'ADMIN') {
    return res.status(400).send('Cannot soft-delete admin accounts via this action');
  }

  const result = await softDeleteUserAccount(target.id, 'deleted_by_admin_panel');
  await writeAuditLog({
    adminId: req.admin.id,
    action: 'USER_SOFT_DELETED',
    targetUserId: target.id,
    meta: {
      via: 'admin-panel',
      deletedUserId: target.id,
      deletedUsername: target.username,
      result
    }
  });

  res.redirect(parseAdminRedirect(req, `/admin/users/${target.id}/security`));
});

router.post('/users/:id/restore', async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).send('User not found');

  const result = await restoreUserAccount(target.id);
  await writeAuditLog({
    adminId: req.admin.id,
    action: 'USER_RESTORED',
    targetUserId: target.id,
    meta: {
      via: 'admin-panel',
      restoredUserId: target.id,
      restoredUsername: target.username,
      result
    }
  });

  res.redirect(parseAdminRedirect(req, `/admin/users/${target.id}/security`));
});

router.post('/users/:id/delete/permanent', express.urlencoded({ extended: false }), async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).send('User not found');

  if (target.id === req.admin.id) {
    return res.status(400).send('Cannot delete your own account');
  }
  if (target.role === 'ADMIN') {
    return res.status(400).send('Cannot permanently delete admin accounts via this action');
  }

  const confirmUsername = `${req.body.confirmUsername || ''}`.trim();
  if (!confirmUsername || confirmUsername !== `${target.username || ''}`.trim()) {
    return res.status(400).send('Confirmation failed: enter the exact username');
  }

  const result = await hardDeleteUserAccount(target.id);
  if (!result?.success || !result?.userDeleted) {
    return res.status(500).send('Failed to permanently delete the account');
  }

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'USER_PERMANENTLY_DELETED',
    targetUserId: target.id,
    meta: {
      via: 'admin-panel',
      deletedUserId: target.id,
      deletedUsername: target.username
    }
  });

  res.redirect(parseAdminRedirect(req, '/admin/users'));
});

router.get('/users/:id/chats', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).send('Пользователь не найден');

  const chats = await prisma.chat.findMany({
    where: { userId: user.id },
    orderBy: [{ isDeleted: 'asc' }, { updatedAt: 'desc' }]
  });

  res.render('chats', { admin: req.admin, user, chats });
});

router.post('/users/:id/chats/:chatId/restore', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).send('Пользователь не найден');

  const result = await restoreChatForUser(req.params.chatId, user.id);
  if (!result.success) return res.status(404).send('Чат не найден или уже активен');

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'CHAT_RESTORED',
    targetUserId: user.id,
    meta: {
      via: 'admin-panel',
      chatId: req.params.chatId
    }
  });

  res.redirect(`/admin/users/${user.id}/chats`);
});

router.post('/users/:id/chats/:chatId/purge', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).send('Пользователь не найден');

  const chat = await prisma.chat.findFirst({
    where: {
      id: req.params.chatId,
      userId: user.id
    },
    select: { id: true }
  });
  if (!chat) return res.status(404).send('Чат не найден');

  await purgeChatById(chat.id);
  await writeAuditLog({
    adminId: req.admin.id,
    action: 'CHAT_PURGED',
    targetUserId: user.id,
    meta: {
      via: 'admin-panel',
      chatId: chat.id
    }
  });

  res.redirect(`/admin/users/${user.id}/chats`);
});

router.get('/users/:id/pro-chats', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).send('???????????? ?? ??????');

  const proChats = await prisma.proChat.findMany({
    where: { userId: user.id },
    orderBy: [{ isDeleted: 'asc' }, { updatedAt: 'desc' }]
  });
  const proChatsWithCount = proChats.map((chat) => ({
    ...chat,
    messageCount: parseProMessagesJson(chat.messagesJson).length
  }));

  res.render('pro-chats', { admin: req.admin, user, proChats: proChatsWithCount });
});

router.get('/users/:id/pro-chats/:chatId', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).send('???????????? ?? ??????');

  const proChat = await prisma.proChat.findFirst({
    where: {
      userId: user.id,
      clientChatId: req.params.chatId
    }
  });
  if (!proChat) return res.status(404).send('PRO-??? ?? ??????');

  const messages = parseProMessagesJson(proChat.messagesJson);
  res.render('pro-chat-detail', { admin: req.admin, user, proChat, messages });
});

router.post('/users/:id/pro-chats/:chatId/restore', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).send('???????????? ?? ??????');

  const result = await restoreProChatForUser(req.params.chatId, user.id);
  if (!result.success) return res.status(404).send('PRO-??? ?? ?????? ??? ??? ???????');

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'PRO_CHAT_RESTORED',
    targetUserId: user.id,
    meta: {
      via: 'admin-panel',
      clientChatId: req.params.chatId
    }
  });

  res.redirect(`/admin/users/${user.id}/pro-chats`);
});

router.post('/users/:id/anon-sessions/:sessionId/restore', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).send('Пользователь не найден');

  const session = await prisma.chatSession.findFirst({
    where: {
      id: req.params.sessionId,
      OR: [{ userAId: user.id }, { userBId: user.id }]
    },
    select: { id: true }
  });
  if (!session) return res.status(404).send('Анонимная сессия не найдена');

  const result = await prisma.userHiddenChatSession.deleteMany({
    where: {
      userId: user.id,
      sessionId: session.id
    }
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'ANON_CHAT_RESTORED_FOR_USER',
    targetUserId: user.id,
    meta: {
      via: 'admin-panel',
      sessionId: session.id,
      removedHiddenRows: result.count
    }
  });

  res.redirect(`/admin/users/${user.id}`);
});

router.get('/chats/:chatId/messages', async (req, res) => {
  const chat = await prisma.chat.findUnique({ where: { id: req.params.chatId }, include: { user: true } });
  if (!chat) return res.status(404).send('Чат не найден');

  const messages = await prisma.message.findMany({
    where: { chatId: chat.id },
    orderBy: { createdAt: 'asc' }
  });

  const normalized = messages.map((message) => ({
    ...message,
    role: message.role === 'USER' ? 'user' : message.role === 'ASSISTANT' ? 'assistant' : 'system'
  }));

  res.render('messages', { admin: req.admin, chat, messages: normalized });
});

router.get('/config', async (req, res) => {
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  const keyFromDb = `${config?.openrouterApiKey || ''}`.trim();
  const memorySettings = getMemorySettings(config?.featureFlagsJson);
  const languagePolicy = getLanguagePolicy(config?.featureFlagsJson);
  const languageOptions = SUPPORTED_CHAT_LANGUAGE_CODES.map((code) => ({
    code,
    label: getLanguageLabel(code)
  }));

  res.render('config', {
    admin: req.admin,
    config,
    modelPresets,
    openrouterApiKeyMasked: keyFromDb ? maskSecret(keyFromDb) : '',
    memorySettings,
    languagePolicy,
    languageOptions
  });
});

router.post('/config', express.urlencoded({ extended: false }), async (req, res) => {
  const currentConfig = await prisma.appConfig.findUnique({ where: { id: 1 } });
  if (!currentConfig) {
    return res.status(404).send('Конфигурация приложения не найдена');
  }

  try {
    JSON.parse(req.body.featureFlagsJson || '{}');
  } catch (_error) {
    return res.status(400).send('featureFlagsJson должен быть валидным JSON');
  }

  const presetModel = `${req.body.openrouterModelPreset || ''}`.trim();
  const customModel = `${req.body.openrouterModel || ''}`.trim();
  const openrouterModel = presetModel && presetModel !== '__custom__' ? presetModel : customModel;

  if (!openrouterModel) {
    return res.status(400).send('Укажите модель OpenRouter');
  }

  const mergedMemory = withMemorySettings(
    req.body.featureFlagsJson,
    getMemorySettings(currentConfig.featureFlagsJson)
  );
  const mergedLanguage = withLanguagePolicy(mergedMemory.featureFlagsJson, {
    enabled: parseCheckbox(req.body.languagePolicyEnabled),
    allowedLanguages: parseSelectedLanguageCodes(req.body.allowedLanguages),
    unsupportedLanguageMessage: req.body.unsupportedLanguageMessage
  });

  const data = {
    systemPrompt: req.body.systemPrompt,
    safetyPrompt: req.body.safetyPrompt,
    openrouterModel,
    featureFlagsJson: mergedLanguage.featureFlagsJson
  };

  const clearOpenrouterApiKey = req.body.clearOpenrouterApiKey === 'true';
  const openrouterApiKey = `${req.body.openrouterApiKey || ''}`.trim();

  if (clearOpenrouterApiKey) {
    data.openrouterApiKey = null;
  } else if (openrouterApiKey) {
    data.openrouterApiKey = openrouterApiKey;
  }

  await prisma.appConfig.update({ where: { id: 1 }, data });
  await writeAuditLog({
    adminId: req.admin.id,
    action: 'APP_CONFIG_UPDATED',
    meta: { via: 'admin-panel', languagePolicy: mergedLanguage.languagePolicy }
  });

  res.redirect('/admin/config');
});

router.get('/onboarding-test', async (req, res) => {
  const config = await prisma.appConfig.findUnique({
    where: { id: 1 },
    select: { featureFlagsJson: true }
  });

  if (!config) {
    return res.status(404).send('Application config not found');
  }

  const onboardingConfig = getOnboardingPersonalizationConfig(config.featureFlagsJson);
  const users = await listOnboardingTargetUsers(500);

  res.render('onboarding-test', {
    admin: req.admin,
    onboardingConfig,
    users,
    success: `${req.query.success || ''}` === '1',
    forced: `${req.query.forced || ''}` === '1',
    sent: `${req.query.sent || ''}` === '1',
    errorMessage: `${req.query.error || ''}`.trim()
  });
});

router.post('/onboarding-test', express.urlencoded({ extended: false }), async (req, res) => {
  const config = await prisma.appConfig.findUnique({
    where: { id: 1 },
    select: { featureFlagsJson: true }
  });

  if (!config) {
    return res.status(404).send('Application config not found');
  }

  const current = getOnboardingPersonalizationConfig(config.featureFlagsJson);
  let questions;
  try {
    questions = parseOnboardingQuestionsInput(req.body.testQuestionsJson);
  } catch (error) {
    return res.redirect(`/admin/onboarding-test?error=${encodeURIComponent(error.message)}`);
  }

  const patch = {
    enabled: parseCheckbox(req.body.enabled),
    campaignVersion: parseOptionalPositiveInt(
      req.body.campaignVersion,
      current.campaignVersion,
      1,
      99999
    ),
    alertTitle: req.body.alertTitle,
    alertMessage: req.body.alertMessage,
    startButtonLabel: req.body.startButtonLabel,
    laterButtonLabel: req.body.laterButtonLabel,
    listHintText: req.body.listHintText,
    testCard: getOnboardingCardFromBody(req.body, current.testCard || {}),
    testQuestions: questions
  };

  const merged = withOnboardingPersonalizationConfig(config.featureFlagsJson, patch);
  await prisma.appConfig.update({
    where: { id: 1 },
    data: { featureFlagsJson: merged.featureFlagsJson }
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'ONBOARDING_TEST_CONFIG_UPDATED',
    meta: {
      via: 'admin-panel',
      campaignVersion: merged.onboardingPersonalization.campaignVersion,
      enabled: merged.onboardingPersonalization.enabled
    }
  });

  res.redirect('/admin/onboarding-test?success=1');
});

router.post('/onboarding-test/send', INBOX_IMAGE_UPLOAD.single('imageFile'), async (req, res) => {
  const config = await prisma.appConfig.findUnique({
    where: { id: 1 },
    select: { featureFlagsJson: true }
  });

  if (!config) {
    return res.status(404).send('Application config not found');
  }

  const onboardingConfig = getOnboardingPersonalizationConfig(config.featureFlagsJson);
  const audienceMode = `${req.body.audienceMode || 'global'}`.trim().toLowerCase();
  const requestedCard = getOnboardingCardFromBody(req.body, onboardingConfig.testCard || {});
  const title = `${requestedCard.title || ''}`.trim().slice(0, 180);
  const message = `${requestedCard.message || ''}`.trim().slice(0, 2000);
  if (!title || !message) {
    return res.redirect('/admin/onboarding-test?error=Заполните заголовок и текст тестовой карточки');
  }

  let targetUserIds = audienceMode === 'users' ? parseUserIdsText(req.body.targetUserIds) : [];
  if (audienceMode === 'users' && !targetUserIds.length) {
    return res.redirect('/admin/onboarding-test?error=Укажите хотя бы один userId для отправки по списку');
  }
  if (targetUserIds.length) {
    const existingUsers = await prisma.user.findMany({
      where: {
        id: { in: targetUserIds },
        isDeleted: false
      },
      select: { id: true }
    });
    targetUserIds = existingUsers.map((item) => item.id);
    if (!targetUserIds.length) {
      return res.redirect('/admin/onboarding-test?error=Не найдено ни одного активного пользователя из списка');
    }
  }

  let testQuestions = onboardingConfig.testQuestions;
  try {
    testQuestions = parseOnboardingQuestionsInput(req.body.testQuestionsJson);
  } catch (error) {
    return res.redirect(`/admin/onboarding-test?error=${encodeURIComponent(error.message)}`);
  }


  let uploadedImageUrl = '';
  try {
    uploadedImageUrl = await persistAdminInboxImage(req, req.file, {
      userScope: audienceMode === 'users' ? 'onboarding_users' : 'onboarding_all'
    });
  } catch (_error) {
    return res.redirect('/admin/onboarding-test?error=Не удалось загрузить изображение');
  }

  const payload = makeOnboardingTestPayload({
    card: requestedCard,
    testQuestions,
    campaignVersion: onboardingConfig.campaignVersion,
    uploadedImageUrl
  });

  try {
    const created = await createInboxItemByAdmin(req.admin.id, {
      type: 'TEST',
      scope: audienceMode === 'users' ? 'USER' : 'GLOBAL',
      title,
      message,
      payload,
      templateKey: 'onboarding_personalization_test',
      targetUserIds,
      publishNow: true
    });

    await writeAuditLog({
      adminId: req.admin.id,
      action: 'ONBOARDING_TEST_SENT',
      meta: {
        via: 'admin-panel',
        inboxItemId: created.id,
        audienceMode,
        targetCount: targetUserIds.length
      }
    });
  } catch (error) {
    return res.redirect(`/admin/onboarding-test?error=${encodeURIComponent(error?.message || 'Не удалось отправить тест')}`);
  }

  return res.redirect('/admin/onboarding-test?sent=1');
});

router.post('/onboarding-test/force', express.urlencoded({ extended: false }), async (req, res) => {
  const config = await prisma.appConfig.findUnique({
    where: { id: 1 },
    select: { featureFlagsJson: true }
  });

  if (!config) {
    return res.status(404).send('Application config not found');
  }

  const current = getOnboardingPersonalizationConfig(config.featureFlagsJson);
  const nextCampaignVersion = Math.max(1, Number(current.campaignVersion) || 1) + 1;
  const merged = withOnboardingPersonalizationConfig(config.featureFlagsJson, {
    campaignVersion: nextCampaignVersion
  });

  await prisma.appConfig.update({
    where: { id: 1 },
    data: { featureFlagsJson: merged.featureFlagsJson }
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'ONBOARDING_TEST_FORCED_BROADCAST',
    meta: {
      via: 'admin-panel',
      campaignVersion: nextCampaignVersion
    }
  });

  res.redirect('/admin/onboarding-test?forced=1');
});

router.get('/users/:id/onboarding-test', async (req, res) => {
  const userId = `${req.params.id || ''}`.trim();
  if (!userId) return res.status(400).send('Invalid user id');

  const [targetUser, config] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        publicId: true,
        username: true,
        displayName: true,
        age: true,
        goals: true,
        facts: {
          where: { deletedAt: null, archived: false },
          orderBy: [{ updatedAt: 'desc' }],
          take: 16,
          select: { detail: true, category: true, updatedAt: true }
        },
        memoryProfile: {
          select: {
            profileJson: true,
            isDeleted: true
          }
        }
      }
    }),
    prisma.appConfig.findUnique({
      where: { id: 1 },
      select: { featureFlagsJson: true }
    })
  ]);

  if (!targetUser) return res.status(404).send('Пользователь не найден');
  if (!config) return res.status(404).send('Application config not found');

  const onboardingConfig = getOnboardingPersonalizationConfig(config.featureFlagsJson);
  let cardDraft = { ...(onboardingConfig.testCard || {}) };
  let testQuestionsDraft = normalizeAiGeneratedQuestions(onboardingConfig.testQuestions, DEFAULT_ONBOARDING_TEST_QUESTIONS);

  const prefillMode = `${req.query.prefill || ''}`.trim().toLowerCase();
  if (prefillMode === 'memory' || prefillMode === 'ai') {
    const parsedProfile =
      targetUser.memoryProfile && !targetUser.memoryProfile.isDeleted
        ? safeJsonParse(targetUser.memoryProfile.profileJson || '{}', {})
        : {};
    const profileOverview = buildUserProfileOverview({
      user: targetUser,
      memoryProfile: parsedProfile,
      recentFacts: targetUser.facts || []
    });
    let memoryDraft = buildMemoryPersonalizedTestDraft({ user: targetUser, profileOverview });
    if (prefillMode === 'ai') {
      try {
        const proConfig = getProConfig(config.featureFlagsJson || '{}');
        memoryDraft = await generateAiPersonalizedTestDraftV2({
          user: targetUser,
          profileOverview,
          proConfig,
          openrouterFallback: {
            apiKey: config?.openrouterApiKey,
            model: config?.openrouterModel
          }
        });
      } catch (_error) {
        memoryDraft = buildMemoryPersonalizedTestDraft({ user: targetUser, profileOverview });
      }
    }
    cardDraft = {
      ...cardDraft,
      title: memoryDraft.title,
      message: memoryDraft.message,
      route: memoryDraft.payload?.route || cardDraft.route,
      primaryLabel: memoryDraft.payload?.primaryLabel || cardDraft.primaryLabel,
      secondaryLabel: memoryDraft.payload?.secondaryLabel || cardDraft.secondaryLabel
    };
    testQuestionsDraft = normalizeAiGeneratedQuestions(memoryDraft?.payload?.testQuestions, onboardingConfig.testQuestions);
  }

  return res.render('onboarding-test-user', {
    admin: req.admin,
    targetUser,
    onboardingConfig,
    cardDraft,
    testQuestionsDraft,
    success: `${req.query.success || ''}` === '1',
    errorMessage: `${req.query.error || ''}`.trim()
  });
});

router.post('/users/:id/onboarding-test/generate', async (req, res) => {
  const userId = `${req.params.id || ''}`.trim();
  if (!userId) return res.status(400).json({ error: { message: 'Invalid user id' } });

  const [targetUser, appConfig] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        publicId: true,
        username: true,
        displayName: true,
        age: true,
        goals: true,
        facts: {
          where: { deletedAt: null, archived: false },
          orderBy: [{ updatedAt: 'desc' }],
          take: 16,
          select: { detail: true, category: true, updatedAt: true }
        },
        memoryProfile: {
          select: {
            profileJson: true,
            isDeleted: true
          }
        }
      }
    }),
    prisma.appConfig.findUnique({
      where: { id: 1 },
      select: { featureFlagsJson: true, openrouterApiKey: true, openrouterModel: true }
    })
  ]);

  if (!targetUser) {
    return res.status(404).json({ error: { message: 'User not found' } });
  }

  const parsedProfile =
    targetUser.memoryProfile && !targetUser.memoryProfile.isDeleted
      ? safeJsonParse(targetUser.memoryProfile.profileJson || '{}', {})
      : {};
  const profileOverview = buildUserProfileOverview({
    user: targetUser,
    memoryProfile: parsedProfile,
    recentFacts: targetUser.facts || []
  });
  const proConfig = getProConfig(appConfig?.featureFlagsJson || '{}');

  let draft = null;
  let source = 'memory';
  let modelUsed = null;

  try {
    const generated = await generateAiPersonalizedTestDraftV2({
      user: targetUser,
      profileOverview,
      proConfig,
      openrouterFallback: {
        apiKey: appConfig?.openrouterApiKey,
        model: appConfig?.openrouterModel
      }
    });
    draft = generated;
    source = generated?.source || 'memory';
    modelUsed = generated?.modelUsed || null;
  } catch (_error) {
    draft = buildMemoryPersonalizedTestDraft({
      user: targetUser,
      profileOverview
    });
    source = 'memory';
  }

  const normalizedDraftQuestions = normalizeAiGeneratedQuestions(
    draft?.payload?.testQuestions,
    DEFAULT_ONBOARDING_TEST_QUESTIONS
  );

  return res.json({
    ok: true,
    source,
    modelUsed,
    testQuestions: normalizedDraftQuestions,
    draft: {
      title: `${draft?.title || ''}`.trim().slice(0, 180),
      message: `${draft?.message || ''}`.trim().slice(0, 2000),
      route: `${draft?.payload?.route || '/personalization-test'}`.trim(),
      primaryLabel: `${draft?.payload?.primaryLabel || 'Пройти тест'}`.trim().slice(0, 80),
      secondaryLabel: `${draft?.payload?.secondaryLabel || 'Позже'}`.trim().slice(0, 80)
    }
  });
});

router.post('/users/:id/onboarding-test/send', INBOX_IMAGE_UPLOAD.single('imageFile'), async (req, res) => {
  const userId = `${req.params.id || ''}`.trim();
  if (!userId) return res.status(400).send('Invalid user id');

  const [targetUser, config] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, displayName: true, publicId: true }
    }),
    prisma.appConfig.findUnique({
      where: { id: 1 },
      select: { featureFlagsJson: true }
    })
  ]);

  if (!targetUser) return res.status(404).send('Пользователь не найден');
  if (!config) return res.status(404).send('Application config not found');

  const onboardingConfig = getOnboardingPersonalizationConfig(config.featureFlagsJson);
  const requestedCard = getOnboardingCardFromBody(req.body, onboardingConfig.testCard || {});
  const title = `${requestedCard.title || ''}`.trim().slice(0, 180);
  const message = `${requestedCard.message || ''}`.trim().slice(0, 2000);
  if (!title || !message) {
    return res.redirect(`/admin/users/${encodeURIComponent(userId)}/onboarding-test?error=Заполните заголовок и текст`);
  }

  let testQuestions = onboardingConfig.testQuestions;
  try {
    testQuestions = parseOnboardingQuestionsInput(req.body.testQuestionsJson);
  } catch (error) {
    return res.redirect(`/admin/users/${encodeURIComponent(userId)}/onboarding-test?error=${encodeURIComponent(error.message)}`);
  }

  let uploadedImageUrl = '';
  try {
    uploadedImageUrl = await persistAdminInboxImage(req, req.file, { userScope: userId || 'user' });
  } catch (_error) {
    return res.redirect(`/admin/users/${encodeURIComponent(userId)}/onboarding-test?error=Не удалось загрузить изображение`);
  }

  const payload = makeOnboardingTestPayload({
    card: requestedCard,
    testQuestions,
    campaignVersion: onboardingConfig.campaignVersion,
    uploadedImageUrl
  });

  try {
    const created = await createInboxItemByAdmin(req.admin.id, {
      type: 'TEST',
      scope: 'USER',
      title,
      message,
      payload,
      templateKey: 'onboarding_personalization_test',
      targetUserIds: [userId],
      publishNow: true
    });

    await writeAuditLog({
      adminId: req.admin.id,
      targetUserId: userId,
      action: 'ONBOARDING_TEST_SENT_TO_USER',
      meta: {
        via: 'admin-panel',
        inboxItemId: created.id
      }
    });
  } catch (error) {
    return res.redirect(
      `/admin/users/${encodeURIComponent(userId)}/onboarding-test?error=${encodeURIComponent(error?.message || 'Не удалось отправить тест')}`
    );
  }

  return res.redirect(`/admin/users/${encodeURIComponent(userId)}/onboarding-test?success=1`);
});

router.get('/inbox', async (req, res) => {
  const status = `${req.query.status || ''}`.trim().toUpperCase();
  const group = normalizeInboxTypeGroup(req.query.group);
  const composeType = normalizeInboxComposeType(req.query.kind || req.query.type);
  const historyType = normalizeInboxHistoryType(req.query.history);
  let typeFilters = getInboxTypesByGroup(group);
  if (group !== 'all') {
    typeFilters = typeFilters.filter((type) => type === composeType);
  } else if (historyType !== 'ALL') {
    typeFilters = typeFilters.filter((type) => type === historyType);
  }
  const editItemId = `${req.query.edit || ''}`.trim();
  const items = await listInboxItemsForAdmin({
    status,
    types: typeFilters,
    limit: 300
  });
  const users = await listOnboardingTargetUsers(700);
  let editingItem = null;
  if (editItemId) {
    try {
      const raw = await getInboxItemForAdmin(editItemId);
      editingItem = {
        ...raw,
        payload: safeJsonParse(raw.payloadJson, {})
      };
    } catch (_error) {
      editingItem = null;
    }
  }

  const availableTypes = ['NEWS', 'SYSTEM'];
  const activeComposeType =
    editingItem && editingItem.type ? normalizeInboxComposeType(editingItem.type) : composeType;

  res.render('inbox', {
    admin: req.admin,
    users,
    items: (items || []).map((item) => ({
      ...item,
      payloadPreview: safeJsonParse(item.payloadJson, {})
    })),
    filters: { status },
    typeGroup: group,
    typeTabs: buildInboxTypeTabs(group),
    composeType: activeComposeType,
    composeTabs: buildInboxComposeTabs(group, activeComposeType),
    historyType,
    historyTabs: buildInboxHistoryTabs(group, historyType),
    availableTypes,
    editingItem,
    success: `${req.query.success || ''}` === '1',
    errorMessage: `${req.query.error || ''}`.trim()
  });
});

router.post('/inbox/send', INBOX_IMAGE_UPLOAD.single('imageFile'), async (req, res) => {
  const group = normalizeInboxTypeGroup(req.body.group || req.query.group);
  const title = `${req.body.title || ''}`.trim().slice(0, 180);
  const message = `${req.body.message || ''}`.trim().slice(0, 2000);
  const type = normalizeInboxType(req.body.type);
  const kind = normalizeInboxComposeType(req.body.kind || req.query.kind || type);
  const scope = normalizeInboxScope(req.body.scope);
  const segmentKey = `${req.body.segmentKey || ''}`.trim();
  const templateKey = `${req.body.templateKey || ''}`.trim().slice(0, 120);
  const scheduledAt = `${req.body.scheduledAt || ''}`.trim();
  const expiresAt = `${req.body.expiresAt || ''}`.trim();
  if (!isInboxTypeAllowedForGroup(type, group)) {
    return res.redirect(`/admin/inbox?group=${encodeURIComponent(group)}&kind=${encodeURIComponent(kind)}&error=Inbox+type+is+not+allowed+for+this+section`);
  }

  let uploadedImageUrl = '';
  try {
    uploadedImageUrl = await persistAdminInboxImage(req, req.file, { userScope: scope === 'USER' ? 'user' : 'global' });
  } catch (_error) {
    return res.redirect(`/admin/inbox?group=${encodeURIComponent(group)}&kind=${encodeURIComponent(kind)}&error=Failed+to+upload+image`);
  }

  const payload = parseInboxPayloadFromForm(req.body, { uploadedImageUrl });
  const targetUserIds = parseUserIdsText(req.body.targetUserIds);
  const publishNow = parseCheckbox(req.body.publishNow);

  if (!title || !message) {
    return res.redirect(`/admin/inbox?group=${encodeURIComponent(group)}&kind=${encodeURIComponent(kind)}&error=Fill+in+title+and+message`);
  }

  try {
    const created = await createInboxItemByAdmin(req.admin.id, {
      type,
      scope,
      title,
      message,
      payload,
      templateKey,
      segmentKey,
      targetUserIds,
      scheduledAt: scheduledAt || null,
      expiresAt: expiresAt || null,
      publishNow
    });

    await writeAuditLog({
      adminId: req.admin.id,
      action: 'INBOX_ITEM_CREATED',
      meta: {
        via: 'admin-panel',
        inboxItemId: created.id,
        type: created.type,
        scope: created.scope,
        publishNow
      }
    });
  } catch (error) {
    return res.redirect(
      `/admin/inbox?group=${encodeURIComponent(group)}&kind=${encodeURIComponent(kind)}&error=${encodeURIComponent(error?.message || 'Failed to create inbox item')}`
    );
  }

  return res.redirect(`/admin/inbox?group=${encodeURIComponent(group)}&kind=${encodeURIComponent(kind)}&success=1`);
});

router.post('/inbox/:itemId/update', INBOX_IMAGE_UPLOAD.single('imageFile'), async (req, res) => {
  const group = normalizeInboxTypeGroup(req.body.group || req.query.group);
  const kind = normalizeInboxComposeType(req.body.kind || req.query.kind || req.body.type);
  const history = normalizeInboxHistoryType(req.body.history || req.query.history);
  const tabQuery =
    group === 'all' ? `&history=${encodeURIComponent(history)}` : `&kind=${encodeURIComponent(kind)}`;
  const itemId = `${req.params.itemId || ''}`.trim();
  if (!itemId) {
    return res.redirect(`/admin/inbox?group=${encodeURIComponent(group)}${tabQuery}&error=Invalid+item+id`);
  }

  const title = `${req.body.title || ''}`.trim().slice(0, 180);
  const message = `${req.body.message || ''}`.trim().slice(0, 2000);
  const templateKey = `${req.body.templateKey || ''}`.trim().slice(0, 120);
  const scheduledAt = `${req.body.scheduledAt || ''}`.trim();
  const expiresAt = `${req.body.expiresAt || ''}`.trim();

  let uploadedImageUrl = '';
  try {
    uploadedImageUrl = await persistAdminInboxImage(req, req.file, { userScope: 'edit' });
  } catch (_error) {
    return res.redirect(
      `/admin/inbox?group=${encodeURIComponent(group)}${tabQuery}&edit=${encodeURIComponent(itemId)}&error=Failed+to+upload+image`
    );
  }

  const payload = parseInboxPayloadFromForm(req.body, { uploadedImageUrl });

  try {
    const updated = await updateInboxItemByAdmin(itemId, {
      title,
      message,
      payload,
      templateKey,
      scheduledAt: scheduledAt || null,
      expiresAt: expiresAt || null
    });

    await writeAuditLog({
      adminId: req.admin.id,
      action: 'INBOX_ITEM_UPDATED',
      meta: {
        via: 'admin-panel',
        inboxItemId: updated.id
      }
    });
  } catch (error) {
    return res.redirect(
      `/admin/inbox?group=${encodeURIComponent(group)}${tabQuery}&edit=${encodeURIComponent(
        itemId
      )}&error=${encodeURIComponent(error?.message || 'Failed to update inbox item')}`
    );
  }

  return res.redirect(`/admin/inbox?group=${encodeURIComponent(group)}${tabQuery}&success=1`);
});

router.post('/inbox/:itemId/publish', async (req, res) => {
  const group = normalizeInboxTypeGroup(req.body.group || req.query.group);
  const kind = normalizeInboxComposeType(req.body.kind || req.query.kind);
  const history = normalizeInboxHistoryType(req.body.history || req.query.history);
  const tabQuery =
    group === 'all' ? `&history=${encodeURIComponent(history)}` : `&kind=${encodeURIComponent(kind)}`;
  const itemId = `${req.params.itemId || ''}`.trim();
  if (!itemId) return res.redirect(`/admin/inbox?group=${encodeURIComponent(group)}${tabQuery}&error=Invalid+item+id`);

  try {
    const published = await publishInboxItemNow(itemId);
    await writeAuditLog({
      adminId: req.admin.id,
      action: 'INBOX_ITEM_PUBLISHED',
      meta: {
        via: 'admin-panel',
        inboxItemId: published.id
      }
    });
  } catch (error) {
    return res.redirect(
      `/admin/inbox?group=${encodeURIComponent(group)}${tabQuery}&error=${encodeURIComponent(error?.message || 'Failed to publish inbox item')}`
    );
  }

  return res.redirect(`/admin/inbox?group=${encodeURIComponent(group)}${tabQuery}&success=1`);
});

router.post('/inbox/:itemId/cancel', async (req, res) => {
  const group = normalizeInboxTypeGroup(req.body.group || req.query.group);
  const kind = normalizeInboxComposeType(req.body.kind || req.query.kind);
  const history = normalizeInboxHistoryType(req.body.history || req.query.history);
  const tabQuery =
    group === 'all' ? `&history=${encodeURIComponent(history)}` : `&kind=${encodeURIComponent(kind)}`;
  const itemId = `${req.params.itemId || ''}`.trim();
  if (!itemId) return res.redirect(`/admin/inbox?group=${encodeURIComponent(group)}${tabQuery}&error=Invalid+item+id`);

  try {
    const canceled = await cancelInboxItem(itemId);
    await writeAuditLog({
      adminId: req.admin.id,
      action: 'INBOX_ITEM_CANCELED',
      meta: {
        via: 'admin-panel',
        inboxItemId: canceled.id
      }
    });
  } catch (error) {
    return res.redirect(
      `/admin/inbox?group=${encodeURIComponent(group)}${tabQuery}&error=${encodeURIComponent(error?.message || 'Failed to cancel inbox item')}`
    );
  }

  return res.redirect(`/admin/inbox?group=${encodeURIComponent(group)}${tabQuery}&success=1`);
});

router.post('/users/:id/inbox/send', INBOX_IMAGE_UPLOAD.single('imageFile'), async (req, res) => {
  const userId = `${req.params.id || ''}`.trim();
  const title = `${req.body.title || ''}`.trim().slice(0, 180);
  const message = `${req.body.message || ''}`.trim().slice(0, 2000);
  const type = normalizeInboxType(req.body.type);
  const redirectTo = parseAdminRedirect(req, `/admin/users/${userId}`);
  let uploadedImageUrl = '';

  try {
    uploadedImageUrl = await persistAdminInboxImage(req, req.file, { userScope: userId || 'user' });
  } catch (_error) {
    return res.redirect(`${redirectTo}?error=1`);
  }

  const payload = parseInboxPayloadFromForm(req.body, { uploadedImageUrl });

  if (!userId || !title || !message) {
    return res.redirect(`${redirectTo}?error=1`);
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true }
  });
  if (!targetUser) {
    return res.status(404).send('Пользователь не найден');
  }

  try {
    const created = await createInboxItemByAdmin(req.admin.id, {
      type,
      scope: 'USER',
      title,
      message,
      payload,
      targetUserIds: [userId],
      publishNow: true
    });

    await writeAuditLog({
      adminId: req.admin.id,
      action: 'INBOX_ITEM_SENT_TO_USER',
      targetUserId: userId,
      meta: {
        via: 'admin-panel',
        inboxItemId: created.id,
        type
      }
    });
  } catch (_error) {
    return res.redirect(`${redirectTo}?error=1`);
  }

  return res.redirect(`${redirectTo}?success=1`);
});

router.post('/users/:id/inbox/generate-test', express.urlencoded({ extended: false }), async (req, res) => {
  const userId = `${req.params.id || ''}`.trim();
  if (!userId) return res.redirect('/admin/users?error=1');

  await writeAuditLog({
    adminId: req.admin.id,
    targetUserId: userId,
    action: 'ONBOARDING_TEST_PREFILL_REQUESTED',
    meta: { via: 'admin-panel', mode: 'ai' }
  }).catch(() => null);

  return res.redirect(`/admin/users/${encodeURIComponent(userId)}/onboarding-test?prefill=ai`);
});

async function buildAboutPageData(section, req) {
  const [developersRaw, legalDocsRaw, faqRaw, supportRaw, appInfoRaw] = await Promise.all([
    prisma.developer.findMany({ orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] }),
    prisma.legalDocument.findMany({ orderBy: [{ updatedAt: 'desc' }] }),
    prisma.faqItem.findMany({ orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] }),
    prisma.supportInfo.findUnique({ where: { id: 1 } }),
    prisma.appInfo.findUnique({ where: { id: 1 } })
  ]);

  const developers = developersRaw.map((item) => toDeveloperPayload(item));
  const legalByType = {
    privacy: legalDocsRaw.find((item) => item.type === 'PRIVACY_POLICY') || null,
    terms: legalDocsRaw.find((item) => item.type === 'TERMS_OF_SERVICE') || null
  };

  return {
    admin: req.admin,
    section: normalizeAboutSection(section),
    sectionNav: buildAboutSectionNav(section),
    roleOptions: ABOUT_ROLE_OPTIONS,
    roleColors: ROLE_COLORS,
    developers,
    legalByType,
    legalDefaults: {
      privacy: DEFAULT_PRIVACY_MARKDOWN,
      terms: DEFAULT_TERMS_MARKDOWN
    },
    faqItems: faqRaw,
    support:
      supportRaw ||
      ({
        ...DEFAULT_SUPPORT_INFO
      }),
    appInfo:
      appInfoRaw ||
      ({
        ...DEFAULT_APP_INFO
      })
  };
}

router.get('/about', async (_req, res) => {
  res.redirect('/admin/about/developers');
});

router.get('/about/:section', async (req, res) => {
  const section = normalizeAboutSection(req.params.section);
  const pageData = await buildAboutPageData(section, req);
  res.render('about', {
    ...pageData,
    success: req.query.success === '1',
    errorMessage: `${req.query.error || ''}`.trim()
  });
});

router.post('/about/developers/create', ABOUT_DEVELOPER_UPLOAD.single('photo'), async (req, res) => {
  const name = `${req.body.name || ''}`.trim();
  const role = `${req.body.role || ''}`.trim();
  const bio = `${req.body.bio || ''}`.trim();
  const github = `${req.body.github || ''}`.trim();
  const linkedin = `${req.body.linkedin || ''}`.trim();
  const contribution = parseContributionList(req.body.contribution);

  if (!name || !bio) {
    return res.redirect('/admin/about/developers?error=Заполните имя и bio разработчика');
  }
  if (!ABOUT_ROLE_OPTIONS.includes(role)) {
    return res.redirect('/admin/about/developers?error=Некорректная роль разработчика');
  }

  const max = await prisma.developer.aggregate({ _max: { order: true } });
  const photoUrl = req.file?.filename ? toPublicDeveloperPhotoUrl(req, req.file.filename) : null;
  const created = await prisma.developer.create({
    data: {
      name,
      role,
      bio,
      photo: photoUrl,
      github: github || null,
      linkedin: linkedin || null,
      contribution: JSON.stringify(contribution),
      order: (max?._max?.order ?? -1) + 1
    }
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'ABOUT_DEVELOPER_CREATED',
    meta: { via: 'admin-panel', developerId: created.id }
  });

  emitAboutEvent('developer:added', { developer: toDeveloperPayload(created) });
  return res.redirect('/admin/about/developers?success=1');
});

router.post('/about/developers/:id/update', ABOUT_DEVELOPER_UPLOAD.single('photo'), async (req, res) => {
  const developerId = `${req.params.id || ''}`.trim();
  const existing = await prisma.developer.findUnique({ where: { id: developerId } });
  if (!existing) return res.redirect('/admin/about/developers?error=Разработчик не найден');

  const name = `${req.body.name || existing.name}`.trim();
  const role = `${req.body.role || existing.role}`.trim();
  const bio = `${req.body.bio || existing.bio}`.trim();
  const github = `${req.body.github || ''}`.trim();
  const linkedin = `${req.body.linkedin || ''}`.trim();
  const contribution = parseContributionList(req.body.contribution);

  if (!name || !bio) {
    return res.redirect('/admin/about/developers?error=Заполните имя и bio разработчика');
  }
  if (!ABOUT_ROLE_OPTIONS.includes(role)) {
    return res.redirect('/admin/about/developers?error=Некорректная роль разработчика');
  }

  const photoUrl = req.file?.filename ? toPublicDeveloperPhotoUrl(req, req.file.filename) : existing.photo;
  const updated = await prisma.developer.update({
    where: { id: developerId },
    data: {
      name,
      role,
      bio,
      photo: photoUrl || null,
      github: github || null,
      linkedin: linkedin || null,
      contribution: JSON.stringify(contribution)
    }
  });

  if (req.file?.filename && existing.photo && existing.photo !== photoUrl) {
    deleteDeveloperPhotoByUrl(existing.photo);
  }

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'ABOUT_DEVELOPER_UPDATED',
    meta: { via: 'admin-panel', developerId: developerId }
  });

  emitAboutEvent('developer:updated', { developer: toDeveloperPayload(updated) });
  return res.redirect('/admin/about/developers?success=1');
});

router.post('/about/developers/:id/delete', express.urlencoded({ extended: false }), async (req, res) => {
  const developerId = `${req.params.id || ''}`.trim();
  const existing = await prisma.developer.findUnique({ where: { id: developerId } });
  if (!existing) return res.redirect('/admin/about/developers?error=Разработчик не найден');

  await prisma.developer.delete({ where: { id: developerId } });
  deleteDeveloperPhotoByUrl(existing.photo);

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'ABOUT_DEVELOPER_DELETED',
    meta: { via: 'admin-panel', developerId: developerId }
  });

  emitAboutEvent('developer:deleted', { id: developerId });
  return res.redirect('/admin/about/developers?success=1');
});

router.post('/about/developers/reorder', express.urlencoded({ extended: false }), async (req, res) => {
  const developerId = `${req.body.id || ''}`.trim();
  const direction = `${req.body.direction || ''}`.trim().toLowerCase();
  if (!developerId || (direction !== 'up' && direction !== 'down')) {
    return res.redirect('/admin/about/developers?error=Некорректные параметры сортировки');
  }

  const list = await prisma.developer.findMany({ orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] });
  const index = list.findIndex((item) => item.id === developerId);
  if (index < 0) return res.redirect('/admin/about/developers?error=Разработчик не найден');

  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= list.length) return res.redirect('/admin/about/developers');

  const next = [...list];
  const temp = next[index];
  next[index] = next[swapWith];
  next[swapWith] = temp;

  await prisma.$transaction(
    next.map((item, orderIndex) =>
      prisma.developer.update({
        where: { id: item.id },
        data: { order: orderIndex }
      })
    )
  );

  emitAboutEvent('developer:reordered', {
    items: next.map((item, orderIndex) => ({ id: item.id, order: orderIndex }))
  });

  return res.redirect('/admin/about/developers?success=1');
});

router.post('/about/legal/:type', express.urlencoded({ extended: false }), async (req, res) => {
  const legalType = mapLegalTypeFromParam(req.params.type);
  const content = `${req.body.content || ''}`.trim();
  if (!legalType) return res.redirect('/admin/about/legal?error=Некорректный тип документа');
  if (!content) return res.redirect('/admin/about/legal?error=Текст документа не может быть пустым');

  const updated = await prisma.legalDocument.upsert({
    where: { type: legalType },
    create: { type: legalType, content },
    update: { content }
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'ABOUT_LEGAL_UPDATED',
    meta: { via: 'admin-panel', type: legalType }
  });

  emitAboutEvent('legal:updated', {
    document: {
      id: updated.id,
      type: legalType === 'PRIVACY_POLICY' ? 'privacy_policy' : 'terms_of_service',
      content: updated.content,
      updatedAt: updated.updatedAt
    }
  });

  return res.redirect('/admin/about/legal?success=1');
});

router.post('/about/faq/create', express.urlencoded({ extended: false }), async (req, res) => {
  const question = `${req.body.question || ''}`.trim();
  const answer = `${req.body.answer || ''}`.trim();
  const category = `${req.body.category || ''}`.trim();
  const color = normalizeFaqColor(req.body.color);

  if (!question || !answer || !category) {
    return res.redirect('/admin/about/faq?error=Заполните вопрос, ответ и категорию');
  }

  const max = await prisma.faqItem.aggregate({ _max: { order: true } });
  const created = await prisma.faqItem.create({
    data: {
      question,
      answer,
      category,
      color,
      order: (max?._max?.order ?? -1) + 1
    }
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'ABOUT_FAQ_CREATED',
    meta: { via: 'admin-panel', faqId: created.id }
  });

  emitAboutEvent('faq:added', { faq: created });
  return res.redirect('/admin/about/faq?success=1');
});

router.post('/about/faq/:id/update', express.urlencoded({ extended: false }), async (req, res) => {
  const faqId = `${req.params.id || ''}`.trim();
  const existing = await prisma.faqItem.findUnique({ where: { id: faqId } });
  if (!existing) return res.redirect('/admin/about/faq?error=FAQ не найден');

  const question = `${req.body.question || ''}`.trim();
  const answer = `${req.body.answer || ''}`.trim();
  const category = `${req.body.category || ''}`.trim();
  const color = normalizeFaqColor(req.body.color, existing.color || '#667eea');

  if (!question || !answer || !category) {
    return res.redirect('/admin/about/faq?error=Заполните вопрос, ответ и категорию');
  }

  const updated = await prisma.faqItem.update({
    where: { id: faqId },
    data: { question, answer, category, color }
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'ABOUT_FAQ_UPDATED',
    meta: { via: 'admin-panel', faqId }
  });

  emitAboutEvent('faq:updated', { faq: updated });
  return res.redirect('/admin/about/faq?success=1');
});

router.post('/about/faq/:id/delete', express.urlencoded({ extended: false }), async (req, res) => {
  const faqId = `${req.params.id || ''}`.trim();
  const existing = await prisma.faqItem.findUnique({ where: { id: faqId } });
  if (!existing) return res.redirect('/admin/about/faq?error=FAQ не найден');

  await prisma.faqItem.delete({ where: { id: faqId } });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'ABOUT_FAQ_DELETED',
    meta: { via: 'admin-panel', faqId }
  });

  emitAboutEvent('faq:deleted', { id: faqId });
  return res.redirect('/admin/about/faq?success=1');
});

router.post('/about/faq/reorder', express.urlencoded({ extended: false }), async (req, res) => {
  const faqId = `${req.body.id || ''}`.trim();
  const direction = `${req.body.direction || ''}`.trim().toLowerCase();
  if (!faqId || (direction !== 'up' && direction !== 'down')) {
    return res.redirect('/admin/about/faq?error=Некорректные параметры сортировки');
  }

  const list = await prisma.faqItem.findMany({ orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] });
  const index = list.findIndex((item) => item.id === faqId);
  if (index < 0) return res.redirect('/admin/about/faq?error=FAQ не найден');

  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= list.length) return res.redirect('/admin/about/faq');

  const next = [...list];
  const temp = next[index];
  next[index] = next[swapWith];
  next[swapWith] = temp;

  await prisma.$transaction(
    next.map((item, orderIndex) =>
      prisma.faqItem.update({
        where: { id: item.id },
        data: { order: orderIndex }
      })
    )
  );

  return res.redirect('/admin/about/faq?success=1');
});

router.post('/about/support/update', express.urlencoded({ extended: false }), async (req, res) => {
  const email = `${req.body.email || ''}`.trim();
  const telegram = `${req.body.telegram || ''}`.trim();
  const instagram = `${req.body.instagram || ''}`.trim();
  const status = `${req.body.status || ''}`.trim().toLowerCase() === 'online' ? 'online' : 'offline';
  const avgResponseTime = `${req.body.avgResponseTime || ''}`.trim();

  if (!email || !avgResponseTime) {
    return res.redirect('/admin/about/support?error=Email и среднее время ответа обязательны');
  }

  const updated = await prisma.supportInfo.upsert({
    where: { id: 1 },
    create: {
      ...DEFAULT_SUPPORT_INFO,
      email,
      telegram: telegram || null,
      instagram: instagram || null,
      status,
      avgResponseTime
    },
    update: {
      email,
      telegram: telegram || null,
      instagram: instagram || null,
      status,
      avgResponseTime
    }
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'ABOUT_SUPPORT_UPDATED',
    meta: { via: 'admin-panel' }
  });

  emitAboutEvent('support:status_changed', {
    support: {
      id: updated.id,
      email: updated.email,
      telegram: updated.telegram || '',
      instagram: updated.instagram || '',
      status: `${updated.status || 'offline'}`.toLowerCase() === 'online' ? 'online' : 'offline',
      avgResponseTime: updated.avgResponseTime || ''
    }
  });

  return res.redirect('/admin/about/support?success=1');
});

router.post('/about/app/update', express.urlencoded({ extended: false }), async (req, res) => {
  const name = `${req.body.name || ''}`.trim();
  const version = `${req.body.version || ''}`.trim();
  const description = `${req.body.description || ''}`.trim();
  const logo = `${req.body.logo || ''}`.trim();
  const socials = {
    telegram: `${req.body.socialTelegram || ''}`.trim(),
    instagram: `${req.body.socialInstagram || ''}`.trim(),
    website: `${req.body.socialWebsite || ''}`.trim()
  };

  if (!name || !version || !description) {
    return res.redirect('/admin/about/app?error=Название, версия и описание обязательны');
  }

  const updated = await prisma.appInfo.upsert({
    where: { id: 1 },
    create: {
      ...DEFAULT_APP_INFO,
      name,
      version,
      description,
      logo: logo || null,
      socialsJson: JSON.stringify(socials)
    },
    update: {
      name,
      version,
      description,
      logo: logo || null,
      socialsJson: JSON.stringify(socials)
    }
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'ABOUT_APP_INFO_UPDATED',
    meta: { via: 'admin-panel' }
  });

  emitAboutEvent('appinfo:updated', {
    appInfo: {
      id: updated.id,
      name: updated.name,
      version: updated.version,
      description: updated.description,
      logo: updated.logo || '',
      socials
    }
  });

  return res.redirect('/admin/about/app?success=1');
});

function buildProConfigRenderPayload({
  admin,
  proConfig,
  allowedUsers,
  resolvedApiKey,
  resolvedApiKeys,
  apiKeySource,
  section
}) {
  return {
    admin,
    proConfig,
    allowedUsers,
    proSection: normalizeProConfigSection(section),
    proSectionsNav: buildProConfigSectionNav(section),
    proApiKeyMasked: resolvedApiKey ? maskSecret(resolvedApiKey) : '',
    proApiKeysMasked: resolvedApiKeys.map((item) => maskSecret(item)),
    proApiKeysCount: resolvedApiKeys.length,
    apiKeySource,
    apiKeysText: listToText(proConfig.apiKeys),
    textModelsText: listToText(proConfig.textModels),
    visionModelsText: listToText(proConfig.visionModels),
    imageGenModelsText: listToText(proConfig.imageGenModels),
    imageEditModelsText: listToText(proConfig.imageEditModels),
    videoGenModelsText: listToText(proConfig.videoGenModels),
    voiceAsrModelsText: listToText(proConfig.voiceAsrModels),
    voiceTtsModelsText: listToText(proConfig.voiceTtsModels),
    voiceRealtimeModelsText: listToText(proConfig.voiceRealtimeModels),
    allowedUserIdsText: listToText(proConfig.allowedUserIds)
  };
}

router.get('/pro-config', async (_req, res) => {
  res.redirect('/admin/pro-config/general');
});

router.get('/pro-config/:section', async (req, res) => {
  const config = await prisma.appConfig.findUnique({
    where: { id: 1 },
    select: { featureFlagsJson: true }
  });
  if (!config) {
    return res.status(404).send('Конфигурация приложения не найдена');
  }

  const section = normalizeProConfigSection(req.params.section);
  const proConfig = getProConfig(config.featureFlagsJson);
  const resolvedApiKeys = resolveProApiKeys(proConfig);
  const resolvedApiKey = resolveProApiKey(proConfig);
  const keyInDb = `${proConfig.apiKey || ''}`.trim();
  const keyListInDb = Array.isArray(proConfig.apiKeys)
    ? proConfig.apiKeys.map((item) => `${item || ''}`.trim()).filter(Boolean)
    : [];
  const hasDbKeys = Boolean(keyInDb || keyListInDb.length);
  const hasEnvKeys = Boolean(resolvedApiKeys.length && !hasDbKeys);
  const apiKeySource = hasDbKeys ? 'database' : hasEnvKeys ? 'env' : 'none';
  const allowedUsersRaw = proConfig.allowedUserIds.length
    ? await prisma.user.findMany({
        where: { id: { in: proConfig.allowedUserIds } },
        select: {
          id: true,
          username: true,
          displayName: true,
          role: true,
          isBlocked: true,
          isDeleted: true
        }
      })
    : [];
  const usersById = new Map(allowedUsersRaw.map((user) => [user.id, user]));
  const allowedUsers = proConfig.allowedUserIds.map((id) => usersById.get(id)).filter(Boolean);

  res.render(
    'pro-config',
    buildProConfigRenderPayload({
      admin: req.admin,
      proConfig,
      allowedUsers,
      resolvedApiKey,
      resolvedApiKeys,
      apiKeySource,
      section
    })
  );
});

router.post('/pro-config/:section', express.urlencoded({ extended: false }), async (req, res) => {
  const section = normalizeProConfigSection(req.params.section);
  const config = await prisma.appConfig.findUnique({
    where: { id: 1 },
    select: { featureFlagsJson: true }
  });
  if (!config) {
    return res.status(404).send('Конфигурация приложения не найдена');
  }

  const currentProConfig = getProConfig(config.featureFlagsJson);
  let patch = {};

  if (section === 'general') {
    patch = {
      enabled: parseCheckbox(req.body.enabled),
      accessMode: parseAccessMode(req.body.accessMode),
      allowAdmins: parseCheckbox(req.body.allowAdmins)
    };
  }

  if (section === 'provider') {
    const clearProApiKey = parseCheckbox(req.body.clearProApiKey);
    const clearProApiKeys = parseCheckbox(req.body.clearProApiKeys);
    const newProApiKey = `${req.body.proApiKey || ''}`.trim();
    let nextApiKey = currentProConfig.apiKey;
    if (clearProApiKey) {
      nextApiKey = '';
    } else if (newProApiKey) {
      nextApiKey = newProApiKey;
    }

    const rawApiKeys = `${req.body.proApiKeys || ''}`.trim();
    let nextApiKeys = currentProConfig.apiKeys;
    if (clearProApiKeys) {
      nextApiKeys = [];
    } else if (rawApiKeys) {
      nextApiKeys = rawApiKeys;
    }

    patch = {
      provider: req.body.provider,
      baseUrl: req.body.baseUrl,
      apiKey: nextApiKey,
      apiKeys: nextApiKeys
    };
  }

  if (section === 'models') {
    patch = {
      textModels: req.body.textModels,
      visionModels: req.body.visionModels,
      imageGenModels: req.body.imageGenModels,
      imageEditModels: req.body.imageEditModels,
      videoGenModels: req.body.videoGenModels,
      voiceAsrModels: req.body.voiceAsrModels,
      voiceTtsModels: req.body.voiceTtsModels,
      voiceRealtimeModels: req.body.voiceRealtimeModels
    };
  }

  if (section === 'features') {
    const currentLimits =
      currentProConfig?.limits && typeof currentProConfig.limits === 'object' ? currentProConfig.limits : {};
    const maxFileAnalyzeMb = parseOptionalPositiveInt(
      req.body.maxFileAnalyzeMb,
      Math.max(1, Math.round((Number(currentLimits.maxFileAnalyzeBytes) || 8 * 1024 * 1024) / (1024 * 1024))),
      1,
      20
    );
    const maxVoiceAudioMb = parseOptionalPositiveInt(
      req.body.maxVoiceAudioMb,
      Math.max(1, Math.round((Number(currentLimits.maxVoiceAudioBase64Chars) || 20 * 1024 * 1024) / (1024 * 1024))),
      1,
      20
    );
    patch = {
      imageAnalysisEnabled: parseCheckbox(req.body.imageAnalysisEnabled),
      imageGenerationEnabled: parseCheckbox(req.body.imageGenerationEnabled),
      imageEditingEnabled: parseCheckbox(req.body.imageEditingEnabled),
      videoGenerationEnabled: parseCheckbox(req.body.videoGenerationEnabled),
      voiceMessagesEnabled: parseCheckbox(req.body.voiceMessagesEnabled),
      voiceRealtimeEnabled: parseCheckbox(req.body.voiceRealtimeEnabled),
      fileAnalysisEnabled: parseCheckbox(req.body.fileAnalysisEnabled),
      maxOutputTokens: parseOptionalPositiveInt(req.body.maxOutputTokens, currentProConfig.maxOutputTokens, 128, 8192),
      temperature: req.body.temperature,
      limits: {
        maxOutputTokens: parseOptionalPositiveInt(
          req.body.maxOutputTokens,
          currentProConfig.maxOutputTokens,
          128,
          8192
        ),
        maxFileAnalyzeBytes: maxFileAnalyzeMb * 1024 * 1024,
        maxImagePromptChars: parseOptionalPositiveInt(
          req.body.maxImagePromptChars,
          currentProConfig.limits?.maxImagePromptChars,
          200,
          12000
        ),
        maxVideoPromptChars: parseOptionalPositiveInt(
          req.body.maxVideoPromptChars,
          currentProConfig.limits?.maxVideoPromptChars,
          200,
          12000
        ),
        maxVoiceAudioBase64Chars: maxVoiceAudioMb * 1024 * 1024,
        maxVideoDurationSeconds: parseOptionalPositiveInt(
          req.body.maxVideoDurationSeconds,
          currentProConfig.limits?.maxVideoDurationSeconds,
          1,
          180
        ),
        maxMessagesPerRequest: parseOptionalPositiveInt(
          req.body.maxMessagesPerRequest,
          currentProConfig.limits?.maxMessagesPerRequest,
          1,
          120
        ),
        maxImageAnalysesPerDay: parseOptionalPositiveInt(
          req.body.maxImageAnalysesPerDay,
          parseOptionalPositiveInt(currentProConfig.limits?.maxImageAnalysesPerDay, 40, 1, 5000),
          1,
          5000
        ),
        maxImageGenerationsPerDay: parseOptionalPositiveInt(
          req.body.maxImageGenerationsPerDay,
          parseOptionalPositiveInt(currentProConfig.limits?.maxImageGenerationsPerDay, 5, 1, 5000),
          1,
          5000
        ),
        maxImageEditsPerDay: parseOptionalPositiveInt(
          req.body.maxImageEditsPerDay,
          parseOptionalPositiveInt(currentProConfig.limits?.maxImageEditsPerDay, 20, 1, 5000),
          1,
          5000
        ),
        maxVideoGenerationsPerDay: parseOptionalPositiveInt(
          req.body.maxVideoGenerationsPerDay,
          parseOptionalPositiveInt(currentProConfig.limits?.maxVideoGenerationsPerDay, 5, 1, 5000),
          1,
          5000
        ),
        maxVoiceMessagesPerDay: parseOptionalPositiveInt(
          req.body.maxVoiceMessagesPerDay,
          parseOptionalPositiveInt(currentProConfig.limits?.maxVoiceMessagesPerDay, 80, 1, 5000),
          1,
          5000
        ),
        maxVoiceRealtimeSessionsPerDay: parseOptionalPositiveInt(
          req.body.maxVoiceRealtimeSessionsPerDay,
          parseOptionalPositiveInt(currentProConfig.limits?.maxVoiceRealtimeSessionsPerDay, 60, 1, 5000),
          1,
          5000
        ),
        maxFileAnalysesPerDay: parseOptionalPositiveInt(
          req.body.maxFileAnalysesPerDay,
          parseOptionalPositiveInt(currentProConfig.limits?.maxFileAnalysesPerDay, 30, 1, 5000),
          1,
          5000
        )
      }
    };
  }

  if (section === 'allowlist') {
    patch = {
      allowedUserIds: req.body.allowedUserIds
    };
  }

  if (section === 'prompt') {
    patch = {
      systemPrompt: req.body.systemPrompt
    };
  }

  const merged = withProConfig(config.featureFlagsJson, patch);

  await prisma.appConfig.update({
    where: { id: 1 },
    data: { featureFlagsJson: merged.featureFlagsJson }
  });

  emitProAccessUpdateGlobal({
    source: 'admin:pro-config',
    section
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'PRO_CONFIG_UPDATED',
    meta: {
      via: 'admin-panel',
      section,
      enabled: merged.proConfig.enabled,
      accessMode: merged.proConfig.accessMode,
      keyCount: resolveProApiKeys(merged.proConfig).length,
      modelCounts: {
        text: merged.proConfig.textModels.length,
        vision: merged.proConfig.visionModels.length,
        image: merged.proConfig.imageGenModels.length,
        imageEdit: merged.proConfig.imageEditModels.length,
        video: merged.proConfig.videoGenModels.length,
        voiceAsr: merged.proConfig.voiceAsrModels.length,
        voiceTts: merged.proConfig.voiceTtsModels.length,
        voiceRealtime: merged.proConfig.voiceRealtimeModels.length
      }
    }
  });

  res.redirect(`/admin/pro-config/${section}?success=1`);
});

router.get('/memory-settings', async (req, res) => {
  const [config, workingModelsRaw] = await Promise.all([
    prisma.appConfig.findUnique({ where: { id: 1 } }),
    prisma.availableModel.findMany({
      where: { isWorking: true },
      orderBy: [{ modelId: 'asc' }],
      select: { modelId: true, name: true }
    })
  ]);
  if (!config) {
    return res.status(404).send('Конфигурация приложения не найдена');
  }

  const memorySettings = getMemorySettings(config.featureFlagsJson);
  const configuredScribeModel = `${memorySettings.scribeModel || 'openrouter/auto'}`.trim();
  const optionsMap = new Map();
  optionsMap.set('openrouter/auto', { modelId: 'openrouter/auto', name: 'OpenRouter Auto' });
  for (const item of workingModelsRaw) {
    optionsMap.set(item.modelId, item);
  }
  if (configuredScribeModel && !optionsMap.has(configuredScribeModel)) {
    optionsMap.set(configuredScribeModel, {
      modelId: configuredScribeModel,
      name: `${configuredScribeModel} (current, not in working list)`
    });
  }

  res.render('memory-settings', {
    admin: req.admin,
    memorySettings,
    memoryModelOptions: Array.from(optionsMap.values())
  });
});

router.post('/memory-settings', express.urlencoded({ extended: false }), async (req, res) => {
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  if (!config) {
    return res.status(404).send('Конфигурация приложения не найдена');
  }

  const requestedScribeModel = `${req.body.scribeModel || ''}`.trim();
  let safeScribeModel = 'openrouter/auto';
  if (requestedScribeModel && requestedScribeModel !== 'openrouter/auto') {
    const checked = await prisma.availableModel.findUnique({
      where: { modelId: requestedScribeModel },
      select: { isWorking: true }
    });
    if (checked?.isWorking) {
      safeScribeModel = requestedScribeModel;
    }
  }

  const { featureFlagsJson, memorySettings } = withMemorySettings(config.featureFlagsJson, {
    enabled: parseCheckbox(req.body.enabled),
    scribeModel: safeScribeModel,
    runOnRegenerate: parseCheckbox(req.body.runOnRegenerate),
    summarizeEveryMessages: req.body.summarizeEveryMessages,
    extractFactsEveryMessages: req.body.extractFactsEveryMessages,
    updateProfileEveryMessages: req.body.updateProfileEveryMessages,
    factsWindowMessages: req.body.factsWindowMessages,
    promptHistoryMessages: req.body.promptHistoryMessages,
    maxProfileWords: req.body.maxProfileWords,
    maxSummaryWords: req.body.maxSummaryWords,
    maxPendingFacts: req.body.maxPendingFacts
  });

  await prisma.appConfig.update({
    where: { id: 1 },
    data: { featureFlagsJson }
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'MEMORY_SETTINGS_UPDATED',
    meta: { via: 'admin-panel', memorySettings }
  });

  res.redirect('/admin/memory-settings');
});

router.get('/memory-filters', async (req, res) => {
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  if (!config) {
    return res.status(404).send('Конфигурация приложения не найдена');
  }

  const memorySettings = getMemorySettings(config.featureFlagsJson);
  res.render('memory-filters', {
    admin: req.admin,
    memorySettings,
    ignoredMessagePatternsText: (memorySettings.ignoredMessagePatterns || []).join('\n')
  });
});

router.post('/memory-filters', express.urlencoded({ extended: false }), async (req, res) => {
  const config = await prisma.appConfig.findUnique({ where: { id: 1 } });
  if (!config) {
    return res.status(404).send('Конфигурация приложения не найдена');
  }

  const ignoredMessagePatterns = `${req.body.ignoredMessagePatterns || ''}`
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);

  const { featureFlagsJson, memorySettings } = withMemorySettings(config.featureFlagsJson, {
    importanceFilterEnabled: parseCheckbox(req.body.importanceFilterEnabled),
    useLlmImportanceCheck: parseCheckbox(req.body.useLlmImportanceCheck),
    minMessageLengthForMemory: req.body.minMessageLengthForMemory,
    ignoredMessagePatterns
  });

  await prisma.appConfig.update({
    where: { id: 1 },
    data: { featureFlagsJson }
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'MEMORY_FILTERS_UPDATED',
    meta: { via: 'admin-panel', memorySettings }
  });

  res.redirect('/admin/memory-filters');
});

router.get('/modes', async (req, res) => {
  const modes = await prisma.aiMode.findMany({
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }]
  });

  const editId = Number(req.query.edit || 0);
  const editingMode = Number.isFinite(editId) ? modes.find((item) => item.id === editId) || null : null;

  res.render('modes', { admin: req.admin, modes, editingMode });
});

router.post('/modes/:id', express.urlencoded({ extended: false }), async (req, res) => {
  const modeId = Number(req.params.id);
  if (!Number.isFinite(modeId)) {
    return res.status(400).send('Некорректный id режима');
  }

  const existing = await prisma.aiMode.findUnique({ where: { id: modeId } });
  if (!existing) {
    return res.status(404).send('Режим не найден');
  }

  const name = `${req.body.name || ''}`.trim();
  const emoji = `${req.body.emoji || ''}`.trim();
  const systemPrompt = `${req.body.systemPrompt || ''}`.trim();
  const isActive = req.body.isActive === 'true' || req.body.isActive === 'on';

  if (!name || !emoji || !systemPrompt) {
    return res.status(400).send('Поля name, emoji и systemPrompt обязательны');
  }

  await prisma.aiMode.update({
    where: { id: modeId },
    data: { name, emoji, systemPrompt, isActive }
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'AI_MODE_UPDATED',
    meta: { modeId, key: existing.key, isActive, via: 'admin-panel' }
  });

  res.redirect(`/admin/modes?edit=${modeId}`);
});

router.get('/levels', async (req, res) => {
  const levels = await prisma.aiLevel.findMany({
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }]
  });

  let availableModels = await prisma.availableModel.findMany({
    orderBy: [{ isWorking: 'desc' }, { modelId: 'asc' }]
  });

  // Отфильтровываем все нерабочие модели, но оставляем те, что уже привязаны к уровням
  const selectedModels = new Set();
  levels.forEach(l => {
    if (l.primaryModel) selectedModels.add(l.primaryModel);
    if (l.fallbackModel) selectedModels.add(l.fallbackModel);
  });

  availableModels = availableModels.filter(m => m.isWorking || selectedModels.has(m.modelId));

  res.render('levels', { admin: req.admin, levels, availableModels });
});

router.post('/levels/:id', express.urlencoded({ extended: false }), async (req, res) => {
  const levelId = Number(req.params.id);
  if (!Number.isFinite(levelId)) {
    return res.status(400).send('Некорректный id уровня');
  }

  const existing = await prisma.aiLevel.findUnique({ where: { id: levelId } });
  if (!existing) {
    return res.status(404).send('Уровень не найден');
  }

  const primaryModel = `${req.body.primaryModel || ''}`.trim();
  const fallbackModel = `${req.body.fallbackModel || ''}`.trim();
  const isActive = req.body.isActive === 'true' || req.body.isActive === 'on';

  if (!primaryModel || !fallbackModel) {
    return res.status(400).send('Поля primaryModel и fallbackModel обязательны');
  }

  await prisma.aiLevel.update({
    where: { id: levelId },
    data: { primaryModel, fallbackModel, isActive }
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'AI_LEVEL_UPDATED',
    meta: { levelId, key: existing.key, isActive, via: 'admin-panel' }
  });

  res.redirect('/admin/levels');
});

router.get('/models', async (req, res) => {
  const [availableModels, config] = await Promise.all([
    prisma.availableModel.findMany({
      orderBy: [{ isWorking: 'desc' }, { modelId: 'asc' }]
    }),
    prisma.appConfig.findUnique({
      where: { id: 1 },
      select: { featureFlagsJson: true }
    })
  ]);

  const proConfig = getProConfig(config?.featureFlagsJson);
  const adminModelTestResults = parseAdminModelTestResults(config?.featureFlagsJson);
  const models = buildAdminModelRows({
    availableModels,
    proConfig,
    adminModelTestResults
  });
  const total = models.length;
  const working = models.filter((item) => item.isWorking === true).length;
  const categories = [
    { key: 'all', label: 'Все категории' },
    { key: 'openrouter', label: 'OpenRouter parser' },
    ...[...PRO_MODEL_CATEGORY_DEFS, ...TEXT_POOL_CATEGORY_DEFS].map((item) => ({
      key: item.key,
      label: item.label
    }))
  ];

  res.render('models', { admin: req.admin, models, total, working, categories });
});

router.post('/models/refresh', async (req, res) => {
  try {
    await parseModels();
    await writeAuditLog({
      adminId: req.admin.id,
      action: 'AVAILABLE_MODELS_REFRESHED',
      meta: { via: 'admin-panel' }
    });
  } catch (error) {
    await writeAuditLog({
      adminId: req.admin.id,
      action: 'AVAILABLE_MODELS_REFRESH_FAILED',
      meta: { via: 'admin-panel', error: error.message }
    });
  }

  res.redirect('/admin/models');
});

router.post('/models/test', express.json(), async (req, res) => {
  const modelId = `${req.body.modelId || ''}`.trim();
  const category = `${req.body.category || 'openrouter'}`.trim();
  if (!modelId) return res.status(400).json({ error: 'Не указан modelId' });

  let success = false;
  let ms = null;
  let errorMessage = null;
  const start = Date.now();

  if (category === 'openrouter') {
    const existing = await prisma.availableModel.findUnique({ where: { modelId } });
    if (!existing) return res.status(404).json({ error: 'Модель не найдена' });

    try {
      const { streamOpenRouterCompletion } = require('../services/openrouterService');

      await streamOpenRouterCompletion({
        model: modelId,
        messages: [{ role: 'user', content: 'Say "Ok"' }],
        onToken: (token) => {
          if (token) {
            success = true;
          }
        }
      });
      ms = Date.now() - start;
    } catch (error) {
      success = false;
      errorMessage = error?.message || 'OpenRouter test failed';
    }

    await prisma.availableModel.update({
      where: { modelId },
      data: {
        isWorking: success,
        responseMs: success ? ms : null,
        lastTested: new Date()
      }
    });

    return res.json({ success, ms, error: errorMessage });
  }

  const allowedCategory = [...PRO_MODEL_CATEGORY_DEFS, ...TEXT_POOL_CATEGORY_DEFS].some(
    (item) => item.key === category
  );
  if (!allowedCategory) {
    return res.status(400).json({ error: 'Неизвестная категория модели' });
  }

  const appConfig = await prisma.appConfig.findUnique({
    where: { id: 1 },
    select: { featureFlagsJson: true }
  });
  const proConfig = getProConfig(appConfig?.featureFlagsJson);

  try {
    await testProModelByCategory({ modelId, category, proConfig });
    success = true;
    ms = Date.now() - start;
  } catch (error) {
    success = false;
    errorMessage = error?.message || 'PRO model test failed';
  }

  try {
    await persistAdminModelTestResult({ category, modelId, success, ms });
  } catch (_error) {
    // Ignore persistence issues for admin model tests.
  }

  res.json({ success, ms, error: errorMessage });
});

router.get('/memory/:userId', async (req, res) => {
  const userId = `${req.params.userId || ''}`.trim();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, displayName: true }
  });

  if (!user) {
    return res.status(404).send('Пользователь не найден');
  }

  const [profile, summaries, facts] = await Promise.all([
    prisma.userMemoryProfile.findUnique({ where: { userId } }),
    prisma.sessionSummary.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50
    }),
    prisma.userFact.findMany({
      where: { userId },
      orderBy: [{ category: 'asc' }, { updatedAt: 'desc' }]
    })
  ]);

  const groupedFacts = facts.reduce((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {});

  const normalizedSummaries = summaries.map((item) => ({
    ...item,
    parsedSummary: safeJsonParse(item.summary, item.summary),
    parsedTopics: safeJsonParse(item.topics, [])
  }));

  const profileJsonPretty = JSON.stringify(safeJsonParse(profile?.profileJson || '{}', {}), null, 2);

  res.render('memory', {
    admin: req.admin,
    user,
    profileJsonPretty,
    summaries: normalizedSummaries,
    groupedFacts
  });
});

router.post('/memory/:userId/clear', express.urlencoded({ extended: false }), async (req, res) => {
  const userId = `${req.params.userId || ''}`.trim();
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true }
  });

  if (!target) {
    return res.status(404).send('Пользователь не найден');
  }

  const type = `${req.body.type || 'all'}`.trim().toLowerCase();
  const result = await clearMemory(userId, type);

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'MEMORY_CLEARED_BY_ADMIN',
    targetUserId: userId,
    meta: { via: 'admin-panel', type, result }
  });

  res.redirect(`/admin/memory/${userId}`);
});

router.post('/memory/:userId/restore', express.urlencoded({ extended: false }), async (req, res) => {
  const userId = `${req.params.userId || ''}`.trim();
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true }
  });

  if (!target) {
    return res.status(404).send('Пользователь не найден');
  }

  const type = `${req.body.type || 'all'}`.trim().toLowerCase();
  const result = await restoreMemory(userId, type);

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'MEMORY_RESTORED_BY_ADMIN',
    targetUserId: userId,
    meta: { via: 'admin-panel', type, result }
  });

  res.redirect(`/admin/memory/${userId}`);
});

router.get('/anon-chats', async (req, res) => {
  const status = `${req.query.status || ''}`.trim().toUpperCase();
  const q = `${req.query.q || ''}`.trim();

  const where = {
    ...(status === 'ACTIVE' || status === 'ENDED' ? { status } : {}),
    ...(q
      ? {
          OR: [
            { id: { contains: q } },
            { userA: { username: { contains: q } } },
            { userA: { displayName: { contains: q } } },
            { userB: { username: { contains: q } } },
            { userB: { displayName: { contains: q } } }
          ]
        }
      : {})
  };

  const sessions = await prisma.chatSession.findMany({
    where,
    orderBy: [{ startedAt: 'desc' }],
    take: 300,
    include: {
      userA: {
        select: {
          id: true,
          username: true,
          displayName: true,
          avatar: true,
          isBlocked: true,
          isDeleted: true
        }
      },
      userB: {
        select: {
          id: true,
          username: true,
          displayName: true,
          avatar: true,
          isBlocked: true,
          isDeleted: true
        }
      },
      hiddenForUsers: {
        orderBy: [{ hiddenAt: 'desc' }],
        take: 2,
        select: {
          userId: true,
          hiddenAt: true
        }
      },
      _count: {
        select: {
          messages: true,
          modLogs: true,
          modActions: true,
          hiddenForUsers: true
        }
      }
    }
  });

  const sessionIds = sessions.map((item) => item.id);
  const reportRows = sessionIds.length
    ? await prisma.modLog.groupBy({
        by: ['sessionId'],
        where: {
          type: 'USER_REPORT',
          sessionId: { in: sessionIds }
        },
        _count: { _all: true }
      })
    : [];

  const reportsCountBySession = new Map(
    reportRows.map((item) => [item.sessionId, item._count?._all || 0])
  );

  const decorated = sessions.map((item) => {
    const roles = parseModeRoles(item.mode);
    const reportsCount = reportsCountBySession.get(item.id) || 0;
    return {
      ...item,
      roles,
      reportsCount,
      hiddenForUsersCount: item._count?.hiddenForUsers || 0,
      lastHiddenAt: item.hiddenForUsers?.[0]?.hiddenAt || null
    };
  });

  res.render('anon-chats', {
    admin: req.admin,
    sessions: decorated,
    filters: { status, q }
  });
});

router.get('/anon-chats/:sessionId', async (req, res) => {
  const sessionId = `${req.params.sessionId || ''}`.trim();
  if (!sessionId) {
    return res.status(400).send('Не указан sessionId');
  }

  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    include: {
      userA: {
        select: {
          id: true,
          username: true,
          displayName: true,
          avatar: true,
          isBlocked: true,
          isDeleted: true
        }
      },
      userB: {
        select: {
          id: true,
          username: true,
          displayName: true,
          avatar: true,
          isBlocked: true,
          isDeleted: true
        }
      },
      hiddenForUsers: {
        orderBy: [{ hiddenAt: 'desc' }],
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true
            }
          }
        }
      },
      _count: {
        select: {
          messages: true,
          modLogs: true,
          modActions: true,
          hiddenForUsers: true
        }
      }
    }
  });

  if (!session) {
    return res.status(404).send('Анонимная сессия не найдена');
  }

  const [messages, reportLogsRaw, modActions, activeBanA, activeBanB] = await Promise.all([
    prisma.chatSessionMessage.findMany({
      where: { sessionId: session.id },
      orderBy: [{ sentAt: 'asc' }],
      take: 1000,
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            displayName: true
          }
        }
      }
    }),
    prisma.modLog.findMany({
      where: {
        sessionId: session.id,
        type: 'USER_REPORT'
      },
      orderBy: [{ createdAt: 'desc' }],
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true
          }
        }
      },
      take: 300
    }),
    prisma.modAction.findMany({
      where: { sessionId: session.id },
      orderBy: [{ createdAt: 'desc' }],
      include: {
        admin: {
          select: {
            id: true,
            username: true,
            displayName: true
          }
        },
        targetUser: {
          select: {
            id: true,
            username: true,
            displayName: true
          }
        }
      },
      take: 200
    }),
    getActiveBanForUser(session.userAId, BAN_SCOPE.ANON),
    getActiveBanForUser(session.userBId, BAN_SCOPE.ANON)
  ]);

  const reports = reportLogsRaw.map((item) => formatAnonReport(item));
  const reporterIds = Array.from(
    new Set(
      reports
        .map((item) => item.reporterId)
        .filter(Boolean)
    )
  );

  const reporters = reporterIds.length
    ? await prisma.user.findMany({
        where: {
          id: { in: reporterIds }
        },
        select: {
          id: true,
          username: true,
          displayName: true,
          avatar: true
        }
      })
    : [];

  const reporterById = new Map(reporters.map((item) => [item.id, item]));
  const reportsWithReporter = reports.map((item) => ({
    ...item,
    reporter: item.reporterId ? reporterById.get(item.reporterId) || null : null
  }));

  const normalizedMessages = messages.map((item) => ({
    ...item,
    parsedMeta: safeJsonParse(item.metaJson, null)
  }));

  const roles = parseModeRoles(session.mode);

  res.render('anon-chat-detail', {
    admin: req.admin,
    session: {
      ...session,
      roles
    },
    messages: normalizedMessages,
    reports: reportsWithReporter,
    modActions,
    activeBans: {
      [session.userAId]: activeBanA,
      [session.userBId]: activeBanB
    }
  });
});

router.post('/anon-chats/:sessionId/ban', express.urlencoded({ extended: false }), async (req, res) => {
  const sessionId = `${req.params.sessionId || ''}`.trim();
  const targetUserId = `${req.body.targetUserId || ''}`.trim();
  const levelRaw = `${req.body.level || 'SOFT'}`.trim().toUpperCase();
  const reason = `${req.body.reason || 'Нарушения в анонимном чате'}`.trim().slice(0, 240);
  const durationHoursRaw = Number(req.body.durationHours);
  const durationMinutesRaw = Number(req.body.durationMinutes);

  if (!sessionId || !targetUserId) {
    return res.status(400).send('Недостаточно данных для бана');
  }

  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      status: true,
      userAId: true,
      userBId: true
    }
  });

  if (!session) {
    return res.status(404).send('Анонимная сессия не найдена');
  }

  if (targetUserId !== session.userAId && targetUserId !== session.userBId) {
    return res.status(400).send('Пользователь не принадлежит выбранной сессии');
  }

  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, username: true, displayName: true }
  });
  if (!target) {
    return res.status(404).send('Пользователь не найден');
  }

  const existingActive = await getActiveBanForUser(targetUserId, BAN_SCOPE.ANON);
  const level = ['SOFT', 'HARD', 'PERMANENT'].includes(levelRaw) ? levelRaw : 'SOFT';
  const defaultMinutes = level === 'HARD' ? 24 * 60 : 60;
  const durationMinutes = Number.isFinite(durationMinutesRaw)
    ? Math.min(Math.max(durationMinutesRaw, 1), 24 * 180 * 60)
    : Number.isFinite(durationHoursRaw)
    ? Math.min(Math.max(durationHoursRaw * 60, 1), 24 * 180 * 60)
    : defaultMinutes;
  const expiresAt = level === 'PERMANENT' ? null : new Date(Date.now() + durationMinutes * 60 * 1000);

  if (existingActive) {
    await prisma.ban.update({
      where: { id: existingActive.id },
      data: {
        level,
        reason: reason || 'Нарушения в анонимном чате',
        isActive: true,
        expiresAt
      }
    });
  } else {
    await prisma.ban.create({
      data: {
        userId: targetUserId,
        scope: BAN_SCOPE.ANON,
        level,
        reason: reason || 'Нарушения в анонимном чате',
        isActive: true,
        expiresAt
      }
    });
  }

  await prisma.modAction.create({
    data: {
      adminId: req.admin.id,
      targetUserId,
      sessionId: session.id,
      action: 'ban_user',
      reason,
      metadataJson: JSON.stringify({
        via: 'admin-panel',
        level: levelRaw
      })
    }
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'ANON_CHAT_USER_BANNED',
    targetUserId,
    meta: {
      via: 'admin-panel',
      sessionId: session.id,
      reason,
      level: levelRaw
    }
  });

  if (`${session.status}`.toUpperCase() === 'ACTIVE') {
    const io = getIo();
    if (io) {
      try {
        await adminEndSession(io, {
          sessionId: session.id,
          reason: 'banned_by_admin',
          adminId: req.admin.id
        });
      } catch (_error) {
        // ignore if active socket session was already closed
      }
    }
  }

  res.redirect(`/admin/anon-chats/${session.id}?success=1`);
});

router.post('/anon-chats/:sessionId/purge', async (req, res) => {
  const sessionId = `${req.params.sessionId || ''}`.trim();
  if (!sessionId) return res.status(400).send('Не указан sessionId');

  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { id: true, userAId: true, userBId: true }
  });
  if (!session) return res.status(404).send('Анонимная сессия не найдена');

  await purgeAnonSessionById(session.id);
  await writeAuditLog({
    adminId: req.admin.id,
    action: 'ANON_CHAT_PURGED',
    targetUserId: session.userAId,
    meta: {
      via: 'admin-panel',
      sessionId: session.id,
      userAId: session.userAId,
      userBId: session.userBId
    }
  });

  res.redirect('/admin/anon-chats');
});

router.get('/support/tickets', async (req, res) => {
  const status = `${req.query.status || ''}`.trim().toUpperCase();
  const type = `${req.query.type || ''}`.trim().toUpperCase();
  const q = `${req.query.q || ''}`.trim();

  const where = {
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(q
      ? {
          OR: [
            { message: { contains: q } },
            { user: { username: { contains: q } } },
            { user: { displayName: { contains: q } } }
          ]
        }
      : {})
  };

  const tickets = await prisma.supportTicket.findMany({
    where,
    include: {
      user: {
        select: {
          id: true,
          username: true,
          displayName: true
        }
      }
    },
    orderBy: [{ createdAt: 'desc' }]
  });

  res.render('support-tickets', {
    admin: req.admin,
    tickets,
    filters: { status, type, q }
  });
});

router.post('/support/tickets/:id', express.urlencoded({ extended: false }), async (req, res) => {
  const ticketId = `${req.params.id || ''}`.trim();
  const status = `${req.body.status || ''}`.trim().toUpperCase();
  const adminNote = `${req.body.adminNote || ''}`.trim();

  const existing = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
  if (!existing) {
    return res.status(404).send('Обращение не найдено');
  }

  await prisma.supportTicket.update({
    where: { id: ticketId },
    data: {
      ...(status ? { status } : {}),
      adminNote: adminNote || null
    }
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'SUPPORT_TICKET_UPDATED',
    targetUserId: existing.userId,
    meta: {
      via: 'admin-panel',
      ticketId,
      status: status || existing.status
    }
  });

  res.redirect('/admin/support/tickets');
});

router.get('/support/appeals', async (req, res) => {
  const status = `${req.query.status || ''}`.trim().toUpperCase();

  const appeals = await prisma.appeal.findMany({
    where: status ? { status } : undefined,
    include: {
      user: {
        select: {
          id: true,
          username: true,
          displayName: true
        }
      },
      ban: true
    },
    orderBy: [{ createdAt: 'desc' }]
  });

  res.render('support-appeals', {
    admin: req.admin,
    appeals,
    filters: { status }
  });
});

router.post('/support/appeals/:id', express.urlencoded({ extended: false }), async (req, res) => {
  const appealId = `${req.params.id || ''}`.trim();
  const status = `${req.body.status || ''}`.trim().toUpperCase();
  const adminNote = `${req.body.adminNote || ''}`.trim();

  const existing = await prisma.appeal.findUnique({
    where: { id: appealId },
    include: { ban: true, user: true }
  });

  if (!existing) {
    return res.status(404).send('Апелляция не найдена');
  }

  const resolvedAt = status === 'APPROVED' || status === 'REJECTED' ? new Date() : null;

  await prisma.$transaction(async (tx) => {
    await tx.appeal.update({
      where: { id: appealId },
      data: {
        ...(status ? { status } : {}),
        adminNote: adminNote || null,
        ...(resolvedAt ? { resolvedAt } : {})
      }
    });

    if (status === 'APPROVED') {
      await tx.ban.update({
        where: { id: existing.banId },
        data: { isActive: false, expiresAt: new Date() }
      });
    }
  });

  await writeAuditLog({
    adminId: req.admin.id,
    action: 'SUPPORT_APPEAL_UPDATED',
    targetUserId: existing.userId,
    meta: {
      via: 'admin-panel',
      appealId,
      status: status || existing.status
    }
  });

  res.redirect('/admin/support/appeals');
});

router.get('/logs', async (req, res) => {
  const [auditLogs, crisisLogs] = await Promise.all([
    prisma.adminAuditLog.findMany({
      take: 100,
      orderBy: { createdAt: 'desc' },
      include: {
        admin: { select: { username: true } },
        targetUser: { select: { username: true } }
      }
    }),
    prisma.crisisEvent.findMany({
      take: 100,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { username: true } }, chat: { select: { title: true } } }
    })
  ]);

  res.render('logs', { admin: req.admin, auditLogs, crisisLogs });
});

module.exports = { adminPanelRoutes: router };
