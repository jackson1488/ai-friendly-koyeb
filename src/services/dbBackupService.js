const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { env } = require('../config/env');
const { logger } = require('../utils/logger');

function formatDatePart(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function formatYearPart(date) {
  return String(date.getFullYear());
}

function formatMonthPartRu(date) {
  const monthsRu = [
    'январь',
    'февраль',
    'март',
    'апрель',
    'май',
    'июнь',
    'июль',
    'август',
    'сентябрь',
    'октябрь',
    'ноябрь',
    'декабрь'
  ];
  const monthIndex = date.getMonth();
  const monthNum = String(monthIndex + 1).padStart(2, '0');
  const monthName = monthsRu[monthIndex] || 'месяц';
  return `${monthNum}_${monthName}`;
}

function formatDayPart(date) {
  return String(date.getDate()).padStart(2, '0');
}

function formatTimePart(date) {
  return [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0')
  ].join('-');
}

function isFileUrl(databaseUrl) {
  return typeof databaseUrl === 'string' && databaseUrl.toLowerCase().startsWith('file:');
}

function resolveSqliteDbPath(databaseUrl) {
  const raw = String(databaseUrl || '').replace(/^file:/i, '');
  if (!raw) return null;

  const normalized = raw.split('?')[0].split('#')[0];
  if (!normalized) return null;

  if (path.isAbsolute(normalized)) {
    return path.normalize(normalized);
  }

  const backendRoot = path.resolve(__dirname, '..', '..');
  return path.resolve(backendRoot, 'prisma', normalized);
}

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function copyIfExists(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) return false;
  await fs.promises.copyFile(sourcePath, targetPath);
  return true;
}

function parseDirDate(dirName) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dirName);
  if (!match) return null;
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setHours(0, 0, 0, 0);
  return parsed;
}

async function cleanupOldBackups(baseDir, keepDays) {
  if (!Number.isFinite(keepDays) || keepDays <= 0) return;
  if (!fs.existsSync(baseDir)) return;

  const threshold = new Date();
  threshold.setHours(0, 0, 0, 0);
  threshold.setDate(threshold.getDate() - keepDays);

  const entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const parsed = parseDirDate(entry.name);
    if (!parsed) continue;
    if (parsed >= threshold) continue;

    const fullPath = path.join(baseDir, entry.name);
    await fs.promises.rm(fullPath, { recursive: true, force: true });
    logger.info('Удален старый бэкап БД', { dir: fullPath });
  }
}

async function runDailyDbBackup() {
  if (!isFileUrl(env.databaseUrl)) {
    logger.warn('Ежедневный бэкап БД пропущен: DATABASE_URL не SQLite file:', {
      databaseUrl: env.databaseUrl
    });
    return null;
  }

  const dbPath = resolveSqliteDbPath(env.databaseUrl);
  if (!dbPath || !fs.existsSync(dbPath)) {
    logger.warn('Ежедневный бэкап БД пропущен: файл SQLite не найден', { dbPath });
    return null;
  }

  const now = new Date();
  const yearFolder = formatYearPart(now);
  const monthFolder = formatMonthPartRu(now);
  const dayFolder = formatDayPart(now);
  const timePart = formatTimePart(now);
  const baseName = path.basename(dbPath, path.extname(dbPath));

  const backupDayDir = path.join(env.dbBackupDir, yearFolder, monthFolder, dayFolder);
  await ensureDir(backupDayDir);

  const dbTarget = path.join(backupDayDir, `${baseName}_${timePart}.db`);
  await fs.promises.copyFile(dbPath, dbTarget);

  const copiedWal = await copyIfExists(`${dbPath}-wal`, `${dbTarget}-wal`);
  const copiedShm = await copyIfExists(`${dbPath}-shm`, `${dbTarget}-shm`);

  if (Number.isFinite(env.dbBackupKeepDays) && env.dbBackupKeepDays > 0) {
    await cleanupOldBackups(env.dbBackupDir, env.dbBackupKeepDays);
  }

  logger.info('Ежедневный бэкап БД создан', {
    dbPath,
    backupFile: dbTarget,
    copiedWal,
    copiedShm,
    backupDir: backupDayDir,
    keepDays: env.dbBackupKeepDays
  });

  return {
    dbPath,
    backupFile: dbTarget,
    copiedWal,
    copiedShm,
    backupDir: backupDayDir
  };
}

function scheduleDailyDbBackup() {
  if (!env.dbBackupEnabled) {
    logger.info('Ежедневный бэкап БД выключен через DB_BACKUP_ENABLED=false');
    return null;
  }

  if (!isFileUrl(env.databaseUrl)) {
    logger.warn('Планировщик бэкапа БД не запущен: DATABASE_URL не SQLite file:', {
      databaseUrl: env.databaseUrl
    });
    return null;
  }

  if (!cron.validate(env.dbBackupCron)) {
    logger.warn('Планировщик бэкапа БД не запущен: некорректный cron', {
      dbBackupCron: env.dbBackupCron
    });
    return null;
  }

  const task = cron.schedule(
    env.dbBackupCron,
    () => {
      runDailyDbBackup().catch((error) => {
        logger.error('Ошибка ежедневного бэкапа БД', {
          error: error.message
        });
      });
    },
    {
      timezone: env.dbBackupTimezone
    }
  );

  logger.info('Планировщик ежедневного бэкапа БД запущен', {
    cron: env.dbBackupCron,
    timezone: env.dbBackupTimezone,
    backupDir: env.dbBackupDir,
    keepDays: env.dbBackupKeepDays
  });

  return task;
}

module.exports = {
  runDailyDbBackup,
  scheduleDailyDbBackup
};
