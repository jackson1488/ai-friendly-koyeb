const { prisma } = require('../config/prisma');
const { verifyAdminPanelToken } = require('../utils/jwt');

/**
 * adminPanelAuth.js — авторизация именно для web-админки.
 *
 * REST API использует Authorization: Bearer token.
 * Админ-панель удобнее держать на cookie, потому что это обычные EJS-страницы
 * в браузере: открыл `/admin`, cookie сама ушла на сервер.
 */

async function requireAdminPanelAuth(req, res, next) {
  // admin_panel_token создаётся после входа в /admin/login.
  // Если cookie нет — пользователь не вошёл в админку.
  const token = req.cookies.admin_panel_token;
  if (!token) {
    return res.redirect('/admin/login');
  }

  try {
    // JWT говорит, кто вошёл. База подтверждает, что этот пользователь всё ещё
    // существует, является ADMIN и не был заблокирован/удалён после выдачи cookie.
    const payload = verifyAdminPanelToken(token);
    const admin = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!admin || admin.role !== 'ADMIN' || admin.isBlocked || admin.isDeleted) {
      // Если доступ уже невалидный, чистим cookie, чтобы браузер не зацикливался.
      res.clearCookie('admin_panel_token');
      return res.redirect('/admin/login');
    }
    req.admin = admin;
    next();
  } catch (_error) {
    // Любая ошибка подписи/срока токена = безопасно выкидываем на логин.
    res.clearCookie('admin_panel_token');
    return res.redirect('/admin/login');
  }
}

module.exports = { requireAdminPanelAuth };

