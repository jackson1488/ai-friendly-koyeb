const DEFAULT_ONBOARDING_TEST_QUESTIONS = Object.freeze([
  {
    id: 'stressCoping',
    type: 'single',
    title: 'Когда стресс накрывает, что чаще всего помогает?',
    hint: '',
    placeholder: '',
    maxSelections: 1,
    options: ['Прогулка и движение', 'Разговор с близким', 'Пауза и дыхание', 'Структурный план действий']
  },
  {
    id: 'anxietyTriggers',
    type: 'multi',
    title: 'Что чаще всего запускает тревогу?',
    hint: 'Можно выбрать до 3 вариантов',
    placeholder: '',
    maxSelections: 3,
    options: [
      'Неопределённость будущего',
      'Конфликты в отношениях',
      'Работа и дедлайны',
      'Финансовые вопросы',
      'Одиночество'
    ]
  },
  {
    id: 'supportStyle',
    type: 'single',
    title: 'Какой стиль поддержки тебе ближе?',
    hint: '',
    placeholder: '',
    maxSelections: 1,
    options: ['Тёплый и мягкий', 'Короткий и по делу', 'С вопросами и рефлексией', 'С конкретными шагами']
  },
  {
    id: 'baselineMood',
    type: 'single',
    title: 'Какое состояние чаще всего в последние дни?',
    hint: '',
    placeholder: '',
    maxSelections: 1,
    options: ['Напряжённо', 'Нестабильно', 'Нормально', 'Спокойно', 'Воодушевлённо']
  },
  {
    id: 'supportFocus',
    type: 'single',
    title: 'На чём сделать главный фокус в поддержке?',
    hint: '',
    placeholder: '',
    maxSelections: 1,
    options: ['Снизить тревогу', 'Стабилизировать сон/режим', 'Улучшить отношения', 'Вернуть энергию и мотивацию']
  },
  {
    id: 'sleepPattern',
    type: 'single',
    title: 'Как сейчас у тебя со сном?',
    hint: '',
    placeholder: '',
    maxSelections: 1,
    options: ['Трудно уснуть', 'Часто просыпаюсь ночью', 'Сон нестабильный', 'Сон в целом нормальный']
  },
  {
    id: 'socialBattery',
    type: 'single',
    title: 'После общения ты чаще чувствуешь...',
    hint: '',
    placeholder: '',
    maxSelections: 1,
    options: ['Усталость и перегруз', 'Нейтрально', 'Поддержку и ресурс']
  },
  {
    id: 'responseLength',
    type: 'single',
    title: 'Какой формат ответов тебе удобнее?',
    hint: '',
    placeholder: '',
    maxSelections: 1,
    options: ['Коротко (2-3 предложения)', 'Средне (абзац)', 'Подробно с примерами']
  },
  {
    id: 'firstSupportStep',
    type: 'single',
    title: 'С чего лучше начинать помощь в тяжёлый момент?',
    hint: '',
    placeholder: '',
    maxSelections: 1,
    options: ['Сначала успокоить', 'Сначала понять причину', 'Сразу предложить план шагов']
  },
  {
    id: 'personalNote',
    type: 'text',
    title: 'Личная заметка для Алмы',
    hint: 'Например: как лучше к тебе обращаться и чего лучше избегать в ответах.',
    placeholder: 'Напиши в свободной форме...',
    maxSelections: 1,
    options: []
  }
]);

const DEFAULT_ONBOARDING_PERSONALIZATION = Object.freeze({
  enabled: true,
  campaignVersion: 1,
  alertTitle: 'Сообщение от Алмы',
  alertMessage: 'Давай пройдём короткий персонализирующий тест, чтобы Алма поддерживала тебя точнее.',
  startButtonLabel: 'Пройти тест',
  laterButtonLabel: 'Позже',
  listHintText: 'Ты можешь пройти этот тест позже из списка чатов.',
  testCard: {
    title: 'Тест от Алмы',
    message: 'Короткий персонализирующий тест поможет Алме точнее поддерживать тебя.',
    route: '/personalization-test',
    primaryLabel: 'Пройти тест',
    secondaryLabel: 'Позже',
    imageUrl: ''
  },
  testQuestions: DEFAULT_ONBOARDING_TEST_QUESTIONS
});

