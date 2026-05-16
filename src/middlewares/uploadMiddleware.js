const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { resolveUserMediaDir } = require('../utils/mediaStorage');

/**
 * uploadMiddleware.js — настройки multer для файлов.
 *
 * Multer принимает multipart/form-data:
 * - аватар пользователя сохраняем сразу на диск;
 * - фото разработчиков сохраняем в uploads/developers;
 * - картинки для персонализации держим в памяти, потому что дальше сервис сам
 *   решает, куда именно положить файл и какой publicUrl вернуть.
 */

function resolveAvatarUploadDir(userId) {
  // Все пользовательские файлы лежат в uploads/users/<userId>/...
  // Так проще чистить данные одного пользователя и не мешать файлы разных людей.
  return resolveUserMediaDir(userId || 'guest', ['profile']);
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    // Папку создаём прямо перед сохранением файла.
    const userId = req.user?.id || 'guest';
    const uploadDir = resolveAvatarUploadDir(userId);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, _file, cb) => {
    // Имя файла уникальное: userId + timestamp + random hex.
    // Расширение всегда jpg, потому что аватар дальше воспринимается как изображение.
    const userId = req.user?.id || 'unknown';
    const name = `avatar_${userId}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.jpg`;
    cb(null, name);
  }
});

const fileFilter = (_req, file, cb) => {
  // Для аватаров разрешаем только нормальные web image форматы.
  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPEG/PNG/WEBP files are allowed'), false);
  }
};

const genericImageFilter = (_req, file, cb) => {
  // Более общий фильтр: любой image/*.
  // Он нужен для админских изображений/тестов, где формат может быть шире.
  const mime = `${file?.mimetype || ''}`.trim().toLowerCase();
  if (mime.startsWith('image/')) {
    cb(null, true);
    return;
  }
  cb(new Error('Only image uploads are allowed'), false);
};

const upload = multer({
  storage,
  fileFilter,
  // Аватар не должен быть огромным: 4 MB достаточно для профиля.
  limits: { fileSize: 4 * 1024 * 1024 }
});

const developerStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    // Фото разработчиков общие для приложения, поэтому они не лежат в user folders.
    const uploadDir = path.resolve(__dirname, '../../uploads/developers');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    // Расширение берём из MIME, чтобы браузер/мобилка правильно показали картинку.
    const mime = `${file?.mimetype || ''}`.trim().toLowerCase();
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    const name = `dev_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
    cb(null, name);
  }
});

const developerPhotoUpload = multer({
  storage: developerStorage,
  fileFilter: genericImageFilter,
  // Для фото в админке даём больше лимит, чтобы не ломаться на обычных снимках.
  limits: { fileSize: 12 * 1024 * 1024 }
});

const personalizationImageUpload = multer({
  // memoryStorage значит: файл не сохраняется multer-ом на диск автоматически.
  // Controller получает buffer и сам передаёт его в mediaStorage.
  storage: multer.memoryStorage(),
  fileFilter: genericImageFilter,
  // Пользователь просил фактически без жёсткого маленького лимита для тестов.
  limits: { fileSize: 100 * 1024 * 1024 }
});

module.exports = { upload, personalizationImageUpload, developerPhotoUpload, resolveAvatarUploadDir };
