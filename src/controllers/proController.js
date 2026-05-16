const fs = require('fs/promises');
const { z } = require('zod');
const { AppError } = require('../utils/errors');
const { logger } = require('../utils/logger');
const { prisma } = require('../config/prisma');
const { getIo } = require('../socket/io');
const { userRoom } = require('../socket/rooms');
const { buildTierModelCandidates, normalizeTier } = require('../constants/proTextModelPools');
const {
  resolveExtensionByMime,
  resolvePublicBaseUrl,
  parseDataUrl,
  persistBufferForUser,
  persistDataUrlForUser
} = require('../utils/mediaStorage');
const {
  runChatWithFallback,
  runChatStreamWithFallback,
  runImageGenerationWithFallback,
  runImageEditWithFallback,
  runVideoGenerationWithFallback,
  runVideoTaskStatusWithFallback,
  runTranscriptionWithFallback,
  runSpeechSynthesisWithFallback
} = require('../services/proProviderService');
const {
  PRO_DAILY_FEATURE_KEYS,
  resolveDailyLimitFromConfig,
  consumeDailyQuotaOrThrow
} = require('../services/proUsageService');
const { compressConversationToMemory } = require('../services/memoryService');
const { extractBearerToken } = require('../middlewares/auth');

/**
 * proController.js — самый большой HTTP-контроллер PRO режима.
 *
 * Простыми словами этот файл делает "входную дверь" для всех PRO-функций:
 * - текстовый PRO chat;
 * - streaming chat;
 * - web search mode;
 * - thinking mode;
 * - анализ изображений;
 * - генерация/редактирование изображений;
 * - генерация видео;
 * - анализ файлов;
 * - голосовое сообщение;
 * - realtime voice webview/config;
 * - синхронизация локальных PRO-чатов клиента с сервером;
 * - сохранение результатов в память пользователя.
 *
 * Важно: реальная работа с Qwen/OpenRouter/провайдерами лежит не здесь, а в
 * proProviderService. Здесь мы валидируем HTTP-запрос, выбираем настройки,
 * вызываем service и собираем ответ для клиента.
 */

const CHAT_ROLE_SET = new Set(['system', 'user', 'assistant']);
const THINKING_PRIMARY_MODEL = 'qwen3-235b-a22b';

// Схема обычного/streaming PRO chat запроса.
// Клиент может прислать либо prompt, либо готовый массив messages.
const chatSchema = z
  .object({
    prompt: z.string().min(1).max(8000).optional(),
    messages: z
      .array(
        z.object({
          role: z.string().min(1).max(20),
          content: z.any()
        })
      )
      .max(60)
      .optional(),
    model: z.string().min(1).max(140).optional(),
    modelTier: z.enum(['fast', 'standard', 'best']).optional(),
    enableSearch: z.boolean().optional(),
    enableThinking: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(64).max(8192).optional()
  })
  .refine(
    (payload) => {
      if (payload.prompt && payload.prompt.trim()) return true;
      return Array.isArray(payload.messages) && payload.messages.length > 0;
    },
    {
      message: 'Pass prompt or messages'
    }
  );

// Анализ изображения: imageUrl может быть обычным URL или dataUrl/base64.
const imageAnalyzeSchema = z.object({
  imageUrl: z.string().min(8).max(16_000_000),
  prompt: z.string().min(1).max(4000).optional(),
  model: z.string().min(1).max(140).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(8192).optional()
});

// Генерация изображения: prompt обязателен, chatId нужен для сохранения результата в чат.
const imageGenerateSchema = z.object({
  prompt: z.string().min(1).max(4000),
  model: z.string().min(1).max(140).optional(),
  size: z.string().min(3).max(32).optional(),
  chatId: z.string().min(1).max(120).optional()
});

// Редактирование изображения: исходная картинка + prompt что изменить.
const imageEditSchema = z.object({
  imageUrl: z.string().min(8).max(16_000_000),
  prompt: z.string().min(1).max(4000).optional(),
  model: z.string().min(1).max(140).optional(),
  size: z.string().min(3).max(32).optional(),
  chatId: z.string().min(1).max(120).optional()
});

// Генерация видео: prompt + опциональная стартовая картинка и параметры видео.
const videoGenerateSchema = z.object({
  prompt: z.string().min(1).max(4000),
  model: z.string().min(1).max(140).optional(),
  size: z.string().min(3).max(32).optional(),
  imageUrl: z.string().min(8).max(16_000_000).optional(),
  chatId: z.string().min(1).max(120).optional(),
  durationSeconds: z.number().int().min(1).max(120).optional(),
  aspectRatio: z.string().min(3).max(20).optional(),
  waitForSeconds: z.number().int().min(0).max(120).optional()
});

// Голосовое сообщение: клиент присылает audioBase64, сервер делает ASR -> LLM -> TTS.
const voiceMessageSchema = z.object({
  audioBase64: z.string().min(64).max(20_000_000),
  mimeType: z.string().min(3).max(80).optional(),
  language: z.string().min(2).max(16).optional(),
  asrModel: z.string().min(1).max(140).optional(),
  textModel: z.string().min(1).max(140).optional(),
  ttsModel: z.string().min(1).max(140).optional(),
  ttsVoice: z.string().min(1).max(40).optional(),
  returnAudio: z.boolean().optional()
});

// Анализ файла: файл приходит base64, дальше мы пытаемся извлечь текст.
const fileAnalyzeSchema = z.object({
  fileName: z.string().min(1).max(240),
  mimeType: z.string().min(3).max(120).optional(),
  fileBase64: z.string().min(20).max(20_000_000),
  prompt: z.string().min(1).max(4000).optional(),
  chatId: z.string().min(1).max(120).optional(),
  model: z.string().min(1).max(140).optional(),
  modelTier: z.enum(['fast', 'standard', 'best']).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(8192).optional()
});

// Сообщение PRO-чата при sync. Тут поддержаны text/image/video/file и thinking display.
const proChatMessageSchema = z.object({
  id: z.string().min(1).max(120),
  role: z.enum(['user', 'assistant', 'system']).optional(),
  type: z.enum(['text', 'image', 'video', 'file']).optional(),
  displayMode: z.enum(['default', 'thinking']).optional(),
  content: z.string().max(8000).optional(),
  imageUrl: z.string().max(16_000_000).optional().nullable(),
  videoUrl: z.string().max(16_000_000).optional().nullable(),
  fileUrl: z.string().max(16_000_000).optional().nullable(),
  fileName: z.string().max(240).optional().nullable(),
  fileMimeType: z.string().max(120).optional().nullable(),
  fileSize: z.number().int().min(0).max(20_000_000).optional().nullable(),
  durationSeconds: z.number().int().min(0).max(24 * 60 * 60).optional().nullable(),
  createdAt: z.string().max(80).optional()
});

// Синхронизация списка локальных PRO-чатов клиента с сервером.
const proChatSyncSchema = z.object({
  chats: z
    .array(
      z.object({
        id: z.string().min(1).max(120),
        title: z.string().min(1).max(240),
        modelTier: z.enum(['fast', 'standard', 'best']).optional(),
        toolMode: z.enum(['chat', 'image_generate', 'image_edit', 'image_analyze', 'video_generate']).optional(),
        messages: z.array(proChatMessageSchema).max(300).optional(),
        lastMessage: z.string().max(4000).optional(),
        createdAt: z.string().max(80).optional(),
        updatedAt: z.string().max(80).optional()
      })
    )
    .max(200),
  live: z.boolean().optional(),
  partial: z.boolean().optional()
});

// Жёсткие лимиты по умолчанию. Админ может переопределить часть через proConfig.limits.
const MAX_FILE_ANALYZE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_ANALYZE_TEXT_CHARS = 18000;
const FILE_ANALYZE_TEXT_MIME_SET = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'text/xml',
  'application/json',
  'application/xml',
  'application/x-yaml',
  'text/yaml'
]);
const FILE_ANALYZE_TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'json',
  'xml',
  'html',
  'htm',
  'yml',
  'yaml',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'py',
  'java',
  'kt',
  'rb',
  'php',
  'go',
  'rs',
  'swift',
  'sql',
  'log',
  'ini',
  'cfg',
  'conf'
]);

