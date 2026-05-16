const { prisma } = require('../config/prisma');

const SUMMARY_DEDUP_WINDOW_MS = 30 * 60 * 1000;
const TOPIC_PLACEHOLDERS = new Set([
  'не указанная тема',
  'unspecified topic',
  'unknown topic',
  'n/a'
]);
const INSIGHT_PLACEHOLDERS = new Set([
  'пока без явного инсайта',
  'no clear insight yet',
  'n/a'
]);

function safeJsonParse(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function clampMood(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const rounded = Math.round(number);
  return Math.min(10, Math.max(1, rounded));
}

function uniqueStringArray(value, max = 6) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];

  for (const item of value) {
    const next = `${item || ''}`.trim();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    result.push(next);
    if (result.length >= max) break;
  }

  return result;
}

function normalizeSummaryPayload(raw) {
  const discussed = uniqueStringArray(raw?.discussed, 5);
  const techniques = uniqueStringArray(raw?.techniques, 6);
  const homeworkRaw = `${raw?.homework || ''}`.trim();

  return {
    topic: `${raw?.topic || ''}`.trim() || 'Не указанная тема',
    mood: clampMood(raw?.mood),
    discussed,
    insight: `${raw?.insight || ''}`.trim() || 'Пока без явного инсайта',
    techniques,
    homework: homeworkRaw || null
  };
}

function normalizeText(value) {
  return `${value || ''}`.trim().toLowerCase();
}

function isPlaceholderSummary(summary) {
  const hasNoSignals =
    summary.mood == null &&
    summary.discussed.length === 0 &&
    summary.techniques.length === 0 &&
    !`${summary.homework || ''}`.trim();

  if (!hasNoSignals) return false;

  const topic = normalizeText(summary.topic);
  const insight = normalizeText(summary.insight);
  const topicLooksPlaceholder = TOPIC_PLACEHOLDERS.has(topic);
  const insightLooksPlaceholder = INSIGHT_PLACEHOLDERS.has(insight);
  return topicLooksPlaceholder || insightLooksPlaceholder;
}

function buildSummaryKey(summary) {
  return JSON.stringify({
    topic: normalizeText(summary.topic),
    mood: summary.mood == null ? null : Number(summary.mood),
    discussed: summary.discussed.map((item) => normalizeText(item)),
    insight: normalizeText(summary.insight),
    techniques: summary.techniques.map((item) => normalizeText(item)),
    homework: normalizeText(summary.homework) || null
  });
}

async function cleanupSessionSummaries({ dryRun = false } = {}) {
  const rows = await prisma.sessionSummary.findMany({
    where: { deletedAt: null },
    orderBy: [{ userId: 'asc' }, { chatId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      userId: true,
      chatId: true,
      summary: true,
      createdAt: true
    }
  });

  const placeholderIds = [];
  const duplicateIds = [];
  const lastSeenByKey = new Map();

  for (const row of rows) {
    const parsed = safeJsonParse(row.summary, {});
    const normalized = normalizeSummaryPayload(parsed);

    if (isPlaceholderSummary(normalized)) {
      placeholderIds.push(row.id);
      continue;
    }

    const key = `${row.userId}|${row.chatId || 'null'}|${buildSummaryKey(normalized)}`;
    const currentTime = row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt).getTime();
    const previous = lastSeenByKey.get(key);
    if (Number.isFinite(previous) && currentTime - previous <= SUMMARY_DEDUP_WINDOW_MS) {
      duplicateIds.push(row.id);
      continue;
    }
    lastSeenByKey.set(key, currentTime);
  }

  const toDelete = [...new Set([...placeholderIds, ...duplicateIds])];
  let updated = 0;

  if (!dryRun && toDelete.length) {
    const now = new Date();
    const chunkSize = 300;
    for (let index = 0; index < toDelete.length; index += chunkSize) {
      const ids = toDelete.slice(index, index + chunkSize);
      const result = await prisma.sessionSummary.updateMany({
        where: { id: { in: ids }, deletedAt: null },
        data: { deletedAt: now }
      });
      updated += Number(result?.count || 0);
    }
  }

  return {
    scanned: rows.length,
    placeholders: placeholderIds.length,
    duplicates: duplicateIds.length,
    markedDeleted: dryRun ? 0 : updated,
    toDelete: toDelete.length
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  try {
    const result = await cleanupSessionSummaries({ dryRun });
    console.log(
      `[session-summary-cleanup] ${dryRun ? 'DRY RUN' : 'APPLIED'}: ${JSON.stringify(result)}`
    );
  } catch (error) {
    console.error('[session-summary-cleanup] Failed:', error?.stack || error?.message || error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
