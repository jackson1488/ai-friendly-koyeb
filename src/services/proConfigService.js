const { env } = require('../config/env');

const DEFAULT_PRO_LIMITS = {
  maxOutputTokens: 2048,
  maxFileAnalyzeBytes: 8 * 1024 * 1024,
  maxImagePromptChars: 4000,
  maxVideoPromptChars: 4000,
  maxVoiceAudioBase64Chars: 20_000_000,
  maxVideoDurationSeconds: 120,
  maxMessagesPerRequest: 60,
  maxImageAnalysesPerDay: 40,
  maxImageGenerationsPerDay: 5,
  maxImageEditsPerDay: 20,
  maxVideoGenerationsPerDay: 5,
  maxVoiceMessagesPerDay: 80,
  maxVoiceRealtimeSessionsPerDay: 60,
  maxFileAnalysesPerDay: 30
};

const PRO_FEATURE_KEYS = [
  'imageAnalysisEnabled',
  'imageGenerationEnabled',
  'imageEditingEnabled',
  'videoGenerationEnabled',
  'voiceMessagesEnabled',
  'voiceRealtimeEnabled',
  'fileAnalysisEnabled'
];

const PRO_DAILY_LIMIT_KEYS = [
  'maxImageAnalysesPerDay',
  'maxImageGenerationsPerDay',
  'maxImageEditsPerDay',
  'maxVideoGenerationsPerDay',
  'maxVoiceMessagesPerDay',
  'maxVoiceRealtimeSessionsPerDay',
  'maxFileAnalysesPerDay'
];

const DEFAULT_PRO_CONFIG = {
  enabled: false,
  accessMode: 'allowlist',
  allowAdmins: true,
  allowedUserIds: [],
  provider: 'qwen-compatible',
  baseUrl: env.proQwenBaseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  apiKey: '',
  apiKeys: [],
  textModels: ['qwen-plus', 'qwen-turbo'],
  visionModels: ['qwen-vl-max-latest', 'qwen-vl-plus-latest'],
  imageGenModels: [
    'qwen-image-2.0',
    'qwen-image-2.0-2026-03-03',
    'qwen-image-2.0-pro',
    'qwen-image-2.0-pro-2026-03-03',
    'qwen-image-plus',
    'qwen-image-plus-2026-01-09',
    'qwen-image-max',
    'qwen-image-max-2025-12-30',
    'qwen-image',
    'z-image-turbo',
    'wan2.2-t2i-flash',
    'wan2.2-t2i-plus',
    'wan2.1-t2i-plus',
    'wan2.1-t2i-turbo',
    'wan2.6-t2i',
    'wan2.5-t2i-preview',
    'wan2.6-image',
    'wan2.7-image',
    'wan2.7-image-pro'
  ],
  imageEditModels: [
    'qwen-image-edit-plus',
    'qwen-image-edit-plus-2025-10-30',
    'qwen-image-edit-plus-2025-12-15',
    'qwen-image-edit',
    'qwen-image-edit-max',
    'qwen-image-edit-max-2026-01-16',
    'wan2.5-i2i-preview'
  ],
  videoGenModels: [
    'wan2.2-t2v-plus',
    'wan2.7-t2v',
    'wan2.6-t2v',
    'wan2.1-t2v-plus',
    'wan2.1-t2v-turbo',
    'wan2.5-t2v-preview',
    'wan2.2-i2v-plus',
    'wan2.2-i2v-flash',
    'wan2.7-i2v',
    'wan2.6-i2v',
    'wan2.6-i2v-flash',
    'wan2.1-i2v-plus',
    'wan2.1-i2v-turbo',
    'wan2.5-i2v-preview',
    'wan2.1-kf2v-plus',
    'wan2.7-r2v',
    'wan2.6-r2v',
    'wan2.6-r2v-flash',
    'wan2.2-animate-move',
    'wan2.2-animate-mix',
    'wan2.7-videoedit',
    'wan2.1-vace-plus'
  ],
  voiceAsrModels: [
    'qwen3-asr-flash-filetrans-2025-11-17',
    'qwen3-asr-flash-filetrans',
    'qwen3-asr-flash-2026-02-10'
  ],
  voiceTtsModels: [
    'qwen3-tts-flash-2025-11-27',
    'qwen3-tts-flash-2025-09-18',
    'cosyvoice-v3-plus'
  ],
  // Realtime-first chain for multimodal voice.
  // If realtime endpoints are unavailable/limited, fallback continues on non-realtime omni models.
  voiceRealtimeModels: [
    'qwen3.5-omni-plus-realtime-2026-03-15',
    'qwen3.5-omni-plus-realtime',
    'qwen3.5-omni-flash-realtime-2026-03-15',
    'qwen3.5-omni-flash-realtime',
    'qwen3-omni-flash-realtime-2025-12-01',
    'qwen3-omni-flash-realtime-2025-09-15',
    'qwen3-omni-flash-realtime',
    'qwen-omni-turbo-realtime-latest',
    'qwen-omni-turbo-realtime-2025-05-08',
    'qwen-omni-turbo-realtime',
    'qwen3.5-omni-plus-2026-03-15',
    'qwen3.5-omni-plus',
    'qwen3.5-omni-flash-2026-03-15',
    'qwen3.5-omni-flash',
    'qwen3-omni-flash-2025-12-01',
    'qwen3-omni-flash-2025-09-15',
    'qwen3-omni-flash',
    'qwen-omni-turbo-2025-03-26',
    'qwen-omni-turbo',
    'qwen2.5-omni-7b'
  ],
  imageAnalysisEnabled: true,
  imageGenerationEnabled: true,
  imageEditingEnabled: true,
  videoGenerationEnabled: true,
  voiceMessagesEnabled: true,
  voiceRealtimeEnabled: true,
  fileAnalysisEnabled: true,
  maxOutputTokens: 2048,
  temperature: 0.7,
  limits: DEFAULT_PRO_LIMITS,
  userOverrides: {},
  systemPrompt:
    'You are Alma Pro, a supportive and professional psychological assistant. Keep answers practical, safe, and concise.'
};

