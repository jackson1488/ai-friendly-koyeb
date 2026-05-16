const { crisisContactsByRegion } = require('../config/constants');

const HIGH_SEVERITY_PATTERNS = [
  { type: 'suicidal_ideation', regex: /не\s*хочу\s*жить/i },
  { type: 'suicidal_ideation', regex: /хочу\s*умереть/i },
  { type: 'suicidal_ideation', regex: /покончить\s*с\s*собой/i },
  { type: 'suicidal_ideation', regex: /суицид/i },
  { type: 'suicidal_ideation', regex: /убить\s*себя/i },
  { type: 'suicidal_ideation', regex: /нет\s*смысла\s*жить/i },
  { type: 'suicidal_ideation', regex: /последний\s*раз/i },
  { type: 'suicidal_ideation', regex: /прощайте/i },
  { type: 'suicidal_ideation', regex: /всем\s*будет\s*лучше\s*без\s*меня/i },
  { type: 'suicidal_ideation', regex: /я\s*устал\s*жить/i },
  { type: 'suicidal_ideation', regex: /хочу\s*исчезнуть\s*навсегда/i }
];

const MEDIUM_SEVERITY_PATTERNS = [
  { type: 'emotional_distress', regex: /всё\s*бессмысленно/i },
  { type: 'emotional_distress', regex: /не\s*вижу\s*выхода/i },
  { type: 'emotional_distress', regex: /очень\s*плохо/i },
  { type: 'emotional_distress', regex: /невыносимо/i },
  { type: 'emotional_distress', regex: /сил\s*больше\s*нет/i },
  { type: 'emotional_distress', regex: /хочу\s*всё\s*бросить/i },
  { type: 'emotional_distress', regex: /никому\s*не\s*нужен/i },
  { type: 'emotional_distress', regex: /нет\s*надежды/i }
];

const LOW_SEVERITY_PATTERNS = [
  { type: 'low_mood', regex: /грустно/i },
  { type: 'low_mood', regex: /депресс(ия|ив)/i },
  { type: 'low_mood', regex: /тревог(а|и|у|ой|е)/i },
  { type: 'low_mood', regex: /паник(а|и|у|ой|е)/i },
  { type: 'low_mood', regex: /не\s*могу\s*спать/i },
  { type: 'low_mood', regex: /плачу/i }
];

function findPattern(text, patterns) {
  for (const pattern of patterns) {
    if (pattern.regex.test(text)) {
      return pattern;
    }
  }
  return null;
}

function detectCrisis(text) {
  const normalized = `${text || ''}`.trim();
  if (!normalized) {
    return {
      detected: false,
      severity: null,
      triggerType: null,
      snippet: ''
    };
  }

  const high = findPattern(normalized, HIGH_SEVERITY_PATTERNS);
  if (high) {
    return {
      detected: true,
      severity: 'high',
      triggerType: high.type,
      snippet: normalized.slice(0, 300)
    };
  }

  const medium = findPattern(normalized, MEDIUM_SEVERITY_PATTERNS);
  if (medium) {
    return {
      detected: true,
      severity: 'medium',
      triggerType: medium.type,
      snippet: normalized.slice(0, 300)
    };
  }

  const low = findPattern(normalized, LOW_SEVERITY_PATTERNS);
  if (low) {
    return {
      detected: true,
      severity: 'low',
      triggerType: low.type,
      snippet: normalized.slice(0, 300)
    };
  }

  return {
    detected: false,
    severity: null,
    triggerType: null,
    snippet: ''
  };
}

function buildDeEscalationResponse(region = 'KG') {
  const contacts = crisisContactsByRegion[region] || crisisContactsByRegion.KG;
  const text = [
    'Спасибо, что написали об этом. Сейчас самое важное — ваша безопасность.',
    'Если есть риск причинить себе вред, пожалуйста, сразу позвоните 112.',
    'Также можно обратиться на телефон доверия 111. При физическом ухудшении звоните 103.',
    'Попробуйте заземление 5-4-3-2-1: назовите 5 вещей, которые видите, 4 звука, которые слышите, 3 предмета, к которым можно прикоснуться.',
    'Дыхание 4-7-8: вдох на 4 счета, задержка на 7, выдох на 8. Повторите 4 раза.',
    'Пожалуйста, свяжитесь с близким человеком и не оставайтесь сейчас в одиночестве.'
  ].join(' ');

  return { text, contacts };
}

module.exports = {
  detectCrisis,
  buildDeEscalationResponse
};

