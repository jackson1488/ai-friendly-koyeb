const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  if (!dirPath) return;
  fs.mkdirSync(dirPath, { recursive: true });
}

function resolveSqlitePath(databaseUrl) {
  const value = `${databaseUrl || ''}`.trim();
  if (!value.startsWith('file:')) return null;

  const rawPath = value.replace(/^file:/, '');
  if (!rawPath || rawPath === ':memory:') return null;

  if (path.isAbsolute(rawPath)) return rawPath;
  return path.resolve(process.cwd(), rawPath);
}

function main() {
  const dbPath = resolveSqlitePath(process.env.DATABASE_URL || 'file:/data/prod.db');
  const uploadsDir = path.resolve(process.cwd(), 'uploads');
  const logsDir = path.resolve(process.cwd(), 'logs');

  ensureDir('/data');
  ensureDir('/data/backups/db');
  ensureDir(uploadsDir);
  ensureDir(logsDir);

  if (dbPath) {
    ensureDir(path.dirname(dbPath));
  }

  process.stdout.write(
    JSON.stringify(
      {
        status: 'ok',
        prepared: true,
        databasePath: dbPath || null,
        uploadsDir,
        logsDir,
        mode: 'clean-database',
        cwd: process.cwd()
      },
      null,
      2
    ) + '\n'
  );
}

try {
  main();
} catch (error) {
  console.error('Koyeb runtime prepare failed:', error.message);
  process.exit(1);
}
