const crypto = require('crypto');

const SUPPORT_BLOCK_PATTERNS = [
  {
    category: 'self_harm_encouragement',
    reason: 'Подстрекательство к самоповреждению запрещено',
    regex: /(убей\s*себя|повесься|порежь\s*себя|лучше\s*умереть|сдохни)/i
  },
  {
    category: 'harassment',
    reason: 'Оскорбления и унижение запрещены',
    regex: /(ты\s*никчем|ничтожество|тварь|мразь|ненавижу\s*тебя)/i
  },
  {
    category: 'anti_support',
    reason: 'Демотивирующие фразы нарушают правила поддержки',
    regex: /(все\s*безнадежно|тебе\s*не\s*поможет|ничего\s*не\s*изменится)/i
  },
  {
    category: 'privacy_violation',
    reason: 'Запрос личных данных запрещен',
    regex: /(где\s*ты\s*живешь|дай\s*адрес|скажи\s*город|твое\s*настоящее\s*имя)/i
  }
];

const CRISIS_PATTERNS = [
  /не\s*хочу\s*жить/i,
  /хочу\s*умереть/i,
  /покончить\s*с\s*собой/i,
  /суицид/i,
  /убить\s*себя/i,
  /хочу\s*исчезнуть/i,
  /өлгүм\s*келет/i,
  /жашагым\s*жок/i
];

const reportsMemoryStore = [];

function normalizeSupportText(text) {
  return `${text || ''}`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

function matchPattern(text, patterns) {
  for (const pattern of patterns) {
    if (pattern.regex.test(text)) {
      return pattern;
    }
  }
  return null;
}

function moderateAnonText(text) {
  const normalizedText = normalizeSupportText(text);
  if (!normalizedText) {
    return {
      normalizedText: '',
      flagged: true,
      category: 'empty_message',
      reason: 'Пустое сообщение не отправляется',
      crisisDetected: false
    };
  }

  const violation = matchPattern(normalizedText, SUPPORT_BLOCK_PATTERNS);
  const crisisDetected = CRISIS_PATTERNS.some((pattern) => pattern.test(normalizedText));

  if (violation) {
    return {
      normalizedText,
      flagged: true,
      category: violation.category,
      reason: violation.reason,
      crisisDetected
    };
  }

  return {
    normalizedText,
    flagged: false,
    category: null,
    reason: null,
    crisisDetected
  };
}

function saveAnonReport({ reporterId, sessionId, messageId, reason }) {
  const report = {
    id: crypto.randomUUID(),
    reporterId,
    sessionId,
    messageId,
    reason: `${reason || 'Без категории'}`.trim().slice(0, 240),
    createdAt: new Date().toISOString()
  };

  reportsMemoryStore.push(report);

  if (reportsMemoryStore.length > 1000) {
    reportsMemoryStore.splice(0, reportsMemoryStore.length - 1000);
  }

  return report;
}

module.exports = {
  moderateAnonText,
  saveAnonReport
};