const LEGACY_ENGLISH_TO_RUSSIAN = {
  alertTitle: {
    'message from alma': DEFAULT_ONBOARDING_PERSONALIZATION.alertTitle
  },
  alertMessage: {
    'let us run a short personalization test so alma can support you in a more accurate way.':
      DEFAULT_ONBOARDING_PERSONALIZATION.alertMessage
  },
  startButtonLabel: {
    'start test': DEFAULT_ONBOARDING_PERSONALIZATION.startButtonLabel
  },
  laterButtonLabel: {
    later: DEFAULT_ONBOARDING_PERSONALIZATION.laterButtonLabel
  },
  listHintText: {
    'you can finish this test later from the chat list.': DEFAULT_ONBOARDING_PERSONALIZATION.listHintText
  }
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

function normalizeBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeInt(value, fallback, min = 1, max = 99999) {
  const number = Number.parseInt(`${value ?? ''}`.trim(), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function isLikelyMojibake(value) {
  const text = `${value || ''}`.trim();
  if (!text) return false;
  if (/[ЃЌЋЎўџ]/u.test(text)) return true;
  const pairs = (text.match(/Р./g) || []).length + (text.match(/С./g) || []).length;
  return pairs >= Math.max(3, Math.floor(text.length / 4));
}

function normalizeLegacyText(value, field) {
  const next = `${value || ''}`.trim();
  if (!next) return next;
  const dictionary = LEGACY_ENGLISH_TO_RUSSIAN[field];
  if (!dictionary) return next;
  const key = next.toLowerCase();
  return dictionary[key] || next;
}

function normalizeText(value, fallback, maxLength = 240) {
  const next = `${value || ''}`.trim();
  if (!next) return fallback;
  if (isLikelyMojibake(next)) return fallback;
  return next.slice(0, maxLength);
}

function normalizeRoute(value, fallback = '/personalization-test') {
  const next = `${value || ''}`.trim();
  if (next.startsWith('/')) return next.slice(0, 200);
  return fallback;
}

function normalizeQuestionType(value, fallback = 'single') {
  const next = `${value || ''}`.trim().toLowerCase();
  if (next === 'single' || next === 'multi' || next === 'text') return next;
  return fallback;
}

function normalizeOptionsList(options, fallback = []) {
  const source = Array.isArray(options) ? options : [];
  const normalized = [];
  for (const item of source) {
    const text = `${item || ''}`.trim().slice(0, 120);
    if (!text || isLikelyMojibake(text)) continue;
    if (!normalized.includes(text)) normalized.push(text);
    if (normalized.length >= 10) break;
  }
  if (normalized.length) return normalized;
  return Array.isArray(fallback) ? fallback.map((item) => `${item}`).filter(Boolean).slice(0, 10) : [];
}

function normalizeQuestionDefinition(raw, fallback) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const base = fallback && typeof fallback === 'object' ? fallback : {};
  const type = normalizeQuestionType(source.type, normalizeQuestionType(base.type, 'single'));
  const defaultMaxSelections = type === 'multi' ? Math.max(2, Number(base.maxSelections) || 3) : 1;

  return {
    id: `${base.id || source.id || ''}`.trim().slice(0, 60),
    type,
    title: normalizeText(source.title, `${base.title || ''}`.trim(), 240),
    hint: normalizeText(source.hint, `${base.hint || ''}`.trim(), 240),
    placeholder: normalizeText(source.placeholder, `${base.placeholder || ''}`.trim(), 240),
    maxSelections: type === 'multi' ? normalizeInt(source.maxSelections, defaultMaxSelections, 2, 10) : 1,
    options: type === 'text' ? [] : normalizeOptionsList(source.options, base.options || [])
  };
}

function normalizeQuestions(raw) {
  const source = Array.isArray(raw) ? raw : [];
  const byId = new Map();
  for (const item of source) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = `${item.id || ''}`.trim();
    if (!id) continue;
    byId.set(id, item);
  }

  return DEFAULT_ONBOARDING_TEST_QUESTIONS.map((fallback) =>
    normalizeQuestionDefinition(byId.get(fallback.id) || fallback, fallback)
  );
}

function normalizeTestCard(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const defaults = DEFAULT_ONBOARDING_PERSONALIZATION.testCard;
  return {
    title: normalizeText(source.title, defaults.title, 180),
    message: normalizeText(source.message, defaults.message, 2000),
    route: normalizeRoute(source.route, defaults.route),
    primaryLabel: normalizeText(source.primaryLabel, defaults.primaryLabel, 80),
    secondaryLabel: normalizeText(source.secondaryLabel, defaults.secondaryLabel, 80),
    imageUrl: normalizeText(source.imageUrl, defaults.imageUrl, 2000)
  };
}

function normalizeOnboardingPersonalizationConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: normalizeBool(source.enabled, DEFAULT_ONBOARDING_PERSONALIZATION.enabled),
    campaignVersion: normalizeInt(source.campaignVersion, DEFAULT_ONBOARDING_PERSONALIZATION.campaignVersion, 1, 99999),
    alertTitle: normalizeText(
      normalizeLegacyText(source.alertTitle, 'alertTitle'),
      DEFAULT_ONBOARDING_PERSONALIZATION.alertTitle,
      120
    ),
    alertMessage: normalizeText(
      normalizeLegacyText(source.alertMessage, 'alertMessage'),
      DEFAULT_ONBOARDING_PERSONALIZATION.alertMessage,
      600
    ),
    startButtonLabel: normalizeText(
      normalizeLegacyText(source.startButtonLabel, 'startButtonLabel'),
      DEFAULT_ONBOARDING_PERSONALIZATION.startButtonLabel,
      60
    ),
    laterButtonLabel: normalizeText(
      normalizeLegacyText(source.laterButtonLabel, 'laterButtonLabel'),
      DEFAULT_ONBOARDING_PERSONALIZATION.laterButtonLabel,
      60
    ),
    listHintText: normalizeText(
      normalizeLegacyText(source.listHintText, 'listHintText'),
      DEFAULT_ONBOARDING_PERSONALIZATION.listHintText,
      200
    ),
    testCard: normalizeTestCard(source.testCard),
    testQuestions: normalizeQuestions(source.testQuestions)
  };
}