function clampRuntimeNumber(value, fallback, min, max) {
  // Берём число из конфига, но не доверяем ему полностью.
  // Если админ случайно поставит слишком мало/много/не число — используем безопасные рамки.
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function resolveRuntimeLimits(proConfig) {
  // Собирает runtime-лимиты из PRO config.
  // Это защита от слишком больших файлов, prompt-ов и audio payload.
  const limits = proConfig?.limits && typeof proConfig.limits === 'object' ? proConfig.limits : {};
  return {
    maxFileAnalyzeBytes: clampRuntimeNumber(
      limits.maxFileAnalyzeBytes,
      MAX_FILE_ANALYZE_BYTES,
      256 * 1024,
      20_000_000
    ),
    maxImagePromptChars: clampRuntimeNumber(limits.maxImagePromptChars, 4000, 200, 12_000),
    maxVideoPromptChars: clampRuntimeNumber(limits.maxVideoPromptChars, 4000, 200, 12_000),
    maxVoiceAudioBase64Chars: clampRuntimeNumber(limits.maxVoiceAudioBase64Chars, 20_000_000, 50_000, 20_000_000),
    maxVideoDurationSeconds: clampRuntimeNumber(limits.maxVideoDurationSeconds, 120, 1, 180),
    maxMessagesPerRequest: clampRuntimeNumber(limits.maxMessagesPerRequest, 60, 1, 120)
  };
}

function resolveResponseMaxTokens(proConfig, requestedMaxTokens) {
  // maxTokens можно запросить с клиента, но итог всё равно ограничен server config.
  const configuredMaxTokens = clampRuntimeNumber(proConfig?.maxOutputTokens, 2048, 128, 8192);
  if (!Number.isFinite(Number(requestedMaxTokens))) return configuredMaxTokens;
  return Math.min(configuredMaxTokens, Math.max(64, Number(requestedMaxTokens)));
}

async function consumeDailyQuota(req, proConfig, featureKey) {
  // Списывает дневной лимит конкретной PRO-функции.
  // Если лимит отключён или featureKey пустой, просто ничего не списываем.
  const dailyLimit = resolveDailyLimitFromConfig(proConfig, featureKey, null);
  if (!Number.isFinite(Number(dailyLimit)) || Number(dailyLimit) <= 0) {
    return null;
  }

  return consumeDailyQuotaOrThrow({
    userId: req.user?.id,
    featureKey,
    limit: dailyLimit
  });
}

function uniqueModelCandidates(preferred, list = []) {
  // Собирает список моделей без дублей: сначала preferred, потом остальные.
  // Так provider пробует лучшую/выбранную модель первой.
  const result = [];
  const push = (value) => {
    const normalized = `${value || ''}`.trim();
    if (!normalized || result.includes(normalized)) return;
    result.push(normalized);
  };

  push(preferred);
  for (const item of list) push(item);
  return result;
}

function toInlineJson(value) {
  // JSON внутри prompt не должен случайно превратиться в HTML/script.
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function parseGoals(rawGoals) {
  // goals в user лежат JSON-строкой. Если сломано — безопасно возвращаем [].
  if (!rawGoals) return [];
  if (Array.isArray(rawGoals)) return rawGoals.map((item) => `${item || ''}`.trim()).filter(Boolean);
  try {
    const parsed = JSON.parse(rawGoals);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => `${item || ''}`.trim()).filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function buildUserContextPrompt(user) {
  // Формирует маленький блок профиля пользователя для system prompt.
  // Это даёт Alma имя, возраст и цели без длинного запроса в память.
  if (!user || typeof user !== 'object') return '';

  const displayName = `${user.displayName || ''}`.trim();
  const username = `${user.username || ''}`.trim();
  const age = Number.isFinite(Number(user.age)) ? Number(user.age) : null;
  const goals = parseGoals(user.goals).slice(0, 5);
  const lines = [];

  if (displayName) lines.push(`Preferred name: ${displayName}`);
  if (username) lines.push(`Username: ${username}`);
  if (age) lines.push(`Age: ${age}`);
  if (goals.length) lines.push(`Goals: ${goals.join(', ')}`);
  if (!lines.length) return '';

  return [
    'User profile context:',
    ...lines,
    'Use this context naturally and address the user by preferred name when appropriate.'
  ].join('\n');
}

function buildPersonalizedSystemPrompt(basePrompt, user) {
  // Базовый prompt + user context + запрет markdown.
  // Для чата важен обычный текст, потому что mobile UI отображает plain text.
  const base = `${basePrompt || ''}`.trim();
  const profileBlock = buildUserContextPrompt(user);
  const plainTextRules = [
    'Response formatting rules:',
    '- Reply in plain text only.',
    '- Do not use Markdown, headings, bullet lists, tables, or code blocks.',
    '- Keep answers concise and readable with short paragraphs.'
  ].join('\n');

  const blocks = [base, profileBlock, plainTextRules].map((item) => `${item || ''}`.trim()).filter(Boolean);
  return blocks.join('\n\n').trim();
}

function buildImageAnalysisSystemPrompt(basePrompt, user) {
  // Для анализа изображений добавляем отдельные правила: не markdown, не списки,
  // коротко и понятно описывать то, что видно на картинке.
  const personalizedBase = buildPersonalizedSystemPrompt(basePrompt, user);
  const formattingRules = [
    'Image analysis output rules:',
    '- Reply in plain text only.',
    '- Do not use Markdown, lists, headings, tables, or code blocks.',
    '- Do not use backticks, asterisks, or numbered formatting.',
    '- Keep response clear, structured with simple sentences and short paragraphs.'
  ].join('\n');

  if (!personalizedBase) return formattingRules;
  return `${personalizedBase}\n\n${formattingRules}`.trim();
}

function buildFileAnalysisSystemPrompt(basePrompt, user) {
  // Для анализа файлов модель должна опираться на содержимое файла, а не выдумывать.
  const personalizedBase = buildPersonalizedSystemPrompt(basePrompt, user);
  const rules = [
    'File analysis output rules:',
    '- Reply in plain text only.',
    '- Do not use Markdown, headings, tables, or code blocks.',
    '- If file text is truncated, mention it briefly and continue with actionable analysis.',
    '- Keep recommendations concrete and concise.'
  ].join('\n');

  if (!personalizedBase) return rules;
  return `${personalizedBase}\n\n${rules}`.trim();
}

function sanitizeUploadedFileName(value) {
  // Имя файла от клиента нельзя использовать как есть.
  // Убираем опасные символы и ограничиваем длину.
  const raw = `${value || ''}`.trim();
  if (!raw) return 'file';
  const cleaned = raw.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'file';
  return cleaned.slice(0, 240);
}

function resolveFileExtension(fileName) {
  // Достаём расширение без точки: "report.txt" -> "txt".
  const normalized = `${fileName || ''}`.trim().toLowerCase();
  const match = normalized.match(/\.([a-z0-9]{1,12})$/i);
  return `${match?.[1] || ''}`.trim().toLowerCase();
}

function normalizeUploadedFileMime(mimeType, fileName) {
  // Если клиент не прислал MIME, пытаемся угадать его по расширению файла.
  const normalizedMime = `${mimeType || ''}`.trim().toLowerCase();
  if (normalizedMime) return normalizedMime;
  const ext = resolveFileExtension(fileName);
  if (!ext) return 'application/octet-stream';
  if (ext === 'txt' || ext === 'log') return 'text/plain';
  if (ext === 'md' || ext === 'markdown') return 'text/markdown';
  if (ext === 'csv') return 'text/csv';
  if (ext === 'json') return 'application/json';
  if (ext === 'xml') return 'application/xml';
  if (ext === 'yml' || ext === 'yaml') return 'application/x-yaml';
  if (ext === 'html' || ext === 'htm') return 'text/html';
  if (FILE_ANALYZE_TEXT_EXTENSIONS.has(ext)) return 'text/plain';
  return 'application/octet-stream';
}

function supportsFileTextAnalysis({ mimeType, fileName }) {
  // Анализ файла сейчас поддерживает только текстовые форматы.
  // Бинарные PDF/DOCX без отдельного парсера здесь не извлекаются.
  const normalizedMime = `${mimeType || ''}`.trim().toLowerCase();
  if (normalizedMime.startsWith('text/')) return true;
  if (FILE_ANALYZE_TEXT_MIME_SET.has(normalizedMime)) return true;

  const ext = resolveFileExtension(fileName);
  if (!ext) return false;
  return FILE_ANALYZE_TEXT_EXTENSIONS.has(ext);
}

function normalizeExtractedFileText(value) {
  // Убираем нулевые символы и режем текст до безопасного размера для модели.
  const text = `${value || ''}`.replace(/\u0000/g, '').trim();
  if (!text) return '';
  if (text.length <= MAX_FILE_ANALYZE_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_FILE_ANALYZE_TEXT_CHARS)}\n\n[TRUNCATED]`;
}

function extractTextForFileAnalysis({ buffer, mimeType, fileName }) {
  // Превращаем buffer в UTF-8 текст только если тип файла поддерживается.
  if (!Buffer.isBuffer(buffer) || !buffer.length) return '';
  if (!supportsFileTextAnalysis({ mimeType, fileName })) return '';

  try {
    return normalizeExtractedFileText(buffer.toString('utf8'));
  } catch (_error) {
    return '';
  }
}

function resolveAudioFileExt(mimeType) {
  // Подбираем расширение временного аудиофайла для ASR.
  return resolveExtensionByMime(mimeType, 'webm');
}

async function persistVoiceTempAudioFile({ userId, audioBase64, mimeType, req }) {
  // Голос сначала сохраняем во временный файл.
  // Провайдеру ASR часто удобнее получить file URL/path, а не огромную base64 строку.
  const normalizedAudio = `${audioBase64 || ''}`.trim();
  if (!normalizedAudio) return null;
  const binary = Buffer.from(normalizedAudio, 'base64');
  if (!binary.length) return null;

  return persistBufferForUser({
    userId,
    segments: ['pro', 'voice-temp'],
    prefix: 'voice',
    mimeType: mimeType || 'audio/webm',
    buffer: binary,
    req,
    publicBaseUrl: resolvePublicBaseUrl(req)
  });
}

async function cleanupVoiceTempAudio(filePath) {
  // Удаляем временный audio file после transcription.
  // Ошибка удаления не должна ломать ответ пользователю.
  const safePath = `${filePath || ''}`.trim();
  if (!safePath) return;
  try {
    await fs.unlink(safePath);
  } catch (_error) {
    // Non-critical cleanup.
  }
}

async function resolveImageUrlForProvider({ userId, imageUrl, req, chatId, purpose }) {
  // Если клиент прислал dataUrl/base64, сохраняем картинку в uploads и получаем publicUrl.
  // Если это уже URL, отдаём его как есть.
  const source = `${imageUrl || ''}`.trim();
  if (!source) return '';
  if (!source.startsWith('data:image/')) return source;

  const stored = await persistDataUrlForUser({
    userId,
    dataUrl: source,
    segments: ['pro', 'chats', `${chatId || 'general'}`, purpose || 'images'],
    prefix: purpose || 'image',
    req,
    publicBaseUrl: resolvePublicBaseUrl(req),
    allowedMimePrefixes: ['image/']
  });

  if (stored?.publicUrl) return stored.publicUrl;
  return source;
}

async function persistGeneratedImageFromBase64({ userId, base64, req, purpose, chatId }) {
  // Некоторые провайдеры возвращают картинку base64.
  // Сохраняем её у себя, чтобы клиент получил стабильную ссылку.
  const normalized = `${base64 || ''}`.trim();
  if (!normalized) return null;
  const buffer = Buffer.from(normalized, 'base64');
  if (!buffer.length) return null;

  return persistBufferForUser({
    userId,
    segments: ['pro', 'chats', `${chatId || 'general'}`, 'generated', purpose || 'default'],
    prefix: purpose || 'image',
    mimeType: 'image/png',
    buffer,
    req,
    publicBaseUrl: resolvePublicBaseUrl(req, { allowPrivate: true })
  });
}

async function persistGeneratedImageFromRemoteUrl({ userId, imageUrl, req, purpose, chatId }) {
  // Некоторые провайдеры возвращают remote URL.
  // Скачиваем и кешируем у себя, чтобы ссылка не умерла через время.
  const source = `${imageUrl || ''}`.trim();
  if (!source || source.startsWith('data:')) return null;

  let response;
  try {
    response = await fetch(source);
  } catch (_error) {
    return null;
  }

  if (!response?.ok) return null;

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (!buffer.length) return null;

  const contentTypeRaw = `${response.headers?.get('content-type') || ''}`.trim().toLowerCase();
  const contentType = contentTypeRaw.split(';')[0].trim();
  const safeMimeType = contentType.startsWith('image/') ? contentType : 'image/png';

  return persistBufferForUser({
    userId,
    segments: ['pro', 'chats', `${chatId || 'general'}`, 'generated', purpose || 'default'],
    prefix: purpose || 'image',
    mimeType: safeMimeType,
    buffer,
    req,
    publicBaseUrl: resolvePublicBaseUrl(req, { allowPrivate: true })
  });
}

function resolveVideoMimeTypeBySource(source) {
  // MIME видео нужен для правильного расширения при сохранении файла.
  const normalized = `${source || ''}`.trim().toLowerCase();
  if (!normalized) return 'video/mp4';
  if (normalized.includes('.webm')) return 'video/webm';
  if (normalized.includes('.mov') || normalized.includes('.m4v')) return 'video/quicktime';
  return 'video/mp4';
}

async function persistGeneratedVideoFromRemoteUrl({ userId, videoUrl, req, chatId, taskId, purpose }) {
  // Видео всегда лучше сохранять на нашем сервере:
  // внешние provider URLs часто временные и плохо открываются на native.
  const source = `${videoUrl || ''}`.trim();
  if (!source || source.startsWith('data:')) return null;
  if (/\/uploads\//i.test(source)) {
    return {
      publicUrl: source
    };
  }

  let response;
  try {
    response = await fetch(source);
  } catch (_error) {
    return null;
  }

  if (!response?.ok) return null;

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (!buffer.length) return null;

  const contentTypeRaw = `${response.headers?.get('content-type') || ''}`.trim().toLowerCase();
  const contentType = contentTypeRaw.split(';')[0].trim();
  const safeMimeType = contentType.startsWith('video/') ? contentType : resolveVideoMimeTypeBySource(source);

  return persistBufferForUser({
    userId,
    segments: ['pro', 'chats', `${chatId || taskId || 'general'}`, 'generated', 'video'],
    prefix: purpose || 'video',
    mimeType: safeMimeType,
    buffer,
    req,
    publicBaseUrl: resolvePublicBaseUrl(req, { allowPrivate: true })
  });
}

function resolveModelQualityScore(model) {
  // Простая эвристика качества модели по названию.
  // Нужна, чтобы отсортировать пул моделей от более сильных к более слабым.
  const text = `${model || ''}`.trim().toLowerCase();
  if (!text) return -9999;

  let score = 0;
  if (text.includes('max')) score += 200;
  if (text.includes('plus')) score += 160;
  if (text.includes('pro')) score += 120;
  if (text.includes('thinking') || text.includes('reasoning')) score += 80;

  const sizeMatch = text.match(/(\d{1,4})b\b/);
  if (sizeMatch) {
    score += Math.min(Number(sizeMatch[1]) || 0, 500);
  }

  if (text.includes('flash')) score -= 120;
  if (text.includes('lite')) score -= 110;
  if (text.includes('mini')) score -= 90;
  if (text.includes('turbo')) score -= 50;
  if (text.includes('preview')) score -= 15;

  return score;
}

function resolveTextModelCandidates(preferredModel, modelTier, configuredModels = []) {
  // Выбирает очередь текстовых моделей для PRO-чата:
  // preferred -> модели нужного tier -> остальные configured models.
  const preferred = `${preferredModel || ''}`.trim();
  const merged = [];
  const push = (value) => {
    const normalized = `${value || ''}`.trim();
    if (!normalized || merged.includes(normalized)) return;
    merged.push(normalized);
  };

  if (preferred) {
    push(preferred);
  }

  const collected = [];
  const collect = (value) => {
    const normalized = `${value || ''}`.trim();
    if (!normalized || normalized === preferred || collected.includes(normalized)) return;
    collected.push(normalized);
  };

  const tierCandidates = buildTierModelCandidates(normalizeTier(modelTier), configuredModels);
  for (const model of tierCandidates) collect(model);
  for (const model of configuredModels) collect(model);

  collected.sort((left, right) => {
    const diff = resolveModelQualityScore(right) - resolveModelQualityScore(left);
    if (diff !== 0) return diff;
    return left.localeCompare(right);
  });

  for (const model of collected) push(model);
  return merged;
}

function resolveSearchModelScore(model) {
  // Для режима поиска отдельная оценка: search лучше работает на instruct/omni,
  // а coder/flash/mini хуже подходят для фактических ответов с источниками.
  const text = `${model || ''}`.trim().toLowerCase();
  if (!text) return -9999;
  let score = resolveModelQualityScore(text);
  if (text.includes('omni')) score += 40;
  if (text.includes('instruct')) score += 30;
  if (text.includes('coder')) score -= 70;
  if (text.includes('flash')) score -= 140;
  if (text.includes('mini')) score -= 140;
  if (text.includes('lite')) score -= 140;
  if (text.includes('turbo')) score -= 80;
  return score;
}

function resolveSearchTextModelCandidates(modelTier, configuredModels = []) {
  // Возвращает короткую очередь моделей именно для search mode.
  const base = resolveTextModelCandidates('', modelTier, configuredModels);
  if (!base.length) return [];

  const sorted = [...base].sort((left, right) => {
    const diff = resolveSearchModelScore(right) - resolveSearchModelScore(left);
    if (diff !== 0) return diff;
    return left.localeCompare(right);
  });

  const highConfidence = sorted.filter((model) => resolveSearchModelScore(model) >= 120);
  const mediumConfidence = sorted.filter((model) => resolveSearchModelScore(model) >= 20);
  const selected = highConfidence.length >= 2 ? highConfidence : mediumConfidence.length ? mediumConfidence : sorted;
  return selected.slice(0, 6);
}

function prioritizeModelCandidate(candidates, modelName) {
  // Thinking mode может требовать конкретную модель.
  // Поднимаем её в начало очереди, но остальные оставляем как fallback.
  const target = `${modelName || ''}`.trim();
  const source = Array.isArray(candidates) ? candidates : [];
  if (!target) return source;
  const without = source.filter((item) => `${item || ''}`.trim() !== target);
  return [target, ...without];
}

function applySearchModeGuidanceEnhanced(messages, enableSearch) {
  // Если поиск включён, добавляем system-инструкцию:
  // проверять свежие факты, давать source URLs и image URL для физических объектов.
  const source = Array.isArray(messages) ? messages : [];
  if (enableSearch !== true) return source;
  return [
    {
      role: 'system',
      content:
        'Web search mode is enabled. For time-sensitive queries, verify with fresh sources and include direct source URLs. If the user asks about a physical object, add one direct image URL and a concise explanation.'
    },
    ...source
  ].slice(0, 60);
}

function normalizeMessages(payloadMessages, prompt, systemPrompt) {
  // Приводит вход к единому виду messages[].
  // Клиент может прислать либо prompt, либо полноценную историю messages.
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  if (Array.isArray(payloadMessages) && payloadMessages.length) {
    for (const message of payloadMessages) {
      const role = `${message?.role || ''}`.trim().toLowerCase();
      if (!CHAT_ROLE_SET.has(role)) continue;
      if (typeof message?.content === 'undefined' || message?.content === null) continue;
      messages.push({ role, content: message.content });
      if (messages.length >= 60) break;
    }
  } else {
    const text = `${prompt || ''}`.trim();
    if (text) {
      messages.push({ role: 'user', content: text });
    }
  }

  return messages;
}

// Коды Open-Meteo -> русский текст + иконка OpenWeather.
const WEATHER_ICON_BY_CODE = {
  0: { text: 'Ясно', day: '01d', night: '01n' },
  1: { text: 'Преимущественно ясно', day: '02d', night: '02n' },
  2: { text: 'Переменная облачность', day: '03d', night: '03n' },
  3: { text: 'Пасмурно', day: '04d', night: '04n' },
  45: { text: 'Туман', day: '50d', night: '50n' },
  48: { text: 'Инейный туман', day: '50d', night: '50n' },
  51: { text: 'Легкая морось', day: '09d', night: '09n' },
  53: { text: 'Морось', day: '09d', night: '09n' },
  55: { text: 'Сильная морось', day: '09d', night: '09n' },
  56: { text: 'Легкая ледяная морось', day: '13d', night: '13n' },
  57: { text: 'Сильная ледяная морось', day: '13d', night: '13n' },
  61: { text: 'Небольшой дождь', day: '10d', night: '10n' },
  63: { text: 'Дождь', day: '10d', night: '10n' },
  65: { text: 'Сильный дождь', day: '10d', night: '10n' },
  66: { text: 'Легкий ледяной дождь', day: '13d', night: '13n' },
  67: { text: 'Сильный ледяной дождь', day: '13d', night: '13n' },
  71: { text: 'Небольшой снег', day: '13d', night: '13n' },
  73: { text: 'Снег', day: '13d', night: '13n' },
  75: { text: 'Сильный снег', day: '13d', night: '13n' },
  77: { text: 'Снежные зерна', day: '13d', night: '13n' },
  80: { text: 'Ливень', day: '09d', night: '09n' },
  81: { text: 'Ливень', day: '09d', night: '09n' },
  82: { text: 'Сильный ливень', day: '09d', night: '09n' },
  85: { text: 'Снежный заряд', day: '13d', night: '13n' },
  86: { text: 'Сильный снежный заряд', day: '13d', night: '13n' },
  95: { text: 'Гроза', day: '11d', night: '11n' },
  96: { text: 'Гроза с градом', day: '11d', night: '11n' },
  99: { text: 'Сильная гроза с градом', day: '11d', night: '11n' }
};

function extractLatestUserTextMessage(messages) {
  // Достаёт последнее текстовое сообщение пользователя из истории.
  // Search/weather/definition режимы используют именно последний вопрос.
  const source = Array.isArray(messages) ? messages : [];
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const item = source[index];
    const role = `${item?.role || ''}`.trim().toLowerCase();
    if (role !== 'user') continue;
    const text = normalizeMemoryContent(item?.content);
    if (text) return text;
  }
  return '';
}

function isWeatherIntent(text) {
  // Быстрая проверка: похоже ли сообщение на запрос погоды.
  const normalized = `${text || ''}`.trim().toLowerCase();
  if (!normalized) return false;
  return /(погод|температур|ветер|осад|дожд|снег|weather|forecast|humidity|wind)/i.test(normalized);
}

function extractWeatherCity(text) {
  // Очень простой парсер города из фраз типа "погода в Бишкеке".
  // Если город не нашли, ниже используем Бишкек как fallback.
  const normalized = `${text || ''}`.trim();
  if (!normalized) return 'Bishkek';
  if (/(бишкек|bishkek)/i.test(normalized)) return 'Bishkek';
  if (/(москва|moscow)/i.test(normalized)) return 'Moscow';
  if (/(алматы|almaty)/i.test(normalized)) return 'Almaty';
  if (/(ош|osh)/i.test(normalized)) return 'Osh';

  const match =
    normalized.match(/(?:погод[ауы]?|weather)[^a-zа-яё]*(?:в|во|in)\s+([a-zа-яё\-\s]{2,60})/i) ||
    normalized.match(/(?:в|во|in)\s+([a-zа-яё\-\s]{2,60})/i);
  if (!match) return 'Bishkek';

  const city = `${match[1] || ''}`
    .replace(/[?.,!;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!city) return 'Bishkek';
  return city;
}

async function fetchJsonWithTimeout(url, timeoutMs = 9000) {
  // fetch с таймаутом, чтобы weather/wiki запрос не завис навсегда.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function buildLiveWeatherReply(messages) {
  // Специальный fast-path для погоды.
  // Мы сами ходим в Open-Meteo и возвращаем точный ответ с URL иконки.
  const userText = extractLatestUserTextMessage(messages);
  if (!isWeatherIntent(userText)) return null;

  const city = extractWeatherCity(userText);
  const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    city
  )}&count=1&language=ru&format=json`;
  const geo = await fetchJsonWithTimeout(geocodeUrl);
  const place = Array.isArray(geo?.results) ? geo.results[0] : null;
  if (!place || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) {
    return `Не смог найти город для погоды: ${city}. Уточни название города.`;
  }

  const forecastUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day&timezone=auto`;
  const forecast = await fetchJsonWithTimeout(forecastUrl);
  const current = forecast?.current || null;
  if (!current) {
    return 'Сейчас не удалось получить актуальную погоду. Попробуй через минуту.';
  }

  const code = Number(current.weather_code);
  const descriptor = WEATHER_ICON_BY_CODE[code] || { text: 'Погодные условия уточняются', day: '03d', night: '03n' };
  const isDay = Number(current.is_day) === 1;
  const iconCode = isDay ? descriptor.day : descriptor.night;
  const iconUrl = `https://openweathermap.org/img/wn/${iconCode}@2x.png`;
  const baseLocationName = `${place.name || city}`.trim() || city;
  const locationName =
    /^(bishkek|бишкек)$/i.test(baseLocationName)
      ? 'Бишкеке'
      : baseLocationName;
  const location = `${locationName}${place.country ? `, ${place.country}` : ''}`;

  return [
    `Сейчас в ${location}:`,
    `Температура: ${current.temperature_2m}°C (ощущается как ${current.apparent_temperature}°C)`,
    `Влажность: ${current.relative_humidity_2m}%`,
    `Ветер: ${current.wind_speed_10m} м/с`,
    `Состояние: ${descriptor.text}`,
    `Иконка погоды (URL): ${iconUrl}`,
    'Источник: https://open-meteo.com/'
  ].join('\n');
}

function isDefinitionIntent(text) {
  // Определяет запросы "что такое X", "кто такой X" и похожие.
  const normalized = `${text || ''}`.trim().toLowerCase();
  return /^(что такое|что это|кто такой|кто такая|what is|who is)\b/.test(normalized);
}

function extractDefinitionTerm(text) {
  // Достаёт термин из вопроса "что такое сварочный аппарат".
  const normalized = `${text || ''}`.trim();
  if (!normalized) return '';
  const stripped = normalized
    .replace(/^(что такое|что это|кто такой|кто такая|what is|who is)\s*/i, '')
    .replace(/[?!.]+$/g, '')
    .trim();
  return stripped.slice(0, 120);
}

function extractLooseWikiTopic(text) {
  // Fallback: если явного "что такое" нет, пробуем взять короткую тему целиком.
  const input = `${text || ''}`.trim().toLowerCase();
  if (!input) return '';
  if (/сварочн/i.test(input)) return 'сварочный аппарат';

  const stop = new Set([
    'как', 'почему', 'зачем', 'когда', 'где', 'что', 'кто', 'это', 'этот', 'эта', 'эти',
    'работает', 'работают', 'можно', 'нужно', 'ли', 'про', 'для', 'в', 'во', 'на', 'по',
    'the', 'what', 'who', 'how', 'is', 'are', 'a', 'an', 'to', 'in', 'on'
  ]);
  const tokens = input
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stop.has(token));
  if (!tokens.length) return '';

  tokens.sort((left, right) => right.length - left.length);
  return tokens.slice(0, 3).join(' ').slice(0, 120).trim();
}

async function buildDefinitionReply(messages) {
  // Fast-path для определений через Wikipedia REST API.
  // Это даёт источники и картинку быстрее, чем ждать LLM search.
  const userText = extractLatestUserTextMessage(messages);
  const term = isDefinitionIntent(userText) ? extractDefinitionTerm(userText) : extractLooseWikiTopic(userText);
  if (!term) return null;

  const candidates = [
    `https://ru.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term)}`,
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term)}`
  ];

  for (const url of candidates) {
    try {
      const data = await fetchJsonWithTimeout(url, 9000);
      const extract = `${data?.extract || ''}`.trim();
      const pageUrl = `${data?.content_urls?.desktop?.page || ''}`.trim();
      const imageUrl =
        `${data?.originalimage?.source || ''}`.trim() ||
        `${data?.thumbnail?.source || ''}`.trim();

      if (!extract) continue;
      const lines = [
        `Что это: ${term}`,
        extract,
        imageUrl ? `Изображение (URL): ${imageUrl}` : '',
        pageUrl ? `Источник: ${pageUrl}` : ''
      ].filter(Boolean);
      return lines.join('\n');
    } catch (_error) {
      // Try next locale candidate.
    }
  }
  return null;
}

function extractUrlsFromText(text) {
  // Нужна для проверки: дал ли ответ реальные URL источников/картинок.
  const input = `${text || ''}`;
  if (!input.trim()) return [];
  const matches = input.match(/\bhttps?:\/\/[^\s<>"')]+/gi) || [];
  const urls = [];
  for (const match of matches) {
    const normalized = `${match || ''}`.trim().replace(/[),.;!?]+$/g, '');
    if (!normalized || urls.includes(normalized)) continue;
    urls.push(normalized);
  }
  return urls;
}

function hasImageUrlInText(text) {
  // Проверяем, есть ли в ответе прямой URL картинки.
  return extractUrlsFromText(text).some((url) => {
    const value = `${url || ''}`.toLowerCase();
    return (
      /\.(png|jpe?g|webp|gif|bmp|svg)(\?|#|$)/i.test(value) ||
      /openweathermap\.org\/img\/wn\//i.test(value) ||
      /upload\.wikimedia\.org|images\.unsplash\.com|source\.unsplash\.com/i.test(value)
    );
  });
}

function hasSourceUrlInText(text) {
  // Проверяем, есть ли в ответе источник из ожидаемых доменов.
  return extractUrlsFromText(text).some((url) => /wikipedia\.org|open-meteo\.com|wikimedia\.org|unsplash\.com/i.test(url));
}

function appendMissingSearchMetadata(reply, fallbackReply) {
  // Если модель ответила без источников/картинки, добавляем fallback metadata.
  const baseText = `${reply || ''}`.trim();
  const fallbackText = `${fallbackReply || ''}`.trim();
  if (!baseText && !fallbackText) return '';
  if (!fallbackText) return baseText;

  const hasImage = hasImageUrlInText(baseText);
  const hasSource = hasSourceUrlInText(baseText);
  if (hasImage && hasSource) return baseText;

  const fallbackLines = fallbackText.split('\n').map((line) => `${line || ''}`.trim()).filter(Boolean);
  const additional = [];
  for (const line of fallbackLines) {
    const lower = line.toLowerCase();
    if (!hasImage && /(изображение|иконка|image)\s*\(url\)|https?:\/\/.+(png|jpe?g|webp|gif|bmp|svg)/i.test(lower)) {
      additional.push(line);
      continue;
    }
    if (!hasSource && /(источник|source)\s*:\s*https?:\/\//i.test(lower)) {
      additional.push(line);
    }
  }
  if (!additional.length) return baseText || fallbackText;
  return [baseText || fallbackText, ...additional].join('\n');
}

async function enrichSearchReply(text, messages, enableSearch) {
  // После ответа модели проверяем, хватает ли в нём sources/image URL.
  // Если нет, пробуем дополнить через weather/wiki fast-path.
  if (enableSearch !== true) return `${text || ''}`.trim();
  const initial = `${text || ''}`.trim();

  const hasImage = hasImageUrlInText(initial);
  const hasSource = hasSourceUrlInText(initial);
  if (hasImage && hasSource) return initial;

  const fallback = (await buildDefinitionReply(messages)) || (await buildLiveWeatherReply(messages)) || '';
  return appendMissingSearchMetadata(initial, fallback);
}

async function resolveSearchModeServerReply(messages, enableSearch) {
  // До LLM пробуем точные server-side ответы для погоды/определений.
  // Так пользователь быстрее получает факты и источники.
  if (enableSearch !== true) return null;
  try {
    const weatherReply = await buildLiveWeatherReply(messages);
    if (weatherReply) return weatherReply;
    return await buildDefinitionReply(messages);
  } catch (error) {
    logger.warn('Live weather fallback failed', { error: error?.message || 'unknown' });
    return null;
  }
}

function normalizeMemoryRole(role) {
  // Память ждёт роли в верхнем регистре: USER / ASSISTANT / SYSTEM.
  const normalized = `${role || ''}`.trim().toLowerCase();
  if (normalized === 'assistant') return 'ASSISTANT';
  if (normalized === 'system') return 'SYSTEM';
  return 'USER';
}

function normalizeMemoryContent(content) {
  // Для памяти нужен только текст. Медиа-объекты превращаем в компактную JSON-строку.
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        if (typeof item.text === 'string') return item.text;
        if (typeof item.content === 'string') return item.content;
        if (typeof item.transcript === 'string') return item.transcript;
        if (item.type === 'image_url') return '[image]';
        if (item.type === 'video') return '[video]';
        if (item.type === 'audio') return '[audio]';
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text.trim();
    if (typeof content.content === 'string') return content.content.trim();
    if (typeof content.transcript === 'string') return content.transcript.trim();
  }
  return '';
}

function buildMemoryConversationFromPro(messages, assistantReply) {
  // Собирает короткую историю PRO-чата для сжатия в память.
  // Берём последние сообщения, чтобы не грузить scribe огромным контекстом.
  const source = Array.isArray(messages) ? messages : [];
  const normalized = [];

  for (const item of source) {
    const role = `${item?.role || ''}`.trim().toLowerCase();
    if (role === 'system') continue;
    const content = normalizeMemoryContent(item?.content);
    if (!content) continue;
    normalized.push({
      role: normalizeMemoryRole(role || 'user'),
      content
    });
  }

  const reply = `${assistantReply || ''}`.trim();
  if (reply) {
    normalized.push({
      role: 'ASSISTANT',
      content: reply
    });
  }

  if (normalized.length <= 28) return normalized;
  return normalized.slice(-28);
}

function triggerProMemoryCompression(userId, sourceMessages, assistantReply, sourceTag, modelTier = 'standard') {
  // Сжатие памяти запускается фоном и не блокирует ответ пользователю.
  // Если память упадёт, чат всё равно должен успешно ответить.
  const conversation = buildMemoryConversationFromPro(sourceMessages, assistantReply);
  if (!conversation.length) return;

  compressConversationToMemory(userId, conversation, {
    includeSummary: sourceTag !== 'pro_chat_sync',
    source: sourceTag || 'pro_chat',
    modelTier,
    maxMessages: 28
  }).catch((error) => {
    logger.warn('PRO memory compression failed', {
      userId,
      source: sourceTag || 'pro_chat',
      error: error?.message || 'unknown'
    });
  });
}

function sleep(ms) {
  // Небольшая утилита для polling video task status.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimTaskId(value) {
  // taskId приходит из URL. Приводим к безопасной строке.
  return `${value || ''}`.trim();
}

function normalizeDateOrNow(value) {
  // Даты из клиента могут быть пустыми/битым текстом.
  // Если дата плохая — используем текущий момент.
  const parsed = value ? new Date(value) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  return new Date();
}

function normalizeProChatMessage(raw) {
  // Приводит одно сообщение PRO-чата к стабильному формату для базы/клиента.
  // Здесь не сохраняем файлы, только чистим поля и типы.
  if (!raw || typeof raw !== 'object') return null;
  const id = `${raw.id || ''}`.trim().slice(0, 120);
  if (!id) return null;

  const role = `${raw.role || 'user'}`.trim().toLowerCase();
  const safeRole = role === 'assistant' || role === 'system' ? role : 'user';

  const type = `${raw.type || 'text'}`.trim().toLowerCase();
  const safeType = type === 'image' || type === 'video' || type === 'file' ? type : 'text';
  const displayMode = `${raw.displayMode || ''}`.trim().toLowerCase() === 'thinking' ? 'thinking' : 'default';

  const content = `${raw.content || ''}`.trim().slice(0, 8000);
  const imageUrl = safeType === 'image' ? `${raw.imageUrl || ''}`.trim().slice(0, 16_000_000) : null;
  const videoUrl = safeType === 'video' ? `${raw.videoUrl || ''}`.trim().slice(0, 16_000_000) : null;
  const fileUrl = safeType === 'file' ? `${raw.fileUrl || ''}`.trim().slice(0, 16_000_000) : null;
  const fileName = safeType === 'file' ? sanitizeUploadedFileName(raw.fileName || raw.content || 'file') : null;
  const fileMimeType = safeType === 'file' ? `${raw.fileMimeType || raw.mimeType || ''}`.trim().slice(0, 120) : null;
  const parsedFileSize = safeType === 'file' ? Number(raw.fileSize) : NaN;
  const fileSize =
    safeType === 'file' && Number.isFinite(parsedFileSize) ? Math.max(0, Math.min(parsedFileSize, 20_000_000)) : null;
  const parsedDurationSeconds = Number(raw.durationSeconds);
  const durationSeconds =
    displayMode === 'thinking' && Number.isFinite(parsedDurationSeconds)
      ? Math.max(0, Math.min(Math.round(parsedDurationSeconds), 24 * 60 * 60))
      : null;

  const normalizedContent =
    content ||
    (safeType === 'image'
      ? '[image]'
      : safeType === 'video'
        ? '[video]'
        : safeType === 'file'
          ? `[file] ${fileName || 'file'}`
          : '');

  if (!normalizedContent && safeType === 'text' && displayMode !== 'thinking') return null;

  return {
    id,
    role: safeRole,
    type: safeType,
    content: normalizedContent,
    imageUrl: imageUrl || null,
    videoUrl: videoUrl || null,
    fileUrl: fileUrl || null,
    fileName: fileName || null,
    fileMimeType: fileMimeType || null,
    fileSize,
    displayMode,
    durationSeconds,
    createdAt: normalizeDateOrNow(raw.createdAt).toISOString()
  };
}

async function normalizeProChatMessageForSync(raw, { userId, chatId, req } = {}) {
  // Версия normalize для sync: если сообщение содержит dataUrl image/video/file,
  // сохраняем медиа на сервер и заменяем на publicUrl.
  const normalized = normalizeProChatMessage(raw);
  if (!normalized) return null;

  if (normalized.type === 'image' && normalized.imageUrl && normalized.imageUrl.startsWith('data:image/')) {
    const stored = await persistDataUrlForUser({
      userId,
      dataUrl: normalized.imageUrl,
      segments: ['pro', 'chats', `${chatId || 'general'}`, 'images'],
      prefix: normalized.id || 'image',
      req,
      publicBaseUrl: resolvePublicBaseUrl(req, { allowPrivate: true }),
      allowedMimePrefixes: ['image/']
    });
    if (stored?.publicUrl) {
      normalized.imageUrl = stored.publicUrl;
    }
  }

  return normalized;
}

function parseProMessagesJson(value) {
  // В базе messagesJson — строка. Если она битая, возвращаем пустой список.
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeProChatMessage).filter(Boolean).slice(-300);
  } catch (_error) {
    return [];
  }
}

function normalizeProChatRow(row) {
  // Prisma row -> объект чата, который понимает frontend.
  return {
    id: row.clientChatId,
    title: `${row.title || ''}`.trim() || 'New PRO chat',
    modelTier: ['fast', 'standard', 'best'].includes(`${row.modelTier || ''}`) ? row.modelTier : 'standard',
    toolMode: ['chat', 'image_generate', 'image_edit', 'image_analyze', 'video_generate'].includes(
      `${row.toolMode || ''}`
    )
      ? row.toolMode
      : 'chat',
    messages: parseProMessagesJson(row.messagesJson),
    lastMessage: `${row.lastMessage || ''}`.trim(),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    isDeleted: Boolean(row.isDeleted),
    deletedAt: row.deletedAt,
    deletedReason: row.deletedReason || null
  };
}

function serializeProMessages(list) {
  // Перед записью в базу сериализуем messages в JSON-строку.
  const normalized = Array.isArray(list) ? list.map(normalizeProChatMessage).filter(Boolean).slice(-300) : [];
  return JSON.stringify(normalized);
}

async function serializeProMessagesForSync(list, { userId, chatId, req } = {}) {
  // То же, но с сохранением вложенных dataUrl медиа в uploads.
  const source = Array.isArray(list) ? list : [];
  const normalized = [];
  for (const item of source) {
    const next = await normalizeProChatMessageForSync(item, { userId, chatId, req });
    if (next) normalized.push(next);
    if (normalized.length >= 300) break;
  }
  return JSON.stringify(normalized);
}

async function getProAccess(req, res) {
  const globalConfig = req.proConfigGlobal || req.proConfig || {};
  const config = req.proConfig || globalConfig;
  const keyCount = Array.isArray(req.proApiKeys) ? req.proApiKeys.length : 0;
  const limits = resolveRuntimeLimits(config);

  res.json({
    pro: {
      enabled: Boolean(globalConfig.enabled),
      hasAccess: Boolean(req.proAccessAllowed),
      accessMode: globalConfig.accessMode || 'allowlist',
      allowAdmins: Boolean(globalConfig.allowAdmins),
      provider: config.provider || 'qwen-compatible',
      baseUrl: config.baseUrl || '',
      keyConfigured: keyCount > 0,
      keyCount,
      models: {
        text: config.textModels || [],
        vision: config.visionModels || [],
        image: config.imageGenModels || [],
        imageEdit: config.imageEditModels || [],
        video: config.videoGenModels || [],
        voiceAsr: config.voiceAsrModels || [],
        voiceTts: config.voiceTtsModels || [],
        voiceRealtime: config.voiceRealtimeModels || []
      },
      features: {
        imageAnalysisEnabled: Boolean(config.imageAnalysisEnabled),
        imageGenerationEnabled: Boolean(config.imageGenerationEnabled),
        imageEditingEnabled: Boolean(config.imageEditingEnabled),
        videoGenerationEnabled: Boolean(config.videoGenerationEnabled),
        voiceMessagesEnabled: Boolean(config.voiceMessagesEnabled),
        voiceRealtimeEnabled: Boolean(config.voiceRealtimeEnabled),
        fileAnalysisEnabled: Boolean(config.fileAnalysisEnabled)
      },
      limits: {
        maxOutputTokens: clampRuntimeNumber(config.maxOutputTokens, 2048, 128, 8192),
        maxFileAnalyzeBytes: limits.maxFileAnalyzeBytes,
        maxImagePromptChars: limits.maxImagePromptChars,
        maxVideoPromptChars: limits.maxVideoPromptChars,
        maxVoiceAudioBase64Chars: limits.maxVoiceAudioBase64Chars,
        maxVideoDurationSeconds: limits.maxVideoDurationSeconds,
        maxMessagesPerRequest: limits.maxMessagesPerRequest,
        maxImageAnalysesPerDay: resolveDailyLimitFromConfig(config, PRO_DAILY_FEATURE_KEYS.IMAGE_ANALYZE, null),
        maxImageGenerationsPerDay: resolveDailyLimitFromConfig(
          config,
          PRO_DAILY_FEATURE_KEYS.IMAGE_GENERATE,
          null
        ),
        maxImageEditsPerDay: resolveDailyLimitFromConfig(config, PRO_DAILY_FEATURE_KEYS.IMAGE_EDIT, null),
        maxVideoGenerationsPerDay: resolveDailyLimitFromConfig(
          config,
          PRO_DAILY_FEATURE_KEYS.VIDEO_GENERATE,
          null
        ),
        maxVoiceMessagesPerDay: resolveDailyLimitFromConfig(config, PRO_DAILY_FEATURE_KEYS.VOICE_MESSAGE, null),
        maxVoiceRealtimeSessionsPerDay: resolveDailyLimitFromConfig(
          config,
          PRO_DAILY_FEATURE_KEYS.VOICE_REALTIME,
          null
        ),
        maxFileAnalysesPerDay: resolveDailyLimitFromConfig(config, PRO_DAILY_FEATURE_KEYS.FILE_ANALYZE, null)
      },
      userOverride: config.userOverride || null
    }
  });
}

async function listProChats(req, res) {
  const rows = await prisma.proChat.findMany({
    where: {
      userId: req.user.id,
      isDeleted: false
    },
    orderBy: [{ updatedAt: 'desc' }]
  });

  res.json({
    chats: rows.map(normalizeProChatRow)
  });
}

async function syncProChats(req, res) {
  const payload = proChatSyncSchema.parse(req.body || {});
  const chats = Array.isArray(payload.chats) ? payload.chats : [];
  const isLiveSync = payload.live === true;
  const isPartialSync = isLiveSync || payload.partial === true;
  const normalizedChats = [];
  for (const chat of chats) {
    const id = `${chat.id || ''}`.trim().slice(0, 120);
    const title = `${chat.title || ''}`.trim().slice(0, 240) || 'New PRO chat';
    const modelTier = ['fast', 'standard', 'best'].includes(`${chat.modelTier || ''}`) ? chat.modelTier : 'standard';
    const toolMode = ['chat', 'image_generate', 'image_edit', 'image_analyze', 'video_generate'].includes(
      `${chat.toolMode || ''}`
    )
      ? chat.toolMode
      : 'chat';
    const messagesJson = await serializeProMessagesForSync(chat.messages || [], {
      userId: req.user.id,
      chatId: id,
      req
    });
    const createdAt = normalizeDateOrNow(chat.createdAt);
    const updatedAt = normalizeDateOrNow(chat.updatedAt);
    const lastMessage = `${chat.lastMessage || ''}`.trim().slice(0, 4000);

    normalizedChats.push({
      id,
      title,
      modelTier,
      toolMode,
      messagesJson,
      createdAt,
      updatedAt,
      lastMessage
    });
  }

  const clientIds = normalizedChats.map((item) => item.id);
  const now = new Date();
  const userId = req.user.id;

  if (isLiveSync) {
    const responseChats = normalizedChats
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((item) =>
        normalizeProChatRow({
          userId,
          clientChatId: item.id,
          title: item.title,
          modelTier: item.modelTier,
          toolMode: item.toolMode,
          messagesJson: item.messagesJson,
          lastMessage: item.lastMessage,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          isDeleted: false,
          deletedAt: null,
          deletedReason: null
        })
      );
    const io = getIo();
    if (io) {
      io.to(userRoom(userId)).emit('pro:chats:sync', {
        userId,
        live: true,
        chats: responseChats
      });
    }
    res.json({ chats: responseChats });
    return;
  }

  const existingRows = clientIds.length
    ? await prisma.proChat.findMany({
        where: {
          userId,
          clientChatId: { in: clientIds }
        },
        select: {
          clientChatId: true,
          updatedAt: true
        }
      })
    : [];
  const existingByClientId = new Map(existingRows.map((row) => [row.clientChatId, row]));
  const writableChats = normalizedChats.filter((item) => {
    const existing = existingByClientId.get(item.id);
    return !existing || item.updatedAt.getTime() + 80 >= existing.updatedAt.getTime();
  });
  const writableClientIds = writableChats.map((item) => item.id);

  const writeOneChat = async (client, item) => {
    const uniqueWhere = {
      userId_clientChatId: {
        userId,
        clientChatId: item.id
      }
    };
    const existing = existingByClientId.get(item.id);

    if (!existing) {
      await client.proChat.create({
        data: {
          userId,
          clientChatId: item.id,
          title: item.title,
          modelTier: item.modelTier,
          toolMode: item.toolMode,
          messagesJson: item.messagesJson,
          lastMessage: item.lastMessage,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt
        }
      });
      return;
    }

    await client.proChat.update({
      where: {
        userId_clientChatId: uniqueWhere.userId_clientChatId
      },
      data: {
        title: item.title,
        modelTier: item.modelTier,
        toolMode: item.toolMode,
        messagesJson: item.messagesJson,
        lastMessage: item.lastMessage,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        isDeleted: false,
        deletedAt: null,
        deletedReason: null
      }
    });
  };

  if (isPartialSync) {
    for (const item of writableChats) {
      await writeOneChat(prisma, item);
    }
  } else {
    await prisma.$transaction(
      async (tx) => {
        if (writableClientIds.length) {
          await tx.proChat.updateMany({
            where: {
              userId,
              clientChatId: { in: writableClientIds }
            },
            data: {
              isDeleted: false,
              deletedAt: null,
              deletedReason: null
            }
          });
        }

        for (const item of writableChats) {
          await writeOneChat(tx, item);
        }

        await tx.proChat.updateMany({
          where: {
            userId,
            isDeleted: false,
            ...(clientIds.length ? { clientChatId: { notIn: clientIds } } : {})
          },
          data: {
            isDeleted: true,
            deletedAt: now,
            deletedReason: 'deleted_by_user'
          }
        });
      },
      { timeout: 20000 }
    );
  }

  const rows = await prisma.proChat.findMany({
    where: {
      userId,
      isDeleted: false,
      ...(isPartialSync && clientIds.length ? { clientChatId: { in: clientIds } } : {})
    },
    orderBy: [{ updatedAt: 'desc' }]
  });

  const responseChats = rows.map(normalizeProChatRow);
  const io = getIo();
  if (io) {
    io.to(userRoom(userId)).emit('pro:chats:sync', {
      userId,
      live: false,
      partial: isPartialSync,
      chats: responseChats
    });
  }

  if (!isPartialSync) {
    const chatsForMemory = [...normalizedChats]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 3);
    for (const chat of chatsForMemory) {
      const parsedMessages = parseProMessagesJson(chat.messagesJson);
      triggerProMemoryCompression(userId, parsedMessages, '', 'pro_chat_sync', chat.modelTier || 'standard');
    }
  }

  res.json({
    chats: responseChats
  });
}

async function createProChatCompletion(req, res) {
  const payload = chatSchema.parse(req.body || {});
  const proConfig = req.proConfig;
  const limits = resolveRuntimeLimits(proConfig);
  const personalizedSystemPrompt = buildPersonalizedSystemPrompt(proConfig.systemPrompt, req.user);
  const messages = normalizeMessages(payload.messages, payload.prompt, personalizedSystemPrompt);

  if (!messages.length) {
    throw new AppError(400, 'No valid messages for chat completion');
  }
  if (messages.length > limits.maxMessagesPerRequest) {
    throw new AppError(413, `Too many messages in request. Max is ${limits.maxMessagesPerRequest}.`);
  }

  const serverSearchReply = await resolveSearchModeServerReply(messages, payload.enableSearch === true);
  if (serverSearchReply) {
    triggerProMemoryCompression(
      req.user.id,
      messages,
      serverSearchReply,
      'pro_chat_completion_search_fallback',
      payload.modelTier || 'standard'
    );
    res.json({
      reply: serverSearchReply,
      modelUsed: 'server-weather-live',
      keyUsed: null,
      usage: null,
      attempts: []
    });
    return;
  }

  let modelCandidates =
    payload.enableSearch === true
      ? resolveSearchTextModelCandidates(payload.modelTier, proConfig.textModels)
      : resolveTextModelCandidates(payload.model, payload.modelTier, proConfig.textModels);
  if (payload.enableThinking === true) {
    modelCandidates = prioritizeModelCandidate(modelCandidates, THINKING_PRIMARY_MODEL);
  }
  if (!modelCandidates.length) {
    throw new AppError(400, 'No text models are configured for PRO mode');
  }

  const messagesForModel = applySearchModeGuidanceEnhanced(messages, payload.enableSearch === true);

  const result = await runChatWithFallback({
    apiKey: req.proApiKey,
    apiKeys: req.proApiKeys,
    baseUrl: proConfig.baseUrl,
    modelCandidates,
    messages: messagesForModel,
    enableSearch: payload.enableSearch === true,
    enableThinking: payload.enableThinking === true,
    temperature:
      typeof payload.temperature === 'number' ? payload.temperature : Number(proConfig.temperature),
    maxTokens: resolveResponseMaxTokens(proConfig, payload.maxTokens)
  });
  const finalReply = await enrichSearchReply(result.text, messages, payload.enableSearch === true);

  triggerProMemoryCompression(req.user.id, messages, finalReply, 'pro_chat_completion', payload.modelTier || 'standard');

  res.json({
    reply: finalReply,
    modelUsed: result.modelUsed,
    keyUsed: result.keyUsed || null,
    usage: result.usage || null,
    attempts: result.attempts
  });
}

function streamWrite(res, payload) {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (typeof res.flush === 'function') {
      res.flush();
    }
  } catch (_error) {
    // Client may already be disconnected.
  }
}

async function createProChatCompletionStream(req, res) {
  const payload = chatSchema.parse(req.body || {});
  const proConfig = req.proConfig;
  const limits = resolveRuntimeLimits(proConfig);
  const personalizedSystemPrompt = buildPersonalizedSystemPrompt(proConfig.systemPrompt, req.user);
  const messages = normalizeMessages(payload.messages, payload.prompt, personalizedSystemPrompt);

  if (!messages.length) {
    throw new AppError(400, 'No valid messages for chat completion');
  }
  if (messages.length > limits.maxMessagesPerRequest) {
    throw new AppError(413, `Too many messages in request. Max is ${limits.maxMessagesPerRequest}.`);
  }

  let modelCandidates =
    payload.enableSearch === true
      ? resolveSearchTextModelCandidates(payload.modelTier, proConfig.textModels)
      : resolveTextModelCandidates(payload.model, payload.modelTier, proConfig.textModels);
  if (payload.enableThinking === true) {
    modelCandidates = prioritizeModelCandidate(modelCandidates, THINKING_PRIMARY_MODEL);
  }
  if (!modelCandidates.length) {
    throw new AppError(400, 'No text models are configured for PRO mode');
  }
  const messagesForModel = applySearchModeGuidanceEnhanced(messages, payload.enableSearch === true);

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (req?.socket && typeof req.socket.setNoDelay === 'function') {
    req.socket.setNoDelay(true);
  }
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  // Kick off SSE stream immediately to reduce proxy buffering.
  streamWrite(res, { type: 'ready' });

  let disconnected = false;
  req.on('close', () => {
    disconnected = true;
  });

  let aggregatedText = '';
  let aggregatedReasoning = '';

  try {
    const serverSearchReply = await resolveSearchModeServerReply(messages, payload.enableSearch === true);
    if (serverSearchReply) {
      aggregatedText = serverSearchReply;
      streamWrite(res, { type: 'token', delta: serverSearchReply });
      triggerProMemoryCompression(
        req.user.id,
        messages,
        serverSearchReply,
        'pro_chat_stream_search_fallback',
        payload.modelTier || 'standard'
      );
      streamWrite(res, {
        type: 'done',
        reply: serverSearchReply,
        modelUsed: 'server-weather-live',
        keyUsed: null,
        usage: null,
        attempts: []
      });
      return;
    }

    const result = await runChatStreamWithFallback({
      apiKey: req.proApiKey,
      apiKeys: req.proApiKeys,
      baseUrl: proConfig.baseUrl,
      modelCandidates,
      messages: messagesForModel,
      enableSearch: payload.enableSearch === true,
      enableThinking: payload.enableThinking === true,
      temperature: typeof payload.temperature === 'number' ? payload.temperature : Number(proConfig.temperature),
      maxTokens: resolveResponseMaxTokens(proConfig, payload.maxTokens),
      onReasoning: (token) => {
        if (disconnected) return;
        const delta = `${token || ''}`;
        if (!delta) return;
        aggregatedReasoning += delta;
        streamWrite(res, { type: 'reasoning', delta });
      },
      onToken: (token) => {
        if (disconnected) return;
        const delta = `${token || ''}`;
        if (!delta) return;
        aggregatedText += delta;
        streamWrite(res, { type: 'token', delta });
      }
    });

    const finalReplyRaw = `${result.text || aggregatedText || ''}`.trim();
    const finalReply = await enrichSearchReply(finalReplyRaw, messages, payload.enableSearch === true);
    triggerProMemoryCompression(req.user.id, messages, finalReply, 'pro_chat_stream', payload.modelTier || 'standard');

    streamWrite(res, {
      type: 'done',
      reply: finalReply,
      reasoning: `${result.reasoning || aggregatedReasoning || ''}`.trim(),
      modelUsed: result.modelUsed,
      keyUsed: result.keyUsed || null,
      usage: result.usage || null,
      attempts: result.attempts || []
    });
  } catch (error) {
    if (!disconnected) {
      streamWrite(res, {
        type: 'error',
        message: error?.message || 'PRO stream failed',
        status: error?.status || 502,
        details: error?.details || null
      });
    }
  } finally {
    if (!disconnected) {
      res.end();
    }
  }
}

function buildFileAnalysisUserPrompt({ prompt, fileName, mimeType, size, textContent }) {
  const requestPrompt = `${prompt || 'Проанализируй содержимое файла и дай практичные выводы.'}`.trim();
  const sizeKb = Number(size) > 0 ? `${Math.round(Number(size) / 1024)} KB` : 'unknown';
  return [
    requestPrompt,
    '',
    `File name: ${fileName || 'file'}`,
    `MIME type: ${mimeType || 'application/octet-stream'}`,
    `Approx size: ${sizeKb}`,
    '',
    'File text content starts below:',
    textContent || ''
  ].join('\n');
}

async function createProFileAnalysis(req, res) {
  const payload = fileAnalyzeSchema.parse(req.body || {});
  const proConfig = req.proConfig;
  const limits = resolveRuntimeLimits(proConfig);

  if (!proConfig.fileAnalysisEnabled) {
    throw new AppError(423, 'File analysis is disabled in PRO mode', {
      type: 'PRO_FEATURE_DISABLED',
      featureKey: 'fileAnalysisEnabled',
      code: 'PRO_FEATURE_DISABLED_FILE_ANALYZE'
    });
  }

  const fileName = sanitizeUploadedFileName(payload.fileName || 'file');
  const mimeType = normalizeUploadedFileMime(payload.mimeType, fileName);
  const modelCandidates = resolveTextModelCandidates(payload.model, payload.modelTier, proConfig.textModels);
  if (!modelCandidates.length) {
    throw new AppError(400, 'No text models are configured for PRO mode');
  }

  if (!supportsFileTextAnalysis({ mimeType, fileName })) {
    throw new AppError(
      415,
      'Неподдерживаемый формат файла для ИИ-анализа. Используйте текстовые файлы: txt, md, csv, json, xml, html, yaml, code.'
    );
  }

  let binary;
  try {
    binary = Buffer.from(`${payload.fileBase64 || ''}`.trim(), 'base64');
  } catch (_error) {
    binary = Buffer.alloc(0);
  }

  if (!binary.length) {
    throw new AppError(400, 'Empty file payload');
  }
  if (binary.length > limits.maxFileAnalyzeBytes) {
    throw new AppError(
      413,
      `File is too large. Max size is ${Math.round(limits.maxFileAnalyzeBytes / (1024 * 1024))} MB.`
    );
  }

  const extractedText = extractTextForFileAnalysis({
    buffer: binary,
    mimeType,
    fileName
  });
  if (!extractedText) {
    throw new AppError(422, 'Could not extract readable text from file');
  }

  const stored = await persistBufferForUser({
    userId: req.user.id,
    segments: ['pro', 'chats', `${payload.chatId || 'general'}`, 'files'],
    prefix: 'file',
    mimeType,
    buffer: binary,
    req,
    publicBaseUrl: resolvePublicBaseUrl(req, { allowPrivate: true })
  });

  const userPrompt = buildFileAnalysisUserPrompt({
    prompt: payload.prompt,
    fileName,
    mimeType,
    size: binary.length,
    textContent: extractedText
  });

  await consumeDailyQuota(req, proConfig, PRO_DAILY_FEATURE_KEYS.FILE_ANALYZE);

  const result = await runChatWithFallback({
    apiKey: req.proApiKey,
    apiKeys: req.proApiKeys,
    baseUrl: proConfig.baseUrl,
    modelCandidates,
    messages: [
      { role: 'system', content: buildFileAnalysisSystemPrompt(proConfig.systemPrompt, req.user) },
      { role: 'user', content: userPrompt }
    ],
    temperature:
      typeof payload.temperature === 'number' ? payload.temperature : Number(proConfig.temperature),
    maxTokens: resolveResponseMaxTokens(proConfig, payload.maxTokens)
  });

  res.json({
    analysis: result.text,
    file: {
      name: fileName,
      mimeType,
      size: binary.length,
      url: stored?.publicUrl || null
    },
    modelUsed: result.modelUsed,
    keyUsed: result.keyUsed || null,
    usage: result.usage || null,
    attempts: result.attempts || []
  });
}

async function analyzeImage(req, res) {
  const payload = imageAnalyzeSchema.parse(req.body || {});
  const proConfig = req.proConfig;
  const limits = resolveRuntimeLimits(proConfig);

  if (!proConfig.imageAnalysisEnabled) {
    throw new AppError(423, 'Image analysis is disabled in PRO mode', {
      type: 'PRO_FEATURE_DISABLED',
      featureKey: 'imageAnalysisEnabled',
      code: 'PRO_FEATURE_DISABLED_IMAGE_ANALYZE'
    });
  }

  const modelCandidates = uniqueModelCandidates(payload.model, proConfig.visionModels);
  if (!modelCandidates.length) {
    throw new AppError(400, 'No vision models are configured for PRO mode');
  }

  const prompt = `${payload.prompt || 'Analyze this image in detail.'}`.trim();
  if (prompt.length > limits.maxImagePromptChars) {
    throw new AppError(413, `Prompt is too long. Max chars: ${limits.maxImagePromptChars}.`);
  }
  const resolvedImageUrl = await resolveImageUrlForProvider({
    userId: req.user.id,
    imageUrl: payload.imageUrl,
    req,
    chatId: 'analysis',
    purpose: 'analyze'
  });
  const messages = [
    { role: 'system', content: buildImageAnalysisSystemPrompt(proConfig.systemPrompt, req.user) },
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: resolvedImageUrl } }
      ]
    }
  ];

  await consumeDailyQuota(req, proConfig, PRO_DAILY_FEATURE_KEYS.IMAGE_ANALYZE);

  const result = await runChatWithFallback({
    apiKey: req.proApiKey,
    apiKeys: req.proApiKeys,
    baseUrl: proConfig.baseUrl,
    modelCandidates,
    messages,
    temperature:
      typeof payload.temperature === 'number' ? payload.temperature : Number(proConfig.temperature),
    maxTokens: resolveResponseMaxTokens(proConfig, payload.maxTokens)
  });

  res.json({
    analysis: result.text,
    modelUsed: result.modelUsed,
    keyUsed: result.keyUsed || null,
    usage: result.usage || null,
    attempts: result.attempts
  });
}

async function generateImage(req, res) {
  const payload = imageGenerateSchema.parse(req.body || {});
  const proConfig = req.proConfig;
  const limits = resolveRuntimeLimits(proConfig);

  if (!proConfig.imageGenerationEnabled) {
    throw new AppError(423, 'Image generation is disabled in PRO mode', {
      type: 'PRO_FEATURE_DISABLED',
      featureKey: 'imageGenerationEnabled',
      code: 'PRO_FEATURE_DISABLED_IMAGE_GENERATE'
    });
  }
  if (`${payload.prompt || ''}`.trim().length > limits.maxImagePromptChars) {
    throw new AppError(413, `Prompt is too long. Max chars: ${limits.maxImagePromptChars}.`);
  }

  const modelCandidates = uniqueModelCandidates(payload.model, proConfig.imageGenModels);
  if (!modelCandidates.length) {
    throw new AppError(400, 'No image generation models are configured for PRO mode');
  }

  await consumeDailyQuota(req, proConfig, PRO_DAILY_FEATURE_KEYS.IMAGE_GENERATE);

  const result = await runImageGenerationWithFallback({
    apiKey: req.proApiKey,
    apiKeys: req.proApiKeys,
    baseUrl: proConfig.baseUrl,
    modelCandidates,
    prompt: payload.prompt.trim(),
    size: payload.size || '1024x1024'
  });

  let persistedImage = null;
  if (`${result?.b64Json || ''}`.trim()) {
    persistedImage = await persistGeneratedImageFromBase64({
      userId: req.user.id,
      base64: result.b64Json,
      req,
      purpose: 'generated',
      chatId: payload.chatId
    });
  }
  if (!persistedImage && `${result?.imageUrl || ''}`.trim()) {
    persistedImage = await persistGeneratedImageFromRemoteUrl({
      userId: req.user.id,
      imageUrl: result.imageUrl,
      req,
      purpose: 'generated',
      chatId: payload.chatId
    });
  }

  const finalImageUrl = `${persistedImage?.publicUrl || ''}`.trim() || `${result?.imageUrl || ''}`.trim();

  res.json({
    imageUrl: finalImageUrl || null,
    b64Json: finalImageUrl ? null : result.b64Json,
    modelUsed: result.modelUsed,
    keyUsed: result.keyUsed || null,
    attempts: result.attempts
  });
}

async function editImage(req, res) {
  const payload = imageEditSchema.parse(req.body || {});
  const proConfig = req.proConfig;
  const limits = resolveRuntimeLimits(proConfig);

  if (!proConfig.imageEditingEnabled) {
    throw new AppError(423, 'Image editing is disabled in PRO mode', {
      type: 'PRO_FEATURE_DISABLED',
      featureKey: 'imageEditingEnabled',
      code: 'PRO_FEATURE_DISABLED_IMAGE_EDIT'
    });
  }
  if (`${payload.prompt || ''}`.trim().length > limits.maxImagePromptChars) {
    throw new AppError(413, `Prompt is too long. Max chars: ${limits.maxImagePromptChars}.`);
  }

  const modelCandidates = uniqueModelCandidates(payload.model, proConfig.imageEditModels || []);
  if (!modelCandidates.length) {
    throw new AppError(400, 'No image editing models are configured for PRO mode');
  }

  const resolvedImageUrl = await resolveImageUrlForProvider({
    userId: req.user.id,
    imageUrl: payload.imageUrl,
    req,
    chatId: 'edit',
    purpose: 'edit-source'
  });

  await consumeDailyQuota(req, proConfig, PRO_DAILY_FEATURE_KEYS.IMAGE_EDIT);

  const result = await runImageEditWithFallback({
    apiKey: req.proApiKey,
    apiKeys: req.proApiKeys,
    baseUrl: proConfig.baseUrl,
    modelCandidates,
    prompt: `${payload.prompt || 'Edit this image according to the request while preserving key details.'}`.trim(),
    imageUrl: resolvedImageUrl,
    size: payload.size || '1024x1024'
  });

  let persistedImage = null;
  if (`${result?.b64Json || ''}`.trim()) {
    persistedImage = await persistGeneratedImageFromBase64({
      userId: req.user.id,
      base64: result.b64Json,
      req,
      purpose: 'edited',
      chatId: payload.chatId
    });
  }
  if (!persistedImage && `${result?.imageUrl || ''}`.trim()) {
    persistedImage = await persistGeneratedImageFromRemoteUrl({
      userId: req.user.id,
      imageUrl: result.imageUrl,
      req,
      purpose: 'edited',
      chatId: payload.chatId
    });
  }

  const finalImageUrl = `${persistedImage?.publicUrl || ''}`.trim() || `${result?.imageUrl || ''}`.trim();

  res.json({
    imageUrl: finalImageUrl || null,
    b64Json: finalImageUrl ? null : result.b64Json,
    modelUsed: result.modelUsed,
    keyUsed: result.keyUsed || null,
    endpoint: result.endpoint || null,
    attempts: result.attempts
  });
}

async function generateVideo(req, res) {
  const payload = videoGenerateSchema.parse(req.body || {});
  const proConfig = req.proConfig;
  const limits = resolveRuntimeLimits(proConfig);

  if (!proConfig.videoGenerationEnabled) {
    throw new AppError(423, 'Video generation is disabled in PRO mode', {
      type: 'PRO_FEATURE_DISABLED',
      featureKey: 'videoGenerationEnabled',
      code: 'PRO_FEATURE_DISABLED_VIDEO_GENERATE'
    });
  }
  if (`${payload.prompt || ''}`.trim().length > limits.maxVideoPromptChars) {
    throw new AppError(413, `Prompt is too long. Max chars: ${limits.maxVideoPromptChars}.`);
  }
  if (
    Number.isFinite(Number(payload.durationSeconds)) &&
    Number(payload.durationSeconds) > limits.maxVideoDurationSeconds
  ) {
    throw new AppError(
      413,
      `Video duration exceeds limit. Max duration is ${limits.maxVideoDurationSeconds} seconds.`
    );
  }

  const modelCandidates = uniqueModelCandidates(payload.model, proConfig.videoGenModels || []);
  if (!modelCandidates.length) {
    throw new AppError(400, 'No video generation models are configured for PRO mode');
  }

  const resolvedSourceImageUrl = await resolveImageUrlForProvider({
    userId: req.user.id,
    imageUrl: payload.imageUrl || '',
    req,
    chatId: 'video',
    purpose: 'video-source'
  });

  await consumeDailyQuota(req, proConfig, PRO_DAILY_FEATURE_KEYS.VIDEO_GENERATE);

  const generation = await runVideoGenerationWithFallback({
    apiKey: req.proApiKey,
    apiKeys: req.proApiKeys,
    baseUrl: proConfig.baseUrl,
    modelCandidates,
    prompt: payload.prompt.trim(),
    imageUrl: resolvedSourceImageUrl || undefined,
    size: payload.size || '1920*1080',
    durationSeconds: payload.durationSeconds,
    aspectRatio: payload.aspectRatio
  });

  let finalStatus = generation.status || 'processing';
  let finalVideoUrl = generation.videoUrl || null;
  let finalErrorMessage = generation.errorMessage || null;
  let pollAttempts = [];
  const normalizedChatId = `${payload.chatId || ''}`.trim();

  const waitForSeconds = Number.isFinite(Number(payload.waitForSeconds))
    ? Math.max(0, Math.min(Number(payload.waitForSeconds), 120))
    : 0;

  if (!finalVideoUrl && generation.taskId && waitForSeconds > 0) {
    const deadline = Date.now() + waitForSeconds * 1000;
    while (Date.now() < deadline) {
      await sleep(2200);
      try {
        const statusResult = await runVideoTaskStatusWithFallback({
          apiKey: req.proApiKey,
          apiKeys: req.proApiKeys,
          baseUrl: proConfig.baseUrl,
          taskId: generation.taskId
        });

        pollAttempts = statusResult.attempts || [];
        finalStatus = statusResult.status || finalStatus;
        finalVideoUrl = statusResult.videoUrl || finalVideoUrl;
        finalErrorMessage = statusResult.errorMessage || finalErrorMessage;

        if (finalVideoUrl || finalStatus === 'succeeded' || finalStatus === 'failed') {
          break;
        }
      } catch (_error) {
        break;
      }
    }
  }

  if (`${finalVideoUrl || ''}`.trim()) {
    const persistedVideo = await persistGeneratedVideoFromRemoteUrl({
      userId: req.user.id,
      videoUrl: finalVideoUrl,
      req,
      chatId: normalizedChatId || undefined,
      taskId: generation.taskId || undefined,
      purpose: 'generated'
    });
    const persistedUrl = `${persistedVideo?.publicUrl || ''}`.trim();
    if (persistedUrl) {
      finalVideoUrl = persistedUrl;
    }
  }

  res.json({
    taskId: generation.taskId || null,
    status: finalStatus,
    videoUrl: finalVideoUrl,
    errorMessage: finalErrorMessage,
    modelUsed: generation.modelUsed,
    keyUsed: generation.keyUsed || null,
    endpoint: generation.endpoint || null,
    attempts: generation.attempts,
    pollAttempts
  });
}

async function getVideoTaskStatus(req, res) {
  const taskId = trimTaskId(req.params?.taskId);
  if (!taskId) {
    throw new AppError(400, 'taskId is required');
  }
  const normalizedChatId = `${req.query?.chatId || ''}`.trim();

  const proConfig = req.proConfig;
  if (!proConfig.videoGenerationEnabled) {
    throw new AppError(423, 'Video generation is disabled in PRO mode', {
      type: 'PRO_FEATURE_DISABLED',
      featureKey: 'videoGenerationEnabled',
      code: 'PRO_FEATURE_DISABLED_VIDEO_GENERATE'
    });
  }
  const result = await runVideoTaskStatusWithFallback({
    apiKey: req.proApiKey,
    apiKeys: req.proApiKeys,
    baseUrl: proConfig.baseUrl,
    taskId
  });
  let finalVideoUrl = `${result.videoUrl || ''}`.trim() || null;
  if (finalVideoUrl) {
    const persistedVideo = await persistGeneratedVideoFromRemoteUrl({
      userId: req.user.id,
      videoUrl: finalVideoUrl,
      req,
      chatId: normalizedChatId || undefined,
      taskId,
      purpose: 'generated'
    });
    const persistedUrl = `${persistedVideo?.publicUrl || ''}`.trim();
    if (persistedUrl) {
      finalVideoUrl = persistedUrl;
    }
  }

  res.json({
    taskId: result.taskId || taskId,
    status: result.status || 'unknown',
    videoUrl: finalVideoUrl,
    errorMessage: result.errorMessage || null,
    keyUsed: result.keyUsed || null,
    endpoint: result.endpoint || null,
    attempts: result.attempts || []
  });
}

async function getVoiceRealtimeConfig(req, res) {
  const proConfig = req.proConfig;
  const primaryModel = Array.isArray(proConfig.voiceRealtimeModels)
    ? proConfig.voiceRealtimeModels[0] || null
    : null;

  res.json({
    enabled: Boolean(proConfig.voiceRealtimeEnabled),
    model: primaryModel,
    models: proConfig.voiceRealtimeModels || [],
    voiceMessagesEnabled: Boolean(proConfig.voiceMessagesEnabled),
    asrModels: proConfig.voiceAsrModels || [],
    ttsModels: proConfig.voiceTtsModels || [],
    provider: proConfig.provider || 'qwen-compatible',
    baseUrl: proConfig.baseUrl || '',
    keyConfigured: Array.isArray(req.proApiKeys) ? req.proApiKeys.length > 0 : false,
    keyCount: Array.isArray(req.proApiKeys) ? req.proApiKeys.length : 0
  });
}

async function getVoiceRealtimeWebviewPage(req, res) {
  const proConfig = req.proConfig;
  if (!proConfig.voiceRealtimeEnabled) {
    throw new AppError(423, 'Realtime voice is disabled in PRO mode', {
      type: 'PRO_FEATURE_DISABLED',
      featureKey: 'voiceRealtimeEnabled',
      code: 'PRO_FEATURE_DISABLED_VOICE_REALTIME'
    });
  }

  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    throw new AppError(401, 'Authorization token is required');
  }

  const primaryModel = Array.isArray(proConfig.voiceRealtimeModels)
    ? `${proConfig.voiceRealtimeModels[0] || ''}`.trim()
    : '';
  const socketOrigin = (resolvePublicBaseUrl(req) || `${req.protocol}://${req.get('host') || ''}`).replace(/\/+$/, '');
  const chatId = `${req.query?.chatId || ''}`.trim();
  const title = `${req.query?.title || 'Live Voice PRO'}`.trim();
  const language = `${req.query?.lang || 'ru'}`.trim().slice(0, 16);

  const bootstrap = toInlineJson({
    token,
    socketOrigin,
    model: primaryModel,
    chatId: chatId || null,
    title: title || 'Live Voice PRO',
    language: language || 'ru'
  });

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <title>Live Voice PRO</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #16042a;
      --card: #20103b;
      --border: #4b2f7a;
      --text: #f7f5ff;
      --muted: #c7bde0;
      --accent: #38c9e8;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body { height: 100%; margin: 0; background: radial-gradient(circle at 15% 12%, #55318f 0%, #220741 48%, #140329 100%); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { display: flex; align-items: stretch; justify-content: center; }
    .shell {
      width: 100%;
      max-width: 780px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding: 14px 14px 18px;
    }
    .card {
      border: 1px solid var(--border);
      border-radius: 16px;
      background: color-mix(in srgb, var(--card) 88%, #0b0218 12%);
      padding: 14px;
    }
    .title {
      font-size: 16px;
      font-weight: 800;
      margin: 0 0 8px;
    }
    .status {
      color: var(--muted);
      font-size: 13px;
      min-height: 20px;
      line-height: 1.35;
    }
    .error {
      color: var(--danger);
      font-size: 12px;
      min-height: 18px;
      margin-top: 8px;
      line-height: 1.35;
    }
    .actions {
      margin-top: auto;
      display: grid;
      gap: 10px;
    }
    .btn {
      border: 1px solid transparent;
      border-radius: 14px;
      min-height: 52px;
      padding: 12px 14px;
      font-size: 15px;
      font-weight: 800;
      color: white;
      background: var(--accent);
      cursor: pointer;
    }
    .btn[disabled] { opacity: 0.6; cursor: default; }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.1);
      border-color: var(--border);
      color: var(--text);
    }
    .btn-danger {
      background: var(--danger);
      color: #fff;
    }
    .mic-state {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="card">
      <h1 class="title" id="title"></h1>
      <div class="status" id="status">Preparing voice session...</div>
      <div class="mic-state" id="micState"></div>
      <div class="error" id="error"></div>
    </div>

    <div class="actions">
      <button class="btn" id="micBtn" disabled>Start voice</button>
      <button class="btn btn-secondary" id="finishBtn">Finish</button>
    </div>
  </div>

  <script src="${socketOrigin}/socket.io/socket.io.js"></script>
  <script>
    (function () {
      const boot = ${bootstrap};
      const state = {
        socket: null,
        active: false,
        starting: false,
        micMuted: false,
        serverStatus: 'idle',
        stream: null,
        inputContext: null,
        processor: null,
        playbackContext: null,
        nextPlayTime: 0
      };

      const titleEl = document.getElementById('title');
      const statusEl = document.getElementById('status');
      const errorEl = document.getElementById('error');
      const micStateEl = document.getElementById('micState');
      const micBtn = document.getElementById('micBtn');
      const finishBtn = document.getElementById('finishBtn');

      titleEl.textContent = boot.title || 'Live Voice PRO';

      function post(type, payload) {
        try {
          const message = JSON.stringify(Object.assign({ type: type }, payload || {}));
          if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
            window.ReactNativeWebView.postMessage(message);
          }
        } catch (_error) {}
      }

      function setStatus(text) {
        const next = (text || '').trim();
        statusEl.textContent = next || 'Ready';
        post('status', { message: next || 'Ready' });
      }

      function setError(text) {
        const next = (text || '').trim();
        errorEl.textContent = next;
        if (next) post('error', { message: next });
      }

      function updateButtons() {
        if (state.starting) {
          micBtn.disabled = true;
          micBtn.textContent = 'Connecting...';
          micBtn.className = 'btn';
          micStateEl.textContent = '';
          return;
        }
        micBtn.disabled = false;
        if (!state.active) {
          micBtn.textContent = 'Start voice';
          micBtn.className = 'btn';
          micStateEl.textContent = '';
          return;
        }
        if (state.micMuted) {
          micBtn.textContent = 'Turn mic on';
          micBtn.className = 'btn';
          micStateEl.textContent = 'Mic is muted';
        } else {
          micBtn.textContent = 'Turn mic off';
          micBtn.className = 'btn btn-danger';
          micStateEl.textContent = 'Listening...';
        }
      }

      function float32ToPcm16Base64(input) {
        const pcm = new Int16Array(input.length);
        for (let i = 0; i < input.length; i += 1) {
          const sample = Math.max(-1, Math.min(1, input[i]));
          pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        const bytes = new Uint8Array(pcm.buffer);
        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize));
        }
        return btoa(binary);
      }

      function pcm16Base64ToFloat32(audioBase64) {
        const raw = atob((audioBase64 || '').trim());
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
        const sampleCount = Math.floor(bytes.byteLength / 2);
        const float32 = new Float32Array(sampleCount);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < sampleCount; i += 1) {
          const sample = view.getInt16(i * 2, true);
          float32[i] = sample / 0x7fff;
        }
        return float32;
      }

      async function playPcmChunk(audioBase64) {
        if (!audioBase64) return;
        const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextImpl) return;
        if (!state.playbackContext) {
          state.playbackContext = new AudioContextImpl({ sampleRate: 24000 });
        }
        const context = state.playbackContext;
        if (context.state === 'suspended') {
          await context.resume();
        }
        const float32 = pcm16Base64ToFloat32(audioBase64);
        if (!float32.length) return;
        const audioBuffer = context.createBuffer(1, float32.length, 24000);
        audioBuffer.getChannelData(0).set(float32);
        const source = context.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(context.destination);
        const now = context.currentTime;
        if (state.nextPlayTime < now) state.nextPlayTime = now + 0.03;
        source.start(state.nextPlayTime);
        state.nextPlayTime += audioBuffer.duration;
      }

      function playEncodedAudio(audioBase64, mimeType) {
        if (!audioBase64) return;
        const audio = new Audio('data:' + (mimeType || 'audio/mpeg') + ';base64,' + audioBase64);
        audio.play().catch(function () {});
      }

      function stopCapture() {
        if (state.processor) {
          try { state.processor.disconnect(); } catch (_error) {}
          state.processor = null;
        }
        if (state.stream) {
          try { state.stream.getTracks().forEach(function (track) { track.stop(); }); } catch (_error) {}
          state.stream = null;
        }
        if (state.inputContext) {
          state.inputContext.close().catch(function () {});
          state.inputContext = null;
        }
      }

      async function startCapture() {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true }
        });
        state.stream = stream;

        const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextImpl) {
          throw new Error('AudioContext is not supported');
        }

        state.inputContext = new AudioContextImpl({ sampleRate: 16000 });
        const source = state.inputContext.createMediaStreamSource(stream);
        state.processor = state.inputContext.createScriptProcessor(4096, 1, 1);
        state.processor.onaudioprocess = function (event) {
          if (!state.socket || state.socket.disconnected) return;
          if (!state.active || state.micMuted) return;
          if (state.serverStatus === 'speaking' || state.serverStatus === 'processing') return;
          const input = event.inputBuffer.getChannelData(0);
          const audioBase64 = float32ToPcm16Base64(input);
          state.socket.emit('pro:voice:realtime:audio', { audioBase64: audioBase64 });
        };
        source.connect(state.processor);
        state.processor.connect(state.inputContext.destination);
      }

      function clearRealtime() {
        stopCapture();
        if (state.playbackContext) {
          state.playbackContext.close().catch(function () {});
          state.playbackContext = null;
          state.nextPlayTime = 0;
        }
      }

      async function stopSession(emitFinish, statusText) {
        clearRealtime();
        if (state.socket && state.socket.connected) {
          state.socket.emit('pro:voice:realtime:stop', {});
        }
        if (state.socket) {
          state.socket.disconnect();
          state.socket = null;
        }
        state.active = false;
        state.micMuted = false;
        state.serverStatus = 'idle';
        updateButtons();
        if (typeof statusText === 'string' && statusText.trim()) {
          setStatus(statusText.trim());
        } else if (statusText !== false) {
          setStatus('Session finished');
        }
        if (emitFinish) {
          post('finish', {});
        }
      }

      function bindSocket(socket) {
        socket.on('pro:voice:realtime:status', function (payload) {
          state.serverStatus = String((payload && payload.status) || 'idle').trim().toLowerCase();
          setStatus(String((payload && payload.message) || '').trim());
        });

        socket.on('pro:voice:realtime:error', function (payload) {
          setError(String((payload && payload.message) || '').trim() || 'Realtime error');
        });

        socket.on('pro:voice:realtime:user', function (payload) {
          const text = String((payload && payload.text) || '').trim();
          if (!text) return;
          post('user', { text: text, createdAt: payload && payload.createdAt });
        });

        socket.on('pro:voice:realtime:assistant', function (payload) {
          const text = String((payload && payload.text) || '').trim();
          if (!text) return;
          post('assistant', { text: text, createdAt: payload && payload.createdAt });
        });

        socket.on('pro:voice:realtime:audio', function (payload) {
          const audioBase64 = String((payload && payload.audioBase64) || '').trim();
          const mimeType = String((payload && payload.mimeType) || '').trim().toLowerCase();
          if (!audioBase64) return;
          if (mimeType.indexOf('audio/pcm') >= 0) {
            playPcmChunk(audioBase64).catch(function () {});
            return;
          }
          playEncodedAudio(audioBase64, mimeType || 'audio/mpeg');
        });
      }

      async function connectAndStart() {
        if (state.starting || state.active) return;
        if (!window.io || typeof window.io !== 'function') {
          setError('socket.io client is unavailable');
          return;
        }

        state.starting = true;
        setError('');
        setStatus('Connecting...');
        updateButtons();

        try {
          const socket = window.io(boot.socketOrigin, {
            transports: ['websocket', 'polling'],
            tryAllTransports: true,
            upgrade: true,
            rememberUpgrade: false,
            withCredentials: true,
            auth: { token: boot.token },
            timeout: 20000,
            reconnection: true,
            reconnectionAttempts: Infinity
          });
          state.socket = socket;
          bindSocket(socket);

          await new Promise(function (resolve, reject) {
            let settled = false;
            let lastConnectError = '';
            let connectTimer = null;

            function clearListeners() {
              socket.off('connect', onConnect);
              socket.off('connect_error', onConnectError);
            }

            function fail(message) {
              if (settled) return;
              settled = true;
              if (connectTimer) {
                clearTimeout(connectTimer);
              }
              clearListeners();
              reject(new Error(message || lastConnectError || 'Socket connection failed'));
            }

            function complete(payload) {
              if (settled) return;
              settled = true;
              if (connectTimer) {
                clearTimeout(connectTimer);
              }
              clearListeners();
              resolve(payload);
            }

            function onConnectError(eventError) {
              const nextError = String((eventError && eventError.message) || '').trim();
              if (nextError) {
                lastConnectError = nextError;
              }
              // Do not fail on first connect_error, allow transport fallback/reconnect.
              setStatus('Connecting...');
            }

            function onConnect() {
              socket.timeout(20000).emit(
                'pro:voice:realtime:start',
                {
                  chatId: boot.chatId || undefined,
                  model: boot.model || undefined,
                  title: boot.title || 'Live Voice PRO',
                  platform: 'webview',
                  ttsVoice: 'Cherry'
                },
                function (eventError, response) {
                  if (eventError || !(response && response.ok)) {
                    fail((response && response.message) || (eventError && eventError.message) || 'Failed to start realtime');
                    return;
                  }
                  complete(response);
                }
              );
            }

            connectTimer = setTimeout(function () {
              fail(lastConnectError || 'Socket connection timeout');
            }, 25000);

            socket.on('connect_error', onConnectError);
            socket.on('connect', onConnect);
          });

          await startCapture();
          state.active = true;
          state.micMuted = false;
          setStatus('Voice mode is active');
        } catch (error) {
          setError((error && error.message) || 'Unable to start voice mode');
          await stopSession(false, false);
        } finally {
          state.starting = false;
          updateButtons();
        }
      }

      async function toggleMic() {
        if (!state.active) {
          await connectAndStart();
          return;
        }

        state.micMuted = !state.micMuted;
        updateButtons();
        if (state.micMuted) {
          setStatus('Microphone muted');
        } else {
          setStatus('Listening...');
        }
      }

      micBtn.addEventListener('click', function () {
        toggleMic().catch(function (error) {
          setError((error && error.message) || 'Microphone toggle failed');
        });
      });

      finishBtn.addEventListener('click', function () {
        stopSession(true).catch(function () {
          post('finish', {});
        });
      });

      window.addEventListener('beforeunload', function () {
        stopSession(false).catch(function () {});
      });

      updateButtons();
      connectAndStart().catch(function (error) {
        setError((error && error.message) || 'Unable to start voice mode');
      });
    })();
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

