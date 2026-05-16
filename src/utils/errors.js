/**
 * AppError — ошибка, которую backend сам ожидаемо создаёт.
 *
 * Пример:
 * throw new AppError(403, 'Нет доступа')
 *
 * errorHandler потом увидит statusCode и вернёт клиенту правильный HTTP статус,
 * а не общий 500.
 */
class AppError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

module.exports = { AppError };

