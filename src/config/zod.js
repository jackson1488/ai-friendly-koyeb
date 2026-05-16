const { z, ZodIssueCode } = require('zod');

/**
 * zod.js — глобальные русские ошибки валидации.
 *
 * Этот файл импортируется один раз при старте сервера в server.js.
 * После `z.setErrorMap(...)` все Zod-схемы в проекте начинают отдавать
 * человекочитаемые русские сообщения вместо стандартных английских.
 */

const typeLabel = {
  string: 'строка',
  number: 'число',
  integer: 'целое число',
  float: 'число',
  boolean: 'логическое значение',
  bigint: 'большое целое число',
  date: 'дата',
  object: 'объект',
  array: 'массив',
  function: 'функция',
  undefined: 'значение',
  null: 'значение'
};

function getReadableType(type) {
  // Zod отдаёт технический тип, например "string".
  // Пользователь должен видеть нормальный текст: "строка".
  return typeLabel[type] || 'значение';
}

function pluralize(n, one, few, many) {
  // Русское склонение: 1 символ, 2 символа, 5 символов.
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

z.setErrorMap((issue, ctx) => {
  // ErrorMap вызывается каждый раз, когда Zod нашёл ошибку.
  // По issue.code понимаем тип проблемы и возвращаем понятное сообщение.
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === 'undefined') {
        return { message: 'Обязательное поле' };
      }
      return {
        message: `Ожидается тип "${getReadableType(issue.expected)}"`
      };
    case ZodIssueCode.invalid_literal:
      return { message: 'Недопустимое значение поля' };
    case ZodIssueCode.unrecognized_keys:
      return { message: 'Переданы лишние поля' };
    case ZodIssueCode.invalid_enum_value:
      return {
        message: `Недопустимое значение. Допустимые значения: ${issue.options.join(', ')}`
      };
    case ZodIssueCode.invalid_string:
      if (issue.validation === 'regex') {
        return { message: 'Некорректный формат строки' };
      }
      if (issue.validation === 'email') {
        return { message: 'Некорректный формат email' };
      }
      return { message: 'Некорректный формат строки' };
    case ZodIssueCode.too_small:
      if (issue.type === 'string') {
        const symbolWord = pluralize(issue.minimum, 'символ', 'символа', 'символов');
        return {
          message: issue.exact
            ? `Строка должна содержать ровно ${issue.minimum} ${symbolWord}`
            : `Строка должна содержать минимум ${issue.minimum} ${symbolWord}`
        };
      }
      if (issue.type === 'array') {
        const itemWord = pluralize(issue.minimum, 'элемент', 'элемента', 'элементов');
        return {
          message: issue.exact
            ? `Список должен содержать ровно ${issue.minimum} ${itemWord}`
            : `Список должен содержать минимум ${issue.minimum} ${itemWord}`
        };
      }
      if (issue.type === 'number') {
        return {
          message: issue.exact
            ? `Значение должно быть равно ${issue.minimum}`
            : `Значение должно быть не меньше ${issue.minimum}`
        };
      }
      return { message: 'Значение меньше допустимого' };
    case ZodIssueCode.too_big:
      if (issue.type === 'string') {
        const symbolWord = pluralize(issue.maximum, 'символ', 'символа', 'символов');
        return {
          message: issue.exact
            ? `Строка должна содержать ровно ${issue.maximum} ${symbolWord}`
            : `Строка должна содержать не более ${issue.maximum} ${symbolWord}`
        };
      }
      if (issue.type === 'array') {
        const itemWord = pluralize(issue.maximum, 'элемент', 'элемента', 'элементов');
        return {
          message: issue.exact
            ? `Список должен содержать ровно ${issue.maximum} ${itemWord}`
            : `Список должен содержать не более ${issue.maximum} ${itemWord}`
        };
      }
      if (issue.type === 'number') {
        return {
          message: issue.exact
            ? `Значение должно быть равно ${issue.maximum}`
            : `Значение должно быть не больше ${issue.maximum}`
        };
      }
      return { message: 'Значение больше допустимого' };
    case ZodIssueCode.invalid_date:
      return { message: 'Некорректная дата' };
    case ZodIssueCode.custom:
      return { message: ctx.defaultError || 'Некорректные данные' };
    default:
      return { message: ctx.defaultError || 'Некорректные данные' };
  }
});