async function createProVoiceMessage(req, res) {
  const payload = voiceMessageSchema.parse(req.body || {});
  const proConfig = req.proConfig;
  const limits = resolveRuntimeLimits(proConfig);

  if (!proConfig.voiceMessagesEnabled) {
    throw new AppError(423, 'Voice messages are disabled in PRO mode', {
      type: 'PRO_FEATURE_DISABLED',
      featureKey: 'voiceMessagesEnabled',
      code: 'PRO_FEATURE_DISABLED_VOICE_MESSAGE'
    });
  }
  if (`${payload.audioBase64 || ''}`.trim().length > limits.maxVoiceAudioBase64Chars) {
    throw new AppError(
      413,
      `Voice payload is too large. Max size is ${Math.round(limits.maxVoiceAudioBase64Chars / (1024 * 1024))} MB (base64 chars).`
    );
  }

  const asrModelCandidates = uniqueModelCandidates(payload.asrModel, proConfig.voiceAsrModels);
  if (!asrModelCandidates.length) {
    throw new AppError(400, 'No ASR models are configured for PRO mode');
  }

  await consumeDailyQuota(req, proConfig, PRO_DAILY_FEATURE_KEYS.VOICE_MESSAGE);

  let tempAudio = null;
  try {
    tempAudio = await persistVoiceTempAudioFile({
      userId: req.user?.id || 'user',
      audioBase64: payload.audioBase64,
      mimeType: payload.mimeType || 'audio/webm',
      req
    });

    const audioUrlCandidates = [];
    if (tempAudio?.publicUrl) {
      audioUrlCandidates.push(tempAudio.publicUrl);
    }

    const asrResult = await runTranscriptionWithFallback({
      apiKey: req.proApiKey,
      apiKeys: req.proApiKeys,
      baseUrl: proConfig.baseUrl,
      modelCandidates: asrModelCandidates,
      audioBase64: payload.audioBase64,
      mimeType: payload.mimeType || 'audio/webm',
      language: payload.language || undefined,
      audioUrlCandidates
    });

    const transcript = `${asrResult.transcript || ''}`.trim();
    if (!transcript) {
      throw new AppError(502, 'ASR returned an empty transcript');
    }

    const textModelCandidates = uniqueModelCandidates(payload.textModel, proConfig.textModels);
    if (!textModelCandidates.length) {
      throw new AppError(400, 'No text models are configured for PRO mode');
    }

    const textResult = await runChatWithFallback({
      apiKey: req.proApiKey,
      apiKeys: req.proApiKeys,
      baseUrl: proConfig.baseUrl,
      modelCandidates: textModelCandidates,
      messages: [
        { role: 'system', content: buildPersonalizedSystemPrompt(proConfig.systemPrompt, req.user) },
        { role: 'user', content: transcript }
      ],
      temperature: Number(proConfig.temperature),
      maxTokens: resolveResponseMaxTokens(proConfig)
    });

    triggerProMemoryCompression(
      req.user.id,
      [{ role: 'user', content: transcript }],
      textResult.text,
      'pro_voice_message'
    );

    let ttsPayload = null;
    const shouldReturnAudio = payload.returnAudio !== false;
    if (shouldReturnAudio) {
      const ttsModelCandidates = uniqueModelCandidates(payload.ttsModel, proConfig.voiceTtsModels);
      if (ttsModelCandidates.length) {
        try {
          const ttsResult = await runSpeechSynthesisWithFallback({
            apiKey: req.proApiKey,
            apiKeys: req.proApiKeys,
            baseUrl: proConfig.baseUrl,
            modelCandidates: ttsModelCandidates,
            input: textResult.text,
            voice: payload.ttsVoice || 'Cherry'
          });
          ttsPayload = {
            audioBase64: ttsResult.audioBase64,
            mimeType: ttsResult.mimeType || 'audio/mpeg',
            modelUsed: ttsResult.modelUsed,
            keyUsed: ttsResult.keyUsed || null,
            attempts: ttsResult.attempts || []
          };
        } catch (ttsError) {
          ttsPayload = {
            audioBase64: null,
            mimeType: null,
            modelUsed: null,
            keyUsed: null,
            attempts: ttsError?.details?.attempts || [],
            error: ttsError?.message || 'TTS unavailable'
          };
        }
      }
    }

    res.json({
      transcript,
      reply: textResult.text,
      asr: {
        modelUsed: asrResult.modelUsed,
        keyUsed: asrResult.keyUsed || null,
        endpoint: asrResult.endpoint || null,
        attempts: asrResult.attempts || []
      },
      text: {
        modelUsed: textResult.modelUsed,
        keyUsed: textResult.keyUsed || null,
        usage: textResult.usage || null,
        attempts: textResult.attempts || []
      },
      tts: ttsPayload
    });
  } finally {
    await cleanupVoiceTempAudio(tempAudio?.filePath);
  }
}

module.exports = {
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
};