function safeJsonParse(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function toBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeUrl(value, fallback) {
  const text = `${value || ''}`.trim() || fallback;
  return text.replace(/\/+$/, '');
}

function normalizeStringList(value, fallback = [], maxItems = 20, maxLen = 120) {
  let source = value;
  if (typeof source === 'string') {
    source = source
      .split(/[\n,]/g)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(source)) {
    source = fallback;
  }

  const unique = new Set();
  for (const item of source) {
    const normalized = `${item || ''}`.trim();
    if (!normalized) continue;
    unique.add(normalized.slice(0, maxLen));
    if (unique.size >= maxItems) break;
  }
  const normalizedList = Array.from(unique);
  if (normalizedList.length > 0) return normalizedList;
  return Array.isArray(fallback) ? [...fallback] : [];
}

function normalizeStringListUnion(value, fallback = [], maxItems = 20, maxLen = 120) {
  const primary = normalizeStringList(value, [], maxItems, maxLen);
  const mergedSource = [...primary, ...(Array.isArray(fallback) ? fallback : [])];
  return normalizeStringList(mergedSource, fallback, maxItems, maxLen);
}

function normalizeAllowedUserIds(value, fallback = []) {
  return normalizeStringList(value, fallback, 5000, 128);
}

function normalizeAccessMode(value, fallback = 'allowlist') {
  const mode = `${value || ''}`.trim().toLowerCase();
  if (mode === 'all' || mode === 'allowlist') return mode;
  return fallback;
}

function normalizeProLimits(value, fallback = DEFAULT_PRO_LIMITS) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const base = fallback && typeof fallback === 'object' ? fallback : DEFAULT_PRO_LIMITS;
  return {
    maxOutputTokens: clampNumber(
      source.maxOutputTokens,
      base.maxOutputTokens || DEFAULT_PRO_LIMITS.maxOutputTokens,
      128,
      8192
    ),
    maxFileAnalyzeBytes: clampNumber(
      source.maxFileAnalyzeBytes,
      base.maxFileAnalyzeBytes || DEFAULT_PRO_LIMITS.maxFileAnalyzeBytes,
      256 * 1024,
      20_000_000
    ),
    maxImagePromptChars: clampNumber(
      source.maxImagePromptChars,
      base.maxImagePromptChars || DEFAULT_PRO_LIMITS.maxImagePromptChars,
      200,
      12_000
    ),
    maxVideoPromptChars: clampNumber(
      source.maxVideoPromptChars,
      base.maxVideoPromptChars || DEFAULT_PRO_LIMITS.maxVideoPromptChars,
      200,
      12_000
    ),
    maxVoiceAudioBase64Chars: clampNumber(
      source.maxVoiceAudioBase64Chars,
      base.maxVoiceAudioBase64Chars || DEFAULT_PRO_LIMITS.maxVoiceAudioBase64Chars,
      50_000,
      20_000_000
    ),
    maxVideoDurationSeconds: clampNumber(
      source.maxVideoDurationSeconds,
      base.maxVideoDurationSeconds || DEFAULT_PRO_LIMITS.maxVideoDurationSeconds,
      1,
      180
    ),
    maxMessagesPerRequest: clampNumber(
      source.maxMessagesPerRequest,
      base.maxMessagesPerRequest || DEFAULT_PRO_LIMITS.maxMessagesPerRequest,
      1,
      120
    ),
    maxImageAnalysesPerDay: clampNumber(
      source.maxImageAnalysesPerDay,
      base.maxImageAnalysesPerDay || DEFAULT_PRO_LIMITS.maxImageAnalysesPerDay,
      1,
      5000
    ),
    maxImageGenerationsPerDay: clampNumber(
      source.maxImageGenerationsPerDay,
      base.maxImageGenerationsPerDay || DEFAULT_PRO_LIMITS.maxImageGenerationsPerDay,
      1,
      5000
    ),
    maxImageEditsPerDay: clampNumber(
      source.maxImageEditsPerDay,
      base.maxImageEditsPerDay || DEFAULT_PRO_LIMITS.maxImageEditsPerDay,
      1,
      5000
    ),
    maxVideoGenerationsPerDay: clampNumber(
      source.maxVideoGenerationsPerDay,
      base.maxVideoGenerationsPerDay || DEFAULT_PRO_LIMITS.maxVideoGenerationsPerDay,
      1,
      5000
    ),
    maxVoiceMessagesPerDay: clampNumber(
      source.maxVoiceMessagesPerDay,
      base.maxVoiceMessagesPerDay || DEFAULT_PRO_LIMITS.maxVoiceMessagesPerDay,
      1,
      5000
    ),
    maxVoiceRealtimeSessionsPerDay: clampNumber(
      source.maxVoiceRealtimeSessionsPerDay,
      base.maxVoiceRealtimeSessionsPerDay || DEFAULT_PRO_LIMITS.maxVoiceRealtimeSessionsPerDay,
      1,
      5000
    ),
    maxFileAnalysesPerDay: clampNumber(
      source.maxFileAnalysesPerDay,
      base.maxFileAnalysesPerDay || DEFAULT_PRO_LIMITS.maxFileAnalysesPerDay,
      1,
      5000
    )
  };
}

