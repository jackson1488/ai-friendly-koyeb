const SUPPORTED_CHAT_LANGUAGE_CODES = ['ru', 'ky', 'en'];

const DEFAULT_LANGUAGE_POLICY = {
  enabled: true,
  allowedLanguages: [...SUPPORTED_CHAT_LANGUAGE_CODES],
  unsupportedLanguageMessage:
    'Unsupported language. Please use Russian, Kyrgyz, or English.'
};

function safeJsonParse(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function parseFeatureFlags(featureFlagsJson) {
  const parsed = safeJsonParse(featureFlagsJson, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
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

function normalizeAllowedLanguages(value) {
  let source = value;
  if (typeof source === 'string') {
    source = source
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (!Array.isArray(source)) {
    return [...DEFAULT_LANGUAGE_POLICY.allowedLanguages];
  }

  const normalized = [];
  for (const item of source) {
    const code = `${item || ''}`.trim().toLowerCase();
    if (!SUPPORTED_CHAT_LANGUAGE_CODES.includes(code)) continue;
    if (!normalized.includes(code)) normalized.push(code);
  }

  return normalized.length ? normalized : [...DEFAULT_LANGUAGE_POLICY.allowedLanguages];
}

function normalizeUnsupportedLanguageMessage(value) {
  const text = `${value || ''}`.trim();
  if (!text) return DEFAULT_LANGUAGE_POLICY.unsupportedLanguageMessage;
  // Keep fallback in English to match UX requirement.
  if (!/[a-z]/i.test(text)) return DEFAULT_LANGUAGE_POLICY.unsupportedLanguageMessage;
  return text.slice(0, 280);
}

function normalizeLanguagePolicy(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: toBoolean(source.enabled, DEFAULT_LANGUAGE_POLICY.enabled),
    allowedLanguages: normalizeAllowedLanguages(source.allowedLanguages),
    unsupportedLanguageMessage: normalizeUnsupportedLanguageMessage(source.unsupportedLanguageMessage)
  };
}

function getLanguagePolicy(featureFlagsJson) {
  const flags = parseFeatureFlags(featureFlagsJson);
  return normalizeLanguagePolicy(flags.languagePolicy);
}

function withLanguagePolicy(featureFlagsJson, nextLanguagePolicy) {
  const flags = parseFeatureFlags(featureFlagsJson);
  const merged = normalizeLanguagePolicy({
    ...getLanguagePolicy(featureFlagsJson),
    ...(nextLanguagePolicy && typeof nextLanguagePolicy === 'object' ? nextLanguagePolicy : {})
  });

  const nextFlags = {
    ...flags,
    languagePolicy: merged
  };

  return {
    featureFlags: nextFlags,
    featureFlagsJson: JSON.stringify(nextFlags),
    languagePolicy: merged
  };
}

function detectMessageLanguage(text) {
  const sample = `${text || ''}`.trim();
  if (!sample) return 'neutral';

  let latinCount = 0;
  let cyrillicCount = 0;
  let hasKyrgyzSpecificLetters = false;

  for (const char of sample) {
    if (/[A-Za-z]/.test(char)) {
      latinCount += 1;
      continue;
    }
    if (/[\u0400-\u04FF]/.test(char)) {
      cyrillicCount += 1;
      if (/[\u04A2\u04A3\u04E8\u04E9\u04AE\u04AF\u049A\u049B\u04BA\u04BB]/.test(char)) {
        hasKyrgyzSpecificLetters = true;
      }
      continue;
    }

    // Safe skip for digits, spaces, punctuation and common emoji ranges.
    if (/[\d\s]/.test(char)) continue;
    if (/[\u0000-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u00BF]/.test(char)) continue;
    if (/[\u2000-\u206F]/.test(char)) continue;
    if (/[\u2600-\u27BF\u{1F000}-\u{1FAFF}]/u.test(char)) continue;

    // Any remaining script is treated as unsupported language input.
    return 'unsupported';
  }

  if (!latinCount && !cyrillicCount) return 'neutral';
  if (hasKyrgyzSpecificLetters) return 'ky';
  if (cyrillicCount && !latinCount) return 'ru';
  if (latinCount && !cyrillicCount) return 'en';
  return latinCount >= cyrillicCount ? 'en' : 'ru';
}

function resolveLanguageGate(text, languagePolicy) {
  const policy = normalizeLanguagePolicy(languagePolicy);
  if (!policy.enabled) {
    return {
      isSupported: true,
      detectedLanguage: 'policy_disabled',
      fallbackMessage: policy.unsupportedLanguageMessage
    };
  }

  const detectedLanguage = detectMessageLanguage(text);
  const allowed = new Set(policy.allowedLanguages);
  const isSupported =
    detectedLanguage === 'neutral' || (detectedLanguage !== 'unsupported' && allowed.has(detectedLanguage));

  return {
    isSupported,
    detectedLanguage,
    fallbackMessage: policy.unsupportedLanguageMessage
  };
}

function getLanguageLabel(code) {
  if (code === 'ru') return 'Russian';
  if (code === 'ky') return 'Kyrgyz';
  if (code === 'en') return 'English';
  return code;
}

module.exports = {
  SUPPORTED_CHAT_LANGUAGE_CODES,
  DEFAULT_LANGUAGE_POLICY,
  normalizeLanguagePolicy,
  getLanguagePolicy,
  withLanguagePolicy,
  detectMessageLanguage,
  resolveLanguageGate,
  getLanguageLabel
};
