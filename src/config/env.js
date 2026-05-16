const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

/**
 * Центральная точка чтения переменных окружения backend.
 *
 * Почему это важно:
 * - остальные файлы не должны напрямую читать process.env и по-разному трактовать
 *   одни и те же значения;
 * - здесь задаются безопасные fallback-значения для локальной разработки;
 * - здесь нормализуются списки, числа и boolean-флаги, чтобы в сервисах не было
 *   ручного парсинга строк из .env.
 *
 * Важно: реальные секреты лежат только в backend/.env и не должны попадать в git.
 */
const backendEnvPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(backendEnvPath)) {
  // Сначала явно читаем backend/.env, потому что сервер часто запускается из корня
  // монорепозитория, а не из папки backend. Так мы не зависим от текущей рабочей папки.
  dotenv.config({ path: backendEnvPath });
}
// Второй вызов оставлен как стандартный fallback dotenv: если процесс запущен из
// backend, он подхватит .env из текущей директории. Повторная загрузка безопасна.
dotenv.config();

function parseOrigins(raw) {
  // FRONTEND_ORIGIN хранится строкой через запятую:
  // "http://localhost:8081,https://www.ai-friendly.site".
  // На выходе нужен массив непустых origin для CORS.
  return String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseList(raw) {
  // Универсальный parser списков для моделей/API-ключей/fallback-очередей.
  // Пустые элементы выкидываем, чтобы случайная лишняя запятая не стала моделью "".
  return String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumber(raw, fallback) {
  // Все значения из .env приходят строками. Если строка не число, возвращаем fallback,
  // иначе downstream-код может получить NaN и сломать лимиты/таймауты.
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function parseBoolean(raw, fallback) {
  // Boolean env обычно пишут по-разному: true/false, 1/0, yes/no, on/off.
  // Поддерживаем все привычные варианты, чтобы деплой не зависел от конкретного стиля.
  if (raw === undefined || raw === null || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

const env = {
  // Базовый runtime.
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  databaseUrl: process.env.DATABASE_URL || 'file:./dev.db',

  // JWT/session-настройки. jwtSecret в production обязан быть задан реальным секретом.
  jwtSecret: process.env.JWT_SECRET || 'change_me',
  jwtAccessExpires: process.env.JWT_ACCESS_EXPIRES || '15m',
  jwtRefreshExpiresDays: Number(process.env.JWT_REFRESH_EXPIRES_DAYS || 30),

  // OpenRouter используется обычным чатом и как fallback для части AI-задач.
  openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openRouterModel: process.env.OPENROUTER_MODEL || 'openrouter/auto',

  // Qwen/DashScope PRO-провайдер. Для PRO лучше использовать эти ключи/модели,
  // чтобы не смешивать обычный OpenRouter pipeline и PRO pipeline.
  qwenApiKey: process.env.QWEN_API_KEY || '',
  proQwenApiKeys: parseList(process.env.PRO_QWEN_API_KEYS || ''),
  proQwenApiKey: process.env.PRO_QWEN_API_KEY || process.env.QWEN_API_KEY || '',
  proQwenBaseUrl:
    process.env.PRO_QWEN_BASE_URL ||
    process.env.QWEN_BASE_URL ||
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  defaultModel: process.env.DEFAULT_MODEL || process.env.OPENROUTER_MODEL || 'openrouter/auto',

  // Очередь fallback-моделей для обычного chat pipeline.
  // Порядок важен: сервисы пробуют модели слева направо.
  openRouterModelCandidates: parseList(
    process.env.OPENROUTER_MODEL_CANDIDATES ||
      'openrouter/auto,google/gemma-3-27b-it:free,qwen/qwen3-next-80b-a3b-instruct:free,arcee-ai/trinity-mini:free'
  ),

  // Scribe отвечает за сжатие памяти: summary, facts, profile update.
  // Отдельные env позволяют менять "писаря" без изменения основной модели чата.
  scribeModel: process.env.SCRIBE_MODEL || 'openrouter/auto',
  scribeModelCandidates: parseList(
    process.env.SCRIBE_MODEL_CANDIDATES ||
      'openrouter/auto,google/gemma-3-27b-it:free,qwen/qwen3-next-80b-a3b-instruct:free,arcee-ai/trinity-mini:free'
  ),
  scribeMaxTokens: parseNumber(process.env.SCRIBE_MAX_TOKENS, 120),
  scribeTemperature: parseNumber(process.env.SCRIBE_TEMPERATURE, 2),

  // Разрешённые frontend origins для CORS. Дополнительная нормализация находится
  // в config/cors.js, потому что там учитываются Expo, localhost и LAN.
  frontendOrigins: parseOrigins(process.env.FRONTEND_ORIGIN || 'http://localhost:8081'),
  trustProxy: process.env.TRUST_PROXY || '1',

  // Seed/admin defaults. Пароль по умолчанию годится только для локальной разработки.
  adminSeedPassword: process.env.ADMIN_SEED_PASSWORD || 'admin12345',
  adminPanelSecret: process.env.ADMIN_PANEL_SECRET || process.env.JWT_SECRET || 'change_admin_secret',
  termsVersion: process.env.TERMS_VERSION || 'v1.0',

  // Пути и публичные URL для логов/media. MEDIA_PUBLIC_BASE_URL нужен, когда backend
  // стоит за туннелем/CDN и auto-detected host не подходит для клиента.
  logsPath: path.resolve(process.cwd(), 'logs', 'app.log'),
  appUrl: process.env.APP_URL || `http://localhost:${Number(process.env.PORT || 4000)}`,
  mediaPublicBaseUrl: process.env.MEDIA_PUBLIC_BASE_URL || process.env.APP_URL || '',

  // Ежедневные backup-настройки SQLite. Для маленького VPS это дешёвая защита от
  // случайной потери dev.db/prod.db.
  dbBackupEnabled: parseBoolean(process.env.DB_BACKUP_ENABLED, true),
  dbBackupCron: process.env.DB_BACKUP_CRON || '0 3 * * *',
  dbBackupTimezone: process.env.DB_BACKUP_TIMEZONE || 'Asia/Bishkek',
  dbBackupKeepDays: parseNumber(process.env.DB_BACKUP_KEEP_DAYS, 0),
  dbBackupDir: process.env.DB_BACKUP_DIR || path.resolve(__dirname, '..', '..', '..', 'backups', 'db')
};

module.exports = { env };
