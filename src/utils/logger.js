const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');

const logDir = path.dirname(env.logsPath);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

/**
 * logger.js — минимальный JSON logger.
 *
 * Он пишет каждую строку сразу в два места:
 * - файл logsPath, чтобы потом смотреть историю;
 * - stdout/stderr, чтобы видеть логи в терминале, Docker, hosting logs.
 */
function write(level, message, meta = {}) {
  // JSON Lines формат: одна строка = одно событие.
  // Это удобно для поиска, парсинга и отправки в внешние log-системы.
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...meta
  });
  fs.appendFile(env.logsPath, `${line}\n`, () => {});
  try {
    if (level === 'error') {
      process.stderr.write(`${line}\n`);
      return;
    }
    process.stdout.write(`${line}\n`);
  } catch (_error) {
    // Игнорируем ошибки канала вывода, если stdout/stderr недоступен.
  }
}

const logger = {
  // Три уровня достаточно для проекта:
  // info — нормальные события, warn — проблема без падения, error — серьёзная ошибка.
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta)
};

module.exports = { logger };
