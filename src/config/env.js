const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Koyeb copy reads .env only when it exists locally. Production deploy can run without .env.
const backendEnvPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(backendEnvPath)) {
  dotenv.config({ path: backendEnvPath });
}
dotenv.config();

function parseOrigins(raw) {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseList(raw) {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumber(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function parseBoolean(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeBaseUrl(value) {
  const text = `${value || ''}`.trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text.replace(/\/+$/, '');
  return `https://${text}`.replace(/\/+$/, '');
}

const port = Number(process.env.PORT || 4000);
const koyebPublicUrl = normalizeBaseUrl(process.env.KOYEB_PUBLIC_DOMAIN || process.env.KOYEB_APP_DOMAIN);
const appUrl = normalizeBaseUrl(process.env.APP_URL) || koyebPublicUrl || `http://localhost:${port}`;
const defaultFrontendOrigins = [
  'https://ai-friendly.site',
  'https://www.ai-friendly.site',
  'http://ai-friendly.site',
  'http://www.ai-friendly.site',
  'http://localhost:8081'
];

const env = {
  nodeEnv: process.env.NODE_ENV || 'production',
  port,
  databaseUrl: process.env.DATABASE_URL || 'file:/data/prod.db',

  // Koyeb quick deploy works without env secrets. Replace these in Koyeb env for real production hardening.
  jwtSecret:
    process.env.JWT_SECRET ||
    'ai-friendly-koyeb-default-jwt-secret-change-after-deploy',
  jwtAccessExpires: process.env.JWT_ACCESS_EXPIRES || '15m',
  jwtRefreshExpiresDays: Number(process.env.JWT_REFRESH_EXPIRES_DAYS || 30),

  // AI keys are intentionally empty by default. Add them in the admin panel after deploy.
  openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openRouterModel: process.env.OPENROUTER_MODEL || 'openrouter/auto',

  qwenApiKey: process.env.QWEN_API_KEY || '',
  proQwenApiKeys: parseList(process.env.PRO_QWEN_API_KEYS || ''),
  proQwenApiKey: process.env.PRO_QWEN_API_KEY || process.env.QWEN_API_KEY || '',
  proQwenBaseUrl:
    process.env.PRO_QWEN_BASE_URL ||
    process.env.QWEN_BASE_URL ||
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  defaultModel: process.env.DEFAULT_MODEL || process.env.OPENROUTER_MODEL || 'openrouter/auto',

  openRouterModelCandidates: parseList(
    process.env.OPENROUTER_MODEL_CANDIDATES ||
      'openrouter/auto,google/gemma-3-27b-it:free,qwen/qwen3-next-80b-a3b-instruct:free,arcee-ai/trinity-mini:free'
  ),

  scribeModel: process.env.SCRIBE_MODEL || 'openrouter/auto',
  scribeModelCandidates: parseList(
    process.env.SCRIBE_MODEL_CANDIDATES ||
      'openrouter/auto,google/gemma-3-27b-it:free,qwen/qwen3-next-80b-a3b-instruct:free,arcee-ai/trinity-mini:free'
  ),
  scribeMaxTokens: parseNumber(process.env.SCRIBE_MAX_TOKENS, 120),
  scribeTemperature: parseNumber(process.env.SCRIBE_TEMPERATURE, 2),

  frontendOrigins: parseOrigins(process.env.FRONTEND_ORIGIN || defaultFrontendOrigins.join(',')),
  trustProxy: process.env.TRUST_PROXY || '1',

  adminSeedPassword: process.env.ADMIN_SEED_PASSWORD || 'admin12345',
  adminPanelSecret:
    process.env.ADMIN_PANEL_SECRET ||
    process.env.JWT_SECRET ||
    'ai-friendly-koyeb-default-admin-secret-change-after-deploy',
  termsVersion: process.env.TERMS_VERSION || 'v1.0',

  logsPath: process.env.LOGS_PATH || path.resolve(process.cwd(), 'logs', 'app.log'),
  appUrl,
  mediaPublicBaseUrl: normalizeBaseUrl(process.env.MEDIA_PUBLIC_BASE_URL) || appUrl,

  dbBackupEnabled: parseBoolean(process.env.DB_BACKUP_ENABLED, true),
  dbBackupCron: process.env.DB_BACKUP_CRON || '0 3 * * *',
  dbBackupTimezone: process.env.DB_BACKUP_TIMEZONE || 'Asia/Bishkek',
  dbBackupKeepDays: parseNumber(process.env.DB_BACKUP_KEEP_DAYS, 7),
  dbBackupDir: process.env.DB_BACKUP_DIR || '/data/backups/db'
};

module.exports = { env };
