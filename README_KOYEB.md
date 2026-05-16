# Backend Koyeb Deploy Copy

Эта папка — отдельная Docker/GitHub-копия backend для Koyeb. Оригинальный `backend/` не меняется.

Цель: деплоить backend из GitHub на Koyeb, хранить env в панели Koyeb, а SQLite держать в persistent volume `/data`.

## Что важно

- `.env` не пушится в GitHub.
- Локальная база `backend/prisma/dev.db` не пушится в GitHub.
- `node_modules`, logs, uploads не пушатся.
- Если нужна та же база, перенос делается через Koyeb volume или `DATABASE_SEED_URL`, а не через git.

## Структура

```text
backend-koyeb/
  Dockerfile
  .dockerignore
  .env.example
  package.json
  package-lock.json
  prisma/
    schema.prisma
    migrations/
  src/
  uploads/.gitkeep
  logs/.gitkeep
```

## Рекомендуемая схема доменов

```text
https://www.ai-friendly.site  -> frontend / GitHub Pages
https://api.ai-friendly.site  -> backend / Koyeb
```

Можно использовать `server.ai-friendly.site`, но один и тот же backend URL должен стоять в:

```env
APP_URL=https://api.ai-friendly.site
MEDIA_PUBLIC_BASE_URL=https://api.ai-friendly.site
EXPO_PUBLIC_API_BASE_URL=https://api.ai-friendly.site
```

## DNS

После создания сервиса Koyeb даст свой домен вида `...koyeb.app`.

В DNS добавь:

```text
Type: CNAME
Name: api
Target: домен-который-даст-Koyeb
```

Если используешь Cloudflare proxy и начнутся проблемы с Socket.IO/WebSocket, временно поставь DNS only и проверь снова.

## Koyeb: запуск через GitHub + Dockerfile

В Koyeb создай новый service из GitHub repo.

Настройки:

```text
Root directory: backend-koyeb
Builder: Dockerfile
Dockerfile: Dockerfile
Port: 4000
```

Если Koyeb просит команды, при Dockerfile они обычно не нужны. Dockerfile сам делает:

```text
npm ci
npm run start:koyeb
```

`start:koyeb` делает:

```text
node src/scripts/prepareKoyebRuntime.js && prisma migrate deploy && node src/server.js
```

То есть:

1. создаёт `/data`, `/data/backups/db`, `uploads`, `logs`;
2. если задан `DATABASE_SEED_URL` и `/data/prod.db` ещё нет, скачивает базу;
3. применяет Prisma migrations;
4. запускает backend.

## Koyeb env

В Koyeb Environment Variables добавь минимум:

```env
NODE_ENV=production
DATABASE_URL=file:/data/prod.db
JWT_SECRET=замени_на_длинный_секрет
ADMIN_PANEL_SECRET=замени_на_длинный_секрет
FRONTEND_ORIGIN=https://ai-friendly.site,https://www.ai-friendly.site,http://localhost:8081
APP_URL=https://api.ai-friendly.site
MEDIA_PUBLIC_BASE_URL=https://api.ai-friendly.site
TRUST_PROXY=1
```

AI ключи добавляй тоже только в Koyeb env:

```env
OPENROUTER_API_KEY=...
PRO_QWEN_API_KEY=...
PRO_QWEN_API_KEYS=...
```

## Persistent volume для SQLite

Для SQLite нужен volume, иначе база может пропасть после redeploy/restart.

Рекомендуемая точка монтирования:

```text
/data
```

Тогда база будет здесь:

```text
/data/prod.db
```

Backup будет здесь:

```text
/data/backups/db
```

## Как перенести текущую локальную базу и uploads

Безопасный вариант: не пушить DB в GitHub.

1. Останови локальный backend.

2. Слей WAL в основной SQLite-файл:

```powershell
cd C:\Users\kenes\Desktop\ai_mental\backend
Set-Content -Path "$env:TEMP\sqlite-checkpoint.sql" -Value "PRAGMA wal_checkpoint(TRUNCATE);"
npx prisma db execute --schema prisma/schema.prisma --file "$env:TEMP\sqlite-checkpoint.sql"
```

3. Сделай export базы и uploads:

```powershell
cd C:\Users\kenes\Desktop\ai_mental
.\deploy\koyeb\export-runtime-for-koyeb.ps1
```

4. Дальше есть два варианта.

Вариант A: загрузить файлы прямо в Koyeb volume:

```text
backups\forced\koyeb-export\prod-for-koyeb.db -> /data/prod.db
backups\forced\koyeb-export\uploads.tar.gz   -> распаковать в /app/uploads
```

Вариант B: временно поднять локальный seed-server и Cloudflare tunnel.

Terminal 1:

```powershell
.\deploy\koyeb\start-seed-server.ps1
```

Terminal 2:

```powershell
$empty = "$env:TEMP\ai-friendly-empty-cloudflared.yml"
Set-Content -Path $empty -Value "" -Encoding ASCII
cloudflared --config "$empty" tunnel --url http://127.0.0.1:5055 --no-autoupdate
```

Koyeb env:

```env
DATABASE_SEED_URL=https://YOUR-TUNNEL.trycloudflare.com/prod-for-koyeb.db
UPLOADS_SEED_URL=https://YOUR-TUNNEL.trycloudflare.com/uploads.tar.gz
```

Скрипт `start-seed-server.ps1` печатает token. Его нужно добавить:

```env
DATABASE_SEED_BEARER_TOKEN=TOKEN_FROM_SCRIPT
UPLOADS_SEED_BEARER_TOKEN=TOKEN_FROM_SCRIPT
```

После первого успешного запуска проверь `/health`, потом лучше убрать `DATABASE_SEED_URL`, `UPLOADS_SEED_URL` и token env, чтобы случайно не перезалить данные при новом пустом volume.

## Проверка после деплоя

Открой:

```text
https://api.ai-friendly.site/health
```

Нормальный ответ:

```json
{"status":"ok","service":"ai-mental-backend"}
```

Админка:

```text
https://api.ai-friendly.site/admin/login
```

## Frontend env

Для frontend:

```env
EXPO_PUBLIC_API_BASE_URL=https://api.ai-friendly.site
EXPO_PUBLIC_API_FALLBACK_URLS=https://твой-cloudflare-tunnel.trycloudflare.com,http://192.168.x.x:4000
```

Порядок важен: первый URL — основной, остальные — fallback.

## Локальный Docker test

Из корня проекта:

```powershell
docker build -t ai-friendly-backend-koyeb .\backend-koyeb
```

Создай локальный env:

```powershell
Copy-Item backend-koyeb\.env.example backend-koyeb\.env -Force
```

Запуск с volume:

```powershell
docker run --rm -p 4000:4000 --env-file .\backend-koyeb\.env -v "${PWD}\.koyeb-data:/data" ai-friendly-backend-koyeb
```

Проверка:

```powershell
curl http://localhost:4000/health
```

## Что пушить в GitHub

Пушить можно:

```text
backend-koyeb/Dockerfile
backend-koyeb/.dockerignore
backend-koyeb/.env.example
backend-koyeb/package.json
backend-koyeb/package-lock.json
backend-koyeb/prisma/schema.prisma
backend-koyeb/prisma/migrations/**
backend-koyeb/src/**
backend-koyeb/README_KOYEB.md
backend-koyeb/uploads/.gitkeep
backend-koyeb/logs/.gitkeep
```

Не пушить:

```text
backend-koyeb/.env
backend-koyeb/prisma/*.db
backend-koyeb/prisma/*.db-wal
backend-koyeb/prisma/*.db-shm
backend-koyeb/node_modules
```
