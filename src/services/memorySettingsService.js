const DEFAULT_MEMORY_SETTINGS = {
  enabled: true,
  scribeModel: 'openrouter/auto',
  summarizeEveryMessages: 1,
  extractFactsEveryMessages: 1,
  updateProfileEveryMessages: 3,
  factsWindowMessages: 60,
  promptHistoryMessages: 24,
  maxProfileWords: 200,
  maxSummaryWords: 300,
  maxPendingFacts: 60,
  runOnRegenerate: true,
  importanceFilterEnabled: true,
  useLlmImportanceCheck: true,
  minMessageLengthForMemory: 4,
  ignoredMessagePatterns: [
    'привет',
    'здарова',
    'ok',
    'ок',
    'ага',
    'понял',
    'спасибо',
    'ясно',
    'пон',
    'кк'
  ]
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

function toInt(value, fallback, min, max) {
  const number = Number.parseInt(`${value ?? ''}`.trim(), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizePatterns(value, fallback = []) {
  let source = value;
  if (typeof source === 'string') {
    source = source
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (!Array.isArray(source)) source = fallback;

  const unique = new Set();
  for (const item of source) {
    const normalized = `${item || ''}`.trim().toLowerCase();
    if (!normalized) continue;
    unique.add(normalized);
    if (unique.size >= 100) break;
  }

  return Array.from(unique);
}

function normalizeModelId(value, fallback = 'openrouter/auto') {
  const model = `${value || ''}`.trim();
  if (!model) return fallback;
  return model.slice(0, 120);
}

function normalizeMemorySettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};

  return {
    enabled: toBoolean(source.enabled, DEFAULT_MEMORY_SETTINGS.enabled),
    scribeModel: normalizeModelId(source.scribeModel, DEFAULT_MEMORY_SETTINGS.scribeModel),
    summarizeEveryMessages: toInt(
      source.summarizeEveryMessages,
      DEFAULT_MEMORY_SETTINGS.summarizeEveryMessages,
      1,
      300
    ),
    extractFactsEveryMessages: toInt(
      source.extractFactsEveryMessages,
      DEFAULT_MEMORY_SETTINGS.extractFactsEveryMessages,
      1,
      300
    ),
    updateProfileEveryMessages: toInt(
      source.updateProfileEveryMessages,
      DEFAULT_MEMORY_SETTINGS.updateProfileEveryMessages,
      1,
      500
    ),
    factsWindowMessages: toInt(
      source.factsWindowMessages,
      DEFAULT_MEMORY_SETTINGS.factsWindowMessages,
      10,
      150
    ),
    promptHistoryMessages: toInt(
      source.promptHistoryMessages,
      DEFAULT_MEMORY_SETTINGS.promptHistoryMessages,
      8,
      60
    ),
    maxProfileWords: toInt(source.maxProfileWords, DEFAULT_MEMORY_SETTINGS.maxProfileWords, 80, 500),
    maxSummaryWords: toInt(source.maxSummaryWords, DEFAULT_MEMORY_SETTINGS.maxSummaryWords, 120, 800),
    maxPendingFacts: toInt(source.maxPendingFacts, DEFAULT_MEMORY_SETTINGS.maxPendingFacts, 5, 100),
    runOnRegenerate: toBoolean(source.runOnRegenerate, DEFAULT_MEMORY_SETTINGS.runOnRegenerate),
    importanceFilterEnabled: toBoolean(
      source.importanceFilterEnabled,
      DEFAULT_MEMORY_SETTINGS.importanceFilterEnabled
    ),
    useLlmImportanceCheck: toBoolean(
      source.useLlmImportanceCheck,
      DEFAULT_MEMORY_SETTINGS.useLlmImportanceCheck
    ),
    minMessageLengthForMemory: toInt(
      source.minMessageLengthForMemory,
      DEFAULT_MEMORY_SETTINGS.minMessageLengthForMemory,
      1,
      100
    ),
    ignoredMessagePatterns: normalizePatterns(
      source.ignoredMessagePatterns,
      DEFAULT_MEMORY_SETTINGS.ignoredMessagePatterns
    )
  };
}

function parseFeatureFlags(featureFlagsJson) {
  const parsed = safeJsonParse(featureFlagsJson, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
}

function getMemorySettings(featureFlagsJson) {
  const flags = parseFeatureFlags(featureFlagsJson);
  return normalizeMemorySettings(flags.memory);
}

function withMemorySettings(featureFlagsJson, nextMemorySettings) {
  const flags = parseFeatureFlags(featureFlagsJson);
  const merged = normalizeMemorySettings({
    ...getMemorySettings(featureFlagsJson),
    ...(nextMemorySettings && typeof nextMemorySettings === 'object' ? nextMemorySettings : {})
  });

  const nextFlags = {
    ...flags,
    memory: merged
  };

  return {
    featureFlags: nextFlags,
    featureFlagsJson: JSON.stringify(nextFlags),
    memorySettings: merged
  };
}

module.exports = {
  DEFAULT_MEMORY_SETTINGS,
  getMemorySettings,
  withMemorySettings,
  normalizeMemorySettings
};