function normalizeProFeatureSet(value, fallback = DEFAULT_PRO_CONFIG) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const base = fallback && typeof fallback === 'object' ? fallback : DEFAULT_PRO_CONFIG;
  const result = {};
  for (const key of PRO_FEATURE_KEYS) {
    result[key] = toBoolean(source[key], toBoolean(base[key], true));
  }
  return result;
}

function normalizeUserOverrideEntry(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawAccess = `${source.access || 'inherit'}`.trim().toLowerCase();
  const access = rawAccess === 'allow' || rawAccess === 'deny' ? rawAccess : 'inherit';
  const features = normalizeProFeatureSet(source.features, DEFAULT_PRO_CONFIG);
  const limits = normalizeProLimits(source.limits, DEFAULT_PRO_LIMITS);
  return {
    access,
    features,
    limits
  };
}

function normalizeUserOverrides(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  for (const [key, raw] of Object.entries(source)) {
    const userId = `${key || ''}`.trim().slice(0, 120);
    if (!userId) continue;
    result[userId] = normalizeUserOverrideEntry(raw);
  }
  return result;
}

function normalizeProConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};

  return {
    enabled: toBoolean(source.enabled, DEFAULT_PRO_CONFIG.enabled),
    accessMode: normalizeAccessMode(source.accessMode, DEFAULT_PRO_CONFIG.accessMode),
    allowAdmins: toBoolean(source.allowAdmins, DEFAULT_PRO_CONFIG.allowAdmins),
    allowedUserIds: normalizeAllowedUserIds(source.allowedUserIds, DEFAULT_PRO_CONFIG.allowedUserIds),
    provider: `${source.provider || DEFAULT_PRO_CONFIG.provider}`.trim().slice(0, 80),
    baseUrl: normalizeUrl(source.baseUrl, DEFAULT_PRO_CONFIG.baseUrl),
    apiKey: `${source.apiKey || ''}`.trim().slice(0, 500),
    apiKeys: normalizeStringList(source.apiKeys, DEFAULT_PRO_CONFIG.apiKeys, 40, 500),
    textModels: normalizeStringList(source.textModels, DEFAULT_PRO_CONFIG.textModels, 20, 140),
    visionModels: normalizeStringList(source.visionModels, DEFAULT_PRO_CONFIG.visionModels, 20, 140),
    imageGenModels: normalizeStringListUnion(
      source.imageGenModels,
      DEFAULT_PRO_CONFIG.imageGenModels,
      200,
      140
    ),
    imageEditModels: normalizeStringListUnion(
      source.imageEditModels,
      DEFAULT_PRO_CONFIG.imageEditModels,
      200,
      140
    ),
    videoGenModels: normalizeStringListUnion(
      source.videoGenModels,
      DEFAULT_PRO_CONFIG.videoGenModels,
      200,
      140
    ),
    voiceAsrModels: normalizeStringList(source.voiceAsrModels, DEFAULT_PRO_CONFIG.voiceAsrModels, 40, 140),
    voiceTtsModels: normalizeStringList(source.voiceTtsModels, DEFAULT_PRO_CONFIG.voiceTtsModels, 40, 140),
    voiceRealtimeModels: normalizeStringList(
      source.voiceRealtimeModels,
      DEFAULT_PRO_CONFIG.voiceRealtimeModels,
      80,
      140
    ),
    imageAnalysisEnabled: toBoolean(
      source.imageAnalysisEnabled,
      DEFAULT_PRO_CONFIG.imageAnalysisEnabled
    ),
    imageGenerationEnabled: toBoolean(
      source.imageGenerationEnabled,
      DEFAULT_PRO_CONFIG.imageGenerationEnabled
    ),
    imageEditingEnabled: toBoolean(
      source.imageEditingEnabled,
      DEFAULT_PRO_CONFIG.imageEditingEnabled
    ),
    videoGenerationEnabled: toBoolean(
      source.videoGenerationEnabled,
      DEFAULT_PRO_CONFIG.videoGenerationEnabled
    ),
    voiceMessagesEnabled: toBoolean(
      source.voiceMessagesEnabled,
      DEFAULT_PRO_CONFIG.voiceMessagesEnabled
    ),
    voiceRealtimeEnabled: toBoolean(source.voiceRealtimeEnabled, DEFAULT_PRO_CONFIG.voiceRealtimeEnabled),
    fileAnalysisEnabled: toBoolean(source.fileAnalysisEnabled, DEFAULT_PRO_CONFIG.fileAnalysisEnabled),
    maxOutputTokens: clampNumber(
      source.maxOutputTokens,
      DEFAULT_PRO_CONFIG.maxOutputTokens,
      128,
      8192
    ),
    temperature: clampNumber(source.temperature, DEFAULT_PRO_CONFIG.temperature, 0, 2),
    limits: normalizeProLimits(source.limits, DEFAULT_PRO_LIMITS),
    userOverrides: normalizeUserOverrides(source.userOverrides),
    systemPrompt: `${source.systemPrompt || DEFAULT_PRO_CONFIG.systemPrompt}`.trim().slice(0, 8000)
  };
}

