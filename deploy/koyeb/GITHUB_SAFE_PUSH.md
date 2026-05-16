# Safe GitHub push for Koyeb

Обычный `git push main` опасен, если в старой истории были `.env` или `dev.db`. В этом проекте такие backup-файлы уже были в git-индексе, поэтому для нового публичного GitHub repo безопаснее пушить clean orphan branch без старой истории.

## 1. Проверь, что секреты не попадут в новый commit

```powershell
git status --short
git check-ignore -v backend/.env backend/prisma/dev.db backend-koyeb/.env backups/forced/prod-for-koyeb.db
```

## 2. Создай GitHub repository

На GitHub создай пустой repo, например:

```text
ai-friendly-koyeb
```

Не добавляй README/LICENSE/gitignore через GitHub UI, чтобы не было лишнего первого commit.

## 3. Добавь remote

```powershell
git remote add origin https://github.com/<USERNAME>/ai-friendly-koyeb.git
```

Если remote уже есть:

```powershell
git remote set-url origin https://github.com/<USERNAME>/ai-friendly-koyeb.git
```

## 4. Безопасный push без старой секретной истории

Этот способ создаёт новую ветку из текущих файлов, но без старой истории commit-ов.

```powershell
git switch --orphan github-clean

git add .
git status --short
```

Перед commit убедись, что в списке нет:

```text
.env
*.db
*.db-wal
*.db-shm
node_modules
backups/forced/20260414_022019/backend/.env
backups/forced/20260414_022019/backend/dev.db
```

Потом:

```powershell
git commit -m "prepare koyeb backend deployment"
git push -u origin github-clean:main
```

Вернуться на обычную локальную ветку:

```powershell
git switch main
```

## 5. Если всё-таки пушишь обычный main

Не рекомендую для публичного repo, потому что старая история может содержать секреты. Если уже пушил секреты в GitHub, ключи нужно перевыпустить.

## 6. Koyeb после push

В Koyeb выбираешь repo и ставишь:

```text
Root directory: backend-koyeb
Builder: Dockerfile
Dockerfile: Dockerfile
Port: 4000
```

Env бери из:

```text
deploy/koyeb/KOYEB_ENV.md
```

Проверка после deploy:

```text
https://api.ai-friendly.site/health
```
