const http = require('http');
const { Server } = require('socket.io');
const cron = require('node-cron');
require('./config/zod');
const { createApp } = require('./app');
const { env } = require('./config/env');
const { corsOrigin } = require('./config/cors');
const { seedDefaults } = require('./services/seedService');
const { parseModels } = require('./services/modelParserService');
const { scheduleDailyDbBackup } = require('./services/dbBackupService');
const { purgeExpiredSoftDeletedUsers, ACCOUNT_DELETION_RETENTION_DAYS } = require('./services/deletionService');
const { registerChatSocket } = require('./socket/chatSocket');
const { registerAnonSupportSocket } = require('./socket/anonSupportSocket');
const { registerAdminModerationSocket } = require('./socket/adminModerationSocket');
const { registerProVoiceRealtimeSocket } = require('./socket/proVoiceRealtimeSocket');
const { setIo } = require('./socket/io');
const { logger } = require('./utils/logger');
const { prisma } = require('./config/prisma');
const { publishDueInboxItems } = require('./services/inboxService');
const { processPendingInboxPushes } = require('./services/inboxPushService');

/**
 * server.js — главный runtime-файл backend.
 *
 * Если объяснять совсем просто:
 * - app.js собирает Express-приложение;
 * - server.js запускает это приложение на порту;
 * - здесь же подключается Socket.IO;
 * - здесь же запускаются фоновые задачи по cron;
 * - здесь же корректно закрываются сервер, сокеты и Prisma при остановке процесса.
 */
async function runModelParserSafe(source) {
  // Модели провайдеров могут появляться/исчезать. Эта задача обновляет таблицу
  // AvailableModel, но не должна ронять весь сервер, если внешний API временно упал.
  try {
    const result = await parseModels();
    logger.info('Список моделей обновлен', {
      source,
      found: result.found,
      added: result.added,
      removed: result.removed
    });
  } catch (error) {
    logger.warn('Не удалось обновить список моделей', {
      source,
      error: error.message
    });
  }
}

async function runSoftDeletePurgeSafe(source) {
  // Soft-delete аккаунт отключается сразу, но физически удаляется позже.
  // Этот wrapper запускает чистку и логирует результат, не убивая процесс при ошибке.
  try {
    const result = await purgeExpiredSoftDeletedUsers({
      retentionDays: ACCOUNT_DELETION_RETENTION_DAYS,
      limit: 100
    });
    logger.info('Очистка soft-delete аккаунтов завершена', {
      source,
      retentionDays: ACCOUNT_DELETION_RETENTION_DAYS,
      scanned: result.scanned,
      purged: result.purged,
      failed: result.failed
    });
  } catch (error) {
    logger.warn('Не удалось выполнить очистку soft-delete аккаунтов', {
      source,
      error: error.message
    });
  }
}

async function runInboxSchedulerSafe(source) {
  // Inbox items могут быть запланированы на будущее. Scheduler каждую минуту
  // публикует то, у чего scheduledAt уже наступил.
  try {
    const result = await publishDueInboxItems({ limit: 200 });
    if (result.published > 0) {
      logger.info('Inbox scheduler published due items', {
        source,
        published: result.published,
        scanned: result.scanned
      });
    }
  } catch (error) {
    logger.warn('Inbox scheduler failed', {
      source,
      error: error.message
    });
  }
}

async function runInboxPushWorkerSafe(source) {
  // Socket доставляет уведомление только онлайн-пользователю. Push worker нужен
  // для оффлайн-доставки и retry, если телефон/Expo push endpoint временно недоступен.
  try {
    const result = await processPendingInboxPushes({ limit: 150 });
    if (result.sent > 0 || result.failed > 0) {
      logger.info('Inbox push worker processed pending deliveries', {
        source,
        scanned: result.scanned,
        sent: result.sent,
        failed: result.failed
      });
    }
  } catch (error) {
    logger.warn('Inbox push worker failed', {
      source,
      error: error.message
    });
  }
}

