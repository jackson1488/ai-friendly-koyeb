# Koyeb env template

Paste these into Koyeb Environment Variables. Do not commit real secrets.

```env
NODE_ENV=production
DATABASE_URL=file:/data/prod.db

JWT_SECRET=replace_with_long_random_secret
JWT_ACCESS_EXPIRES=15m
JWT_REFRESH_EXPIRES_DAYS=30
ADMIN_PANEL_SECRET=replace_with_long_random_admin_secret
ADMIN_SEED_PASSWORD=replace_admin_seed_password

FRONTEND_ORIGIN=https://ai-friendly.site,https://www.ai-friendly.site,http://localhost:8081
APP_URL=https://api.ai-friendly.site
MEDIA_PUBLIC_BASE_URL=https://api.ai-friendly.site
TRUST_PROXY=1

OPENROUTER_API_KEY=
OPENROUTER_MODEL=openrouter/auto
DEFAULT_MODEL=openrouter/auto
OPENROUTER_MODEL_CANDIDATES=openrouter/auto,google/gemma-3-27b-it:free,qwen/qwen3-next-80b-a3b-instruct:free,arcee-ai/trinity-mini:free

PRO_QWEN_API_KEY=
PRO_QWEN_API_KEYS=
PRO_QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1

SCRIBE_MODEL=openrouter/auto
SCRIBE_MODEL_CANDIDATES=openrouter/auto,google/gemma-3-27b-it:free,qwen/qwen3-next-80b-a3b-instruct:free,arcee-ai/trinity-mini:free
SCRIBE_MAX_TOKENS=120
SCRIBE_TEMPERATURE=2

ANON_ALLOW_SELF_MATCH=true
ANON_LAST_PARTNER_COOLDOWN_MS=0

DB_BACKUP_ENABLED=true
DB_BACKUP_CRON=0 3 * * *
DB_BACKUP_TIMEZONE=Asia/Bishkek
DB_BACKUP_KEEP_DAYS=7
DB_BACKUP_DIR=/data/backups/db

# Optional one-time DB seed. Remove after first successful boot.
# DATABASE_SEED_URL=https://example.com/private/prod-for-koyeb.db
# DATABASE_SEED_BEARER_TOKEN=

# Optional one-time uploads seed. Remove after first successful boot.
# UPLOADS_SEED_URL=https://example.com/private/uploads.tar.gz
# UPLOADS_SEED_BEARER_TOKEN=
```
