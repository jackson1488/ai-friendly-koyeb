const { AppError } = require('../utils/errors');
const multer = require('multer');
const { logger } = require('../utils/logger');

/**
 * errorHandler.js — единая точка, где ошибка превращается в HTTP-ответ.
 *
 * Зачем это нужно:
 * - controller/service может просто `throw new AppError(...)`;
 * - asyncHandler или middleware передаст ошибку сюда через `next(error)`;
 * - клиент всегда получит одинаковый JSON `{ error: { message, details } }`;
 * - серверные 500 ошибки попадут в лог.
 */

function notFoundHandler(_req, _res, next) {
  // Если ни один route не совпал, Express доходит сюда.
  next(new AppError(404, 'Маршрут не найден'));
}

function errorHandler(err, req, res, _next) {
  // ZodError — ошибка проверки входящих данных.
  // MulterError — ошибка загрузки файлов.
  // AvatarTypeError — обычная Error из upload filter, но мы знаем, что это 400.
  const isZodError = err?.name === 'ZodError';
  const isMulterError = err instanceof multer.MulterError;
  const isAvatarTypeError = typeof err?.message === 'string' && err.message.includes('JPEG/PNG/WEBP');

  let status = err.statusCode || (isZodError ? 400 : 500);
  // statusCode из AppError имеет приоритет. Если его нет, определяем статус
  // по типу ошибки. Всё неизвестное считаем 500.
  if (!err.statusCode && isMulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  } else if (!err.statusCode && isAvatarTypeError) {
    status = 400;
  }
  const details = err.details || (isZodError ? err.flatten?.() || err.issues : null);
  const message = isZodError
    ? 'Ошибка валидации данных'
    : err.message || 'Внутренняя ошибка сервера';

  // 500 — проблема сервера, логируем как error со stack.
  // 4xx — проблема запроса/доступа, логируем как warn без лишнего шума.
  if (status >= 500) {
    logger.error(message, {
      path: req.originalUrl,
      method: req.method,
      stack: err.stack
    });
  } else {
    logger.warn(message, {
      path: req.originalUrl,
      method: req.method,
      details
    });
  }

  // Не отдаём stack клиенту. Stack нужен в логах, но не в приложении.
  res.status(status).json({
    error: {
      message,
      details
    }
  });
}

module.exports = { notFoundHandler, errorHandler };


