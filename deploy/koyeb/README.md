# Koyeb deployment checklist

## Domain plan

```text
www.ai-friendly.site -> static frontend
api.ai-friendly.site -> Koyeb backend
server.ai-friendly.site -> optional old tunnel/backend fallback
```

## DNS

Create CNAME after Koyeb gives its host:

```text
Type: CNAME
Name: api
Target: <your-koyeb-service>.koyeb.app
```

If WebSocket is unstable behind Cloudflare proxy, set DNS only while testing.

## Koyeb service

```text
Root directory: backend-koyeb
Builder: Dockerfile
Dockerfile: Dockerfile
Port: 4000
```

## Persistent storage

Mount persistent volume:

```text
/data
```

SQLite path:

```env
DATABASE_URL=file:/data/prod.db
```

## Export existing local database and uploads

Run locally:

```powershell
.\deploy\koyeb\export-runtime-for-koyeb.ps1
```

Output:

```text
backups\forced\prod-for-koyeb.db
backups\forced\koyeb-export\uploads.tar.gz
```

Do not commit these files. Upload DB to `/data/prod.db` and unpack uploads into `/app/uploads`, or use temporary seed URLs.

## Temporary tunnel for DB/uploads seed

Only do this with a token.

Terminal 1:

```powershell
.\deploy\koyeb\start-seed-server.ps1
```

The script prints a token.

Terminal 2:

```powershell
$empty = "$env:TEMP\ai-friendly-empty-cloudflared.yml"
Set-Content -Path $empty -Value "" -Encoding ASCII
cloudflared --config "$empty" tunnel --url http://127.0.0.1:5055 --no-autoupdate
```

Koyeb env after cloudflared gives URL:

```env
DATABASE_SEED_URL=https://YOUR-TUNNEL.trycloudflare.com/prod-for-koyeb.db
UPLOADS_SEED_URL=https://YOUR-TUNNEL.trycloudflare.com/uploads.tar.gz
DATABASE_SEED_BEARER_TOKEN=TOKEN_FROM_SCRIPT
UPLOADS_SEED_BEARER_TOKEN=TOKEN_FROM_SCRIPT
```

Remove these four seed env variables after the first successful deploy.

## Backend env

Use:

```text
deploy/koyeb/KOYEB_ENV.md
```

## Frontend env

Use:

```text
deploy/koyeb/FRONTEND_ENV.md
```

## Health check

```text
https://api.ai-friendly.site/health
```

Expected:

```json
{"status":"ok","service":"ai-mental-backend"}
```
