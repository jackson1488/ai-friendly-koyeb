const { prisma } = require('../config/prisma');
const { verifyToken } = require('../utils/jwt');
const { AppError } = require('../utils/errors');
const { serializeBan, syncGlobalBlockState } = require('../services/banService');

/**
 * auth.js — главный охранник API.
 *
 * Простыми словами:
 * - клиент присылает JWT access token в заголовке Authorization;
 * - middleware проверяет подпись токена;
 * - находит пользователя в базе;
 * - проверяет, что аккаунт не удалён, не заблокирован и сессия ещё живая;
 * - кладёт пользователя в `req.user`, чтобы controller дальше не искал его заново.
 */

function extractBearerToken(headerValue) {
  // Authorization должен выглядеть строго так: "Bearer <token>".
  // Если формат другой, считаем, что токена нет.
  if (!headerValue) return null;
  const [scheme, token] = headerValue.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

async function requireAuth(req, _res, next) {
  // Этот middleware ставится на защищённые API routes.
  // Без него req.user не появится, а controller не поймёт, кто сделал запрос.
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    return next(new AppError(401, 'Отсутствует токен авторизации'));
  }

  try {
    // verifyToken не ходит в базу. Он только проверяет, что JWT настоящий
    // и не просрочен. После этого всё равно нужно свериться с базой.
    const payload = verifyToken(token);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      return next(new AppError(401, 'Пользователь не найден'));
    }
    if (user.isDeleted) {
      return next(
        new AppError(423, 'Ваш аккаунт помечен как удаленный. Напишите в поддержку для восстановления.')
      );
    }

    // Глобальный бан может протухнуть или измениться. syncGlobalBlockState
    // приводит состояние пользователя и активного бана к актуальному виду.
    const globalAccess = await syncGlobalBlockState(user);
    if (globalAccess.isGloballyBlocked) {
      return next(
        new AppError(423, 'Вы заблокированы. Обратитесь в поддержку.', {
          scope: 'GLOBAL',
          timezone: 'Asia/Bishkek',
          ban: serializeBan(globalAccess.activeGlobalBan),
          reason: globalAccess.activeGlobalBan?.reason || 'Нарушение правил'
        })
      );
    }
    const effectiveUser = globalAccess.user || user;

    // sessionVersion — простой способ убить все старые access token пользователя.
    // Например: админ сбросил сессии, пользователь сменил пароль, аккаунт забанен.
    // Тогда в базе версия меняется, а старый токен перестаёт совпадать.
    const tokenSessionVersion = Number.isFinite(Number(payload?.sv)) ? Number(payload.sv) : 0;
    const userSessionVersion = Number.isFinite(Number(effectiveUser.sessionVersion))
      ? Number(effectiveUser.sessionVersion)
      : 0;
    if (tokenSessionVersion !== userSessionVersion) {
      return next(new AppError(401, 'Сессия завершена. Войдите снова'));
    }

    const tokenSessionId = `${payload?.sid || ''}`.trim();
    if (tokenSessionId) {
      // sid связывает access token с refreshToken-сессией в базе.
      // Это позволяет завершить конкретное устройство, а не только все токены сразу.
      const session = await prisma.refreshToken.findFirst({
        where: {
          id: tokenSessionId,
          userId: effectiveUser.id,
          expiresAt: { gt: new Date() }
        }
      });

      if (!session) {
        return next(new AppError(401, 'Сессия завершена. Войдите снова'));
      }

      req.authSession = session;
      // lastSeenAt обновляется фоном. Если обновление не получилось, запрос
      // пользователя всё равно должен пройти: это статистика, а не критичная логика.
      prisma.refreshToken
        .update({
          where: { id: session.id },
          data: { lastSeenAt: new Date() }
        })
        .catch(() => {});
    }

    req.user = effectiveUser;
    req.tokenPayload = payload;
    next();
  } catch (_error) {
    // Наружу не отдаём техническую причину JWT ошибки. Для клиента достаточно
    // знать: токен плохой или истёк, нужно войти заново.
    next(new AppError(401, 'Недействительный или просроченный токен'));
  }
}

function requireAdmin(req, _res, next) {
  // requireAdmin должен идти после requireAuth, потому что роль лежит в req.user.
  if (!req.user || req.user.role !== 'ADMIN') {
    return next(new AppError(403, 'Требуется доступ администратора'));
  }
  next();
}

module.exports = { requireAuth, requireAdmin, extractBearerToken };
