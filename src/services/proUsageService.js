const { prisma } = require('../config/prisma');
const { AppError } = require('../utils/errors');

const PRO_DAILY_FEATURE_KEYS = Object.freeze({
  IMAGE_ANALYZE: 'image_analyze',
  IMAGE_GENERATE: 'image_generate',
  IMAGE_EDIT: 'image_edit',
  VIDEO_GENERATE: 'video_generate',
  VOICE_MESSAGE: 'voice_message',
  VOICE_REALTIME: 'voice_realtime',
  FILE_ANALYZE: 'file_analyze'
});

const PRO_DAILY_LIMIT_FIELDS = Object.freeze({
  [PRO_DAILY_FEATURE_KEYS.IMAGE_ANALYZE]: 'maxImageAnalysesPerDay',
  [PRO_DAILY_FEATURE_KEYS.IMAGE_GENERATE]: 'maxImageGenerationsPerDay',
  [PRO_DAILY_FEATURE_KEYS.IMAGE_EDIT]: 'maxImageEditsPerDay',
  [PRO_DAILY_FEATURE_KEYS.VIDEO_GENERATE]: 'maxVideoGenerationsPerDay',
  [PRO_DAILY_FEATURE_KEYS.VOICE_MESSAGE]: 'maxVoiceMessagesPerDay',
  [PRO_DAILY_FEATURE_KEYS.VOICE_REALTIME]: 'maxVoiceRealtimeSessionsPerDay',
  [PRO_DAILY_FEATURE_KEYS.FILE_ANALYZE]: 'maxFileAnalysesPerDay'
});

const PRO_DAILY_LIMIT_META = Object.freeze({
  [PRO_DAILY_FEATURE_KEYS.IMAGE_ANALYZE]: {
    code: 'PRO_DAILY_LIMIT_IMAGE_ANALYZE',
    label: 'Image analysis'
  },
  [PRO_DAILY_FEATURE_KEYS.IMAGE_GENERATE]: {
    code: 'PRO_DAILY_LIMIT_IMAGE_GENERATE',
    label: 'Image generation'
  },
  [PRO_DAILY_FEATURE_KEYS.IMAGE_EDIT]: {
    code: 'PRO_DAILY_LIMIT_IMAGE_EDIT',
    label: 'Image editing'
  },
  [PRO_DAILY_FEATURE_KEYS.VIDEO_GENERATE]: {
    code: 'PRO_DAILY_LIMIT_VIDEO_GENERATE',
    label: 'Video generation'
  },
  [PRO_DAILY_FEATURE_KEYS.VOICE_MESSAGE]: {
    code: 'PRO_DAILY_LIMIT_VOICE_MESSAGE',
    label: 'Voice messages'
  },
  [PRO_DAILY_FEATURE_KEYS.VOICE_REALTIME]: {
    code: 'PRO_DAILY_LIMIT_VOICE_REALTIME',
    label: 'Realtime voice'
  },
  [PRO_DAILY_FEATURE_KEYS.FILE_ANALYZE]: {
    code: 'PRO_DAILY_LIMIT_FILE_ANALYZE',
    label: 'File analysis'
  }
});

let warnedMissingTable = false;
let warnedDatabaseLocked = false;

function isMissingProUsageTableError(error) {
  const code = `${error?.code || ''}`.trim().toUpperCase();
  if (code === 'P2021' || code === 'P2022') return true;
  const message = `${error?.message || ''}`.toLowerCase();
  return message.includes('prousagedaily') && (message.includes('does not exist') || message.includes('no such table'));
}

function isDatabaseLockedError(error) {
  const message = `${error?.message || ''}`.toLowerCase();
  return message.includes('database is locked');
}

function resolveUsageDayKey(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bishkek',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const normalized = formatter.format(date);
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  return `${date.toISOString()}`.slice(0, 10);
}

function clampDailyLimit(value, fallback, min = 1, max = 5000) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function resolveDailyLimitFromConfig(proConfig, featureKey, fallback = null) {
  const field = PRO_DAILY_LIMIT_FIELDS[featureKey];
  if (!field) return fallback;
  const limits = proConfig?.limits && typeof proConfig.limits === 'object' ? proConfig.limits : {};
  const defaultValue = Number.isFinite(Number(fallback)) ? Number(fallback) : null;
  return clampDailyLimit(limits[field], defaultValue, 1, 5000);
}

async function consumeDailyQuotaOrThrow({ userId, featureKey, limit, dayKey = resolveUsageDayKey() }) {
  const safeUserId = `${userId || ''}`.trim();
  const safeFeatureKey = `${featureKey || ''}`.trim();
  const numericLimit = Number(limit);

  if (!safeUserId || !safeFeatureKey || !Number.isFinite(numericLimit) || numericLimit <= 0) {
    return {
      dayKey,
      limit: Number.isFinite(numericLimit) && numericLimit > 0 ? Math.round(numericLimit) : null,
      used: null,
      remaining: null
    };
  }

  const safeLimit = Math.max(1, Math.round(numericLimit));
  const meta = PRO_DAILY_LIMIT_META[safeFeatureKey] || {
    code: 'PRO_DAILY_LIMIT_REACHED',
    label: 'Feature usage'
  };

  let usage;
  try {
    usage = await prisma.$transaction(async (tx) => {
      const existing = await tx.proUsageDaily.findUnique({
        where: {
          userId_feature_dayKey: {
            userId: safeUserId,
            feature: safeFeatureKey,
            dayKey
          }
        }
      });

      if (!existing) {
        return tx.proUsageDaily.create({
          data: {
            userId: safeUserId,
            feature: safeFeatureKey,
            dayKey,
            count: 1
          }
        });
      }

      if (existing.count >= safeLimit) {
        throw new AppError(429, `${meta.label} daily limit reached`, {
          code: meta.code,
          type: 'PRO_DAILY_LIMIT',
          featureKey: safeFeatureKey,
          dayKey,
          limit: safeLimit,
          used: existing.count,
          remaining: 0,
          label: meta.label
        });
      }

      return tx.proUsageDaily.update({
        where: { id: existing.id },
        data: {
          count: {
            increment: 1
          }
        }
      });
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (isMissingProUsageTableError(error)) {
      if (!warnedMissingTable) {
        warnedMissingTable = true;
        console.warn('[pro-usage] ProUsageDaily table is missing. Daily quota is temporarily skipped until migration is applied.');
      }
      return {
        dayKey,
        limit: safeLimit,
        used: null,
        remaining: null
      };
    }

    if (isDatabaseLockedError(error)) {
      if (!warnedDatabaseLocked) {
        warnedDatabaseLocked = true;
        console.warn('[pro-usage] SQLite database is locked. Daily quota check is temporarily skipped.');
      }
      return {
        dayKey,
        limit: safeLimit,
        used: null,
        remaining: null
      };
    }

    throw error;
  }

  const used = Number.isFinite(Number(usage?.count)) ? Number(usage.count) : 0;

  return {
    dayKey,
    limit: safeLimit,
    used,
    remaining: Math.max(0, safeLimit - used)
  };
}

module.exports = {
  PRO_DAILY_FEATURE_KEYS,
  PRO_DAILY_LIMIT_FIELDS,
  resolveUsageDayKey,
  resolveDailyLimitFromConfig,
  consumeDailyQuotaOrThrow
};
