const { AppError } = require('../utils/errors');

/**
 * validate.js — маленькая обёртка вокруг Zod.
 *
 * Пример:
 * router.post('/login', validate(loginSchema), login)
 *
 * Это значит: сначала проверяем req.body по schema, и только потом пускаем
 * запрос в controller. Controller получает уже очищенные и нормализованные данные.
 */
function validate(schema, source = 'body') {
  return (req, _res, next) => {
    // source может быть body, query или params.
    // safeParse не бросает исключение, а возвращает объект success/error.
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(new AppError(400, 'Ошибка валидации', result.error.flatten()));
    }

    // Важно: заменяем исходные данные на result.data.
    // Так дальше по цепочке нет лишних полей и типы уже приведены Zod-ом.
    req[source] = result.data;
    next();
  };
}

module.exports = { validate };
