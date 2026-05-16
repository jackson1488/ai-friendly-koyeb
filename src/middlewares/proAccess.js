const { prisma } = require('../config/prisma');
const { AppError } = require('../utils/errors');
const {
  getProConfig,
  hasProAccess,
  getEffectiveProConfigForUser,
  resolveProApiKey,
  resolveProApiKeys
} = require('../services/proConfigService');

/**
 * proAccess.js — middleware для PRO API.
 *
 * Здесь не генерируется ответ AI. Этот файл только отвечает на вопросы:
 * - включён ли PRO режим глобально;
 * - есть ли у пользователя доступ;
 * - какие PRO настройки действуют именно для этого пользователя;
 * - есть ли API keys для провайдера.
 */
async function loadProState(req, _res, next) {
  try {
    // AppConfig хранит featureFlagsJson — большой JSON с глобальными PRO настройками.
    // Из него proConfigService собирает нормальный объект конфигурации.
    const config = await prisma.appConfig.findUnique({
      where: { id: 1 },
      select: { featureFlagsJson: true }
    });
    if (!config) {
      return next(new AppError(404, 'Конфигурация приложения не найдена'));
    }

    const proConfig = getProConfig(config.featureFlagsJson);
    const apiKeys = resolveProApiKeys(proConfig);
    const apiKey = resolveProApiKey(proConfig);
    const accessAllowed = hasProAccess(req.user, proConfig);
    const effectiveProConfig = getEffectiveProConfigForUser(proConfig, req.user);

    // Кладём всё в req, чтобы каждый PRO controller не ходил в базу заново.
    req.proConfig = effectiveProConfig;
    req.proConfigGlobal = proConfig;
    req.proApiKeys = apiKeys;
    req.proApiKey = apiKey;
    req.proAccessAllowed = accessAllowed;
    next();
  } catch (error) {
    next(error);
  }
}

function requireProAccess(req, _res, next) {
  // requireProAccess должен идти после loadProState.
  if (!req.proConfig) {
    return next(
      new AppError(500, 'Состояние PRO не загружено', {
        type: 'PRO_UNAVAILABLE',
        code: 'PRO_STATE_NOT_LOADED'
      })
    );
  }

  if (!req.proConfig.enabled) {
    return next(
      new AppError(423, 'PRO режим отключён администратором', {
        type: 'PRO_UNAVAILABLE',
        code: 'PRO_DISABLED_GLOBAL'
      })
    );
  }

  if (!Array.isArray(req.proApiKeys) || req.proApiKeys.length === 0) {
    return next(
      new AppError(503, 'API ключ для PRO режима не настроен', {
        type: 'PRO_UNAVAILABLE',
        code: 'PRO_API_KEY_MISSING'
      })
    );
  }

  if (!req.proAccessAllowed) {
    return next(
      new AppError(403, 'Доступ к PRO режиму не выдан для этого пользователя', {
        type: 'PRO_ACCESS_REVOKED',
        code: 'PRO_ACCESS_DENIED'
      })
    );
  }

  next();
}

module.exports = {
  loadProState,
  requireProAccess
};