function parseFeatureFlags(featureFlagsJson) {
  const parsed = safeJsonParse(featureFlagsJson, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
}

function getProConfig(featureFlagsJson) {
  const flags = parseFeatureFlags(featureFlagsJson);
  return normalizeProConfig(flags.proAssistant);
}

function withProConfig(featureFlagsJson, nextProConfig) {
  const flags = parseFeatureFlags(featureFlagsJson);
  const merged = normalizeProConfig({
    ...getProConfig(featureFlagsJson),
    ...(nextProConfig && typeof nextProConfig === 'object' ? nextProConfig : {})
  });

  const nextFlags = {
    ...flags,
    proAssistant: merged
  };

  return {
    featureFlags: nextFlags,
    featureFlagsJson: JSON.stringify(nextFlags),
    proConfig: merged
  };
}

function resolveProApiKey(proConfig) {
  const keys = resolveProApiKeys(proConfig);
  return keys[0] || '';
}

function resolveProApiKeys(proConfig) {
  const keys = [];
  const push = (value) => {
    const text = `${value || ''}`.trim();
    if (!text) return;
    if (!keys.includes(text)) keys.push(text);
  };

  const fromConfigList = Array.isArray(proConfig?.apiKeys) ? proConfig.apiKeys : [];
  for (const item of fromConfigList) push(item);
  push(proConfig?.apiKey);

  const fromEnvList = Array.isArray(env.proQwenApiKeys) ? env.proQwenApiKeys : [];
  for (const item of fromEnvList) push(item);
  push(env.proQwenApiKey);
  push(env.qwenApiKey);

  return keys;
}

function maskSecret(value) {
  const text = `${value || ''}`.trim();
  if (!text) return '';
  if (text.length <= 10) return '********';
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function isUserAllowedForPro(user, proConfig) {
  if (!user || !proConfig) return false;
  if (proConfig.allowAdmins && user.role === 'ADMIN') return true;
  if (proConfig.accessMode === 'all') return true;
  return proConfig.allowedUserIds.includes(user.id);
}

function hasProAccess(user, proConfig) {
  if (!proConfig?.enabled) return false;
  const userId = `${user?.id || ''}`.trim();
  const override = userId && proConfig?.userOverrides ? proConfig.userOverrides[userId] : null;
  if (override?.access === 'deny') return false;
  if (override?.access === 'allow') return true;
  return isUserAllowedForPro(user, proConfig);
}

function setUserProAccess(featureFlagsJson, userId, isEnabled) {
  const current = getProConfig(featureFlagsJson);
  const set = new Set(current.allowedUserIds);
  if (isEnabled) {
    set.add(userId);
  } else {
    set.delete(userId);
  }
  return withProConfig(featureFlagsJson, { allowedUserIds: Array.from(set) });
}

function getUserProOverride(proConfig, userId) {
  const safeUserId = `${userId || ''}`.trim();
  if (!safeUserId) return null;
  const map = proConfig?.userOverrides;
  if (!map || typeof map !== 'object') return null;
  return map[safeUserId] || null;
}

function getEffectiveProConfigForUser(proConfig, user) {
  const normalized = normalizeProConfig(proConfig);
  const userId = `${user?.id || ''}`.trim();
  const override = getUserProOverride(normalized, userId);
  const effective = {
    ...normalized,
    limits: { ...normalized.limits }
  };

  if (override) {
    for (const key of PRO_FEATURE_KEYS) {
      if (typeof override.features?.[key] === 'boolean') {
        effective[key] = override.features[key];
      }
    }
    if (override.limits && typeof override.limits === 'object') {
      effective.limits = normalizeProLimits(override.limits, normalized.limits);
    }
    effective.maxOutputTokens = clampNumber(
      override.limits?.maxOutputTokens,
      normalized.maxOutputTokens,
      128,
      8192
    );
  } else {
    // Product rule: by default, users are unrestricted; per-user overrides define real restrictions.
    for (const key of PRO_FEATURE_KEYS) {
      effective[key] = true;
    }
    // Daily quotas are applied only via per-user override.
    for (const key of PRO_DAILY_LIMIT_KEYS) {
      effective.limits[key] = null;
    }
  }

  return {
    ...effective,
    userOverride: override,
    userAccessAllowed: hasProAccess(user, normalized)
  };
}

function setUserProOverride(featureFlagsJson, userId, patch) {
  const safeUserId = `${userId || ''}`.trim().slice(0, 120);
  if (!safeUserId) {
    return withProConfig(featureFlagsJson, {});
  }

  const current = getProConfig(featureFlagsJson);
  const currentMap = current.userOverrides && typeof current.userOverrides === 'object' ? { ...current.userOverrides } : {};
  const currentEntry = normalizeUserOverrideEntry(currentMap[safeUserId] || {});
  const nextPatch = patch && typeof patch === 'object' ? patch : {};

  const rawAccess = `${nextPatch.access || currentEntry.access || 'inherit'}`.trim().toLowerCase();
  const access = rawAccess === 'allow' || rawAccess === 'deny' ? rawAccess : 'inherit';
  const features = normalizeProFeatureSet(
    nextPatch.features && typeof nextPatch.features === 'object' ? nextPatch.features : currentEntry.features,
    DEFAULT_PRO_CONFIG
  );
  const limits = normalizeProLimits(
    nextPatch.limits && typeof nextPatch.limits === 'object' ? nextPatch.limits : currentEntry.limits,
    DEFAULT_PRO_LIMITS
  );

  currentMap[safeUserId] = { access, features, limits };

  return withProConfig(featureFlagsJson, {
    userOverrides: currentMap
  });
}

function listToText(value) {
  if (!Array.isArray(value) || value.length === 0) return '';
  return value.join('\n');
}

module.exports = {
  DEFAULT_PRO_CONFIG,
  getProConfig,
  withProConfig,
  resolveProApiKey,
  resolveProApiKeys,
  maskSecret,
  hasProAccess,
  isUserAllowedForPro,
  getUserProOverride,
  getEffectiveProConfigForUser,
  setUserProAccess,
  setUserProOverride,
  listToText
};
