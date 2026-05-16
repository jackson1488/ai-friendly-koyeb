const path = require('path');
const fs = require('fs');
const { prisma } = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { getIo } = require('../socket/io');
const { userRoom } = require('../socket/rooms');
const { UPLOAD_ROOT, resolvePublicBaseUrl } = require('../utils/mediaStorage');

/**
 * avatarController.js — загрузка аватара пользователя.
 *
 * Важная цепочка:
 * 1. uploadMiddleware уже принял файл и положил его на диск;
 * 2. controller строит public URL;
 * 3. старый avatar file пытаемся удалить;
 * 4. новый URL сохраняем в user.avatar;
 * 5. через socket сообщаем всем устройствам пользователя, что профиль обновился.
 */

function resolveUploadFilePathFromUrl(sourceUrl) {
  // Эта функция нужна, чтобы удалить старый avatar file.
  // На вход может прийти полный URL или относительный /uploads/...
  const text = `${sourceUrl || ''}`.trim();
  if (!text) return '';

  try {
    const parsed = new URL(text);
    const pathname = `${parsed.pathname || ''}`.trim();
    if (!pathname.startsWith('/uploads/')) return '';
    const relative = decodeURIComponent(pathname.replace(/^\/uploads\//, ''));
    const filePath = path.resolve(UPLOAD_ROOT, relative);

    // Защита от path traversal: итоговый путь обязан остаться внутри uploads.
    if (!filePath.startsWith(UPLOAD_ROOT)) return '';
    return filePath;
  } catch (_error) {
    if (!text.startsWith('/uploads/')) return '';
    const relative = text.replace(/^\/uploads\//, '').split('?')[0];
    const filePath = path.resolve(UPLOAD_ROOT, relative);
    if (!filePath.startsWith(UPLOAD_ROOT)) return '';
    return filePath;
  }
}

async function uploadAvatar(req, res) {
  // req.file появляется после upload.single('avatar') в route.
  if (!req.file) throw new AppError(400, 'Avatar file is missing');

  const userId = `${req.user?.id || ''}`.trim();
  if (!userId) throw new AppError(401, 'Unauthorized');

  // baseUrl нужен, чтобы frontend получил не путь на диске, а URL,
  // который можно открыть с телефона/браузера.
  const baseUrl =
    resolvePublicBaseUrl(req, { allowPrivate: true }) ||
    `${req.protocol || 'http'}://${req.get('host') || 'localhost:4000'}`;

  const avatarUrl = `${baseUrl}/uploads/users/${encodeURIComponent(userId)}/profile/${encodeURIComponent(req.file.filename)}`;

  // Старый файл удаляем best-effort. Если не получилось — не ломаем загрузку нового.
  const oldAvatar = `${req.user?.avatar || ''}`.trim();
  const oldAvatarPath = resolveUploadFilePathFromUrl(oldAvatar);
  if (oldAvatarPath && fs.existsSync(oldAvatarPath)) {
    try {
      fs.unlinkSync(oldAvatarPath);
    } catch (_error) {
      // Не критично: максимум останется старый файл в uploads.
    }
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: { avatar: avatarUrl }
  });

  try {
    const io = getIo();
    if (io) {
      io.to(userRoom(user.id)).emit('user:profileUpdated', {
        id: user.id,
        avatar: user.avatar
      });
    }
  } catch (_error) {
    // Socket sync не должен ломать HTTP ответ.
  }

  res.json({ avatarUrl: user.avatar });
}

module.exports = { uploadAvatar };