async function bootstrap() {
  /**
   * Быстрая проверка, что Prisma Client соответствует текущей schema.prisma.
   *
   * Если после миграции забыть `npx prisma generate`, в runtime может не быть новых
   * моделей. Лучше упасть сразу на старте с понятной ошибкой, чем ловить странные
   * undefined в середине запроса.
   */
  if (!prisma.proChat) {
    throw new Error(
      'Prisma client is out of date: model ProChat is missing. Run: npx prisma generate'
    );
  }

  /**
   * Стартовые задачи выполняются до открытия порта.
   *
   * Порядок такой:
   * 1. seedDefaults создаёт/обновляет базовые настройки, admin, modes, levels;
   * 2. model parser обновляет список моделей;
   * 3. soft-delete purge убирает аккаунты после retention;
   * 4. inbox scheduler публикует просроченные scheduled карточки;
   * 5. push worker пробует доставить накопившиеся pending push.
   */
  await seedDefaults();
  await runModelParserSafe('startup');
  await runSoftDeletePurgeSafe('startup');
  await runInboxSchedulerSafe('startup');
  await runInboxPushWorkerSafe('startup');

  const app = createApp();
  const server = http.createServer(app);

  /**
   * Socket.IO живёт на том же HTTP server, что и Express.
   *
   * pingInterval/pingTimeout важны для мобильной сети: телефон может коротко терять
   * интернет, переключаться между Wi-Fi/LTE или уходить в background. Слишком маленькие
   * значения будут часто рвать соединение, слишком большие будут долго держать мёртвые
   * сокеты.
   */
  const io = new Server(server, {
    cors: {
      origin: corsOrigin,
      credentials: true
    },
    pingInterval: 25000,
    pingTimeout: 30000
  });

  // setIo кладёт instance в общий holder. Так сервисы вне socket handlers могут
  // отправлять события пользователю, например admin revoke PRO или inbox delivery.
  setIo(io);

  /**
   * Регистрация realtime-модулей.
   *
   * Каждый модуль сам подписывается на `io.on('connection')` и добавляет свои события:
   * - обычный AI chat;
   * - anonymous support;
   * - admin moderation;
   * - PRO voice realtime.
   */
  registerChatSocket(io);
  registerAnonSupportSocket(io);
  registerAdminModerationSocket(io);
  registerProVoiceRealtimeSocket(io);

  /**
   * Cron-задачи.
   *
   * Важно: каждая cron callback вызывает safe-wrapper и гасит unhandled rejection.
   * Если этого не сделать, одна ошибка внешнего API/SQLite может завершить весь Node.js
   * процесс.
   */
  const modelsCronTask = cron.schedule('0 */6 * * *', () => {
    runModelParserSafe('cron-6h').catch(() => undefined);
  });
  const softDeletePurgeTask = cron.schedule('30 2 * * *', () => {
    runSoftDeletePurgeSafe('cron-daily').catch(() => undefined);
  });
  const inboxSchedulerTask = cron.schedule('* * * * *', () => {
    runInboxSchedulerSafe('cron-1m').catch(() => undefined);
  });
  const inboxPushWorkerTask = cron.schedule('* * * * *', () => {
    runInboxPushWorkerSafe('cron-1m').catch(() => undefined);
  });
  const dbBackupTask = scheduleDailyDbBackup();

  // Только после seed/socket/cron открываем порт. Так клиент не попадёт в полусобранный
  // backend, где REST уже отвечает, а socket или config ещё не готовы.
  server.listen(env.port, () => {
    logger.info('Сервер запущен', { port: env.port });
  });

  /**
   * Корректная остановка процесса.
   *
   * Без graceful shutdown можно получить:
   * - незакрытый Prisma connection;
   * - оборванные socket-соединения без нормального disconnect;
   * - cron-задачу, которая продолжит работать во время остановки.
   */
  const shutdown = async () => {
    logger.info('Остановка сервера');
    modelsCronTask.stop();
    softDeletePurgeTask.stop();
    inboxSchedulerTask.stop();
    inboxPushWorkerTask.stop();
    if (dbBackupTask) dbBackupTask.stop();
    io.close();
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch(async (error) => {
  logger.error('Ошибка инициализации сервера', { error: error.message, stack: error.stack });
  await prisma.$disconnect();
  process.exit(1);
});