function getOnboardingPersonalizationConfig(featureFlagsJson) {
  const flags = parseFeatureFlags(featureFlagsJson);
  return normalizeOnboardingPersonalizationConfig(flags.onboardingPersonalization);
}

function withOnboardingPersonalizationConfig(featureFlagsJson, patch) {
  const flags = parseFeatureFlags(featureFlagsJson);
  const current = getOnboardingPersonalizationConfig(featureFlagsJson);
  const safePatch = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};

  const mergedSource = {
    ...current,
    ...safePatch,
    testCard: {
      ...current.testCard,
      ...(safePatch.testCard && typeof safePatch.testCard === 'object' && !Array.isArray(safePatch.testCard)
        ? safePatch.testCard
        : {})
    },
    testQuestions: Array.isArray(safePatch.testQuestions) ? safePatch.testQuestions : current.testQuestions
  };

  const merged = normalizeOnboardingPersonalizationConfig(mergedSource);
  const nextFlags = { ...flags, onboardingPersonalization: merged };

  return {
    featureFlags: nextFlags,
    featureFlagsJson: JSON.stringify(nextFlags),
    onboardingPersonalization: merged
  };
}

module.exports = {
  DEFAULT_ONBOARDING_PERSONALIZATION,
  DEFAULT_ONBOARDING_TEST_QUESTIONS,
  getOnboardingPersonalizationConfig,
  withOnboardingPersonalizationConfig,
  normalizeOnboardingPersonalizationConfig
};
