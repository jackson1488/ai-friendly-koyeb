# AI Friendly Backend for Koyeb

Отдельная Koyeb-версия backend. Оригинальный `backend/` в основном проекте не нужен для деплоя и не меняется.

## Что изменено под Koyeb

- Backend запускается без `.env`.
- SQLite создается чистой БД через Prisma migrations.
- База хранится в persistent volume `/data/prod.db`.
- OpenRouter/Qwen ключи не нужны в Koyeb env: их можно ввести после деплоя в админке.
- Старую локальную БД и uploads переносить не нужно.

## Первый запуск

Dockerfile сам выполняет:

```bash
node src/scripts/prepareKoyebRuntime.js && prisma migrate deploy && node src/server.js
```

Это делает:

1. создает `/data`, `/data/backups/db`, `uploads`, `logs`;
2. создает чистую SQLite БД, если ее нет;
3. применяет Prisma migrations;
4. создает admin-пользователя;
5. запускает сервер на `PORT=4000`.

## Дефолтный вход в админку

```text
URL:      https://YOUR-KOYEB-DOMAIN/admin/login
username: admin
password: admin12345
```

После первого входа лучше сменить пароль администратора.

## Где вводить AI ключи

OpenRouter:

```text
/admin/config
```

Там есть блок `API-ключ OpenRouter`.

Qwen / DashScope / PRO:

```text
/admin/pro-config/provider
```

Там есть блок `API ключи`. Можно вставить один ключ или список ключей, по одному в строке. Backend будет использовать их по очереди как fallback.

## Koyeb service settings

Создай Koyeb service из GitHub repo:

```text
Repository: jackson1488/ai-friendly-koyeb
Branch: main
Root directory: /
Builder: Dockerfile
Dockerfile path: Dockerfile
Port: 4000
```

Добавь persistent volume:

```text
Mount path: /data
```

Без volume база может пропасть после redeploy/restart.

## Env variables

Минимально можно не добавлять env вообще. Dockerfile и `src/config/env.js` уже дают рабочие дефолты.

Рекомендуемый минимум для нормального production:

```env
JWT_SECRET=long_random_secret_here
ADMIN_PANEL_SECRET=another_long_random_secret_here
APP_URL=https://api.ai-friendly.site
MEDIA_PUBLIC_BASE_URL=https://api.ai-friendly.site
FRONTEND_ORIGIN=https://ai-friendly.site,https://www.ai-friendly.site,http://localhost:8081
```

AI ключи можно не добавлять в env. Лучше вводить их через админку.

## Проверка после деплоя

Открой:

```text
https://YOUR-KOYEB-DOMAIN/health
```

Ожидаемый ответ:

```json
{"status":"ok","service":"ai-mental-backend"}
```

Потом открой админку:

```text
https://YOUR-KOYEB-DOMAIN/admin/login
```

## Custom domain

Если backend будет на поддомене:

```text
api.ai-friendly.site -> Koyeb domain
```

В DNS обычно нужен CNAME:

```text
Type: CNAME
Name: api
Target: your-service.koyeb.app
```

После подключения домена добавь в Koyeb env:

```env
APP_URL=https://api.ai-friendly.site
MEDIA_PUBLIC_BASE_URL=https://api.ai-friendly.site
FRONTEND_ORIGIN=https://ai-friendly.site,https://www.ai-friendly.site,http://localhost:8081
```

## Frontend env

Для frontend:

```env
EXPO_PUBLIC_API_BASE_URL=https://api.ai-friendly.site
EXPO_PUBLIC_API_FALLBACK_URLS=https://YOUR-KOYEB-DOMAIN
```

Если custom domain еще не подключен, ставь Koyeb URL как основной.

## Что не пушить

Нельзя пушить:

```text
.env
*.db
*.db-wal
*.db-shm
node_modules
uploads/* кроме .gitkeep
logs/* кроме .gitkeep
```


