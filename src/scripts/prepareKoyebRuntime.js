const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');

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

function getBearerHeader(token) {
  const value = `${token || ''}`.trim();
  return value ? { Authorization: `Bearer ${value}` } : undefined;
}

function downloadFile(urlValue, targetPath, bearerToken) {
  const url = new URL(urlValue);
  const client = url.protocol === 'http:' ? http : https;

  return new Promise((resolve, reject) => {
    const request = client.get(
      url,
      {
        headers: getBearerHeader(bearerToken)
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          response.resume();
          downloadFile(new URL(response.headers.location, url).toString(), targetPath, bearerToken)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          reject(new Error(`Seed download failed with HTTP ${response.statusCode}`));
          return;
        }

        const tempPath = `${targetPath}.download`;
        const file = fs.createWriteStream(tempPath);
        response.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            fs.renameSync(tempPath, targetPath);
            resolve();
          });
        });
        file.on('error', (error) => {
          fs.rmSync(tempPath, { force: true });
          reject(error);
        });
      }
    );

    request.setTimeout(120000, () => {
      request.destroy(new Error('Seed download timed out'));
    });
    request.on('error', reject);
  });
}

async function restoreSeedDatabaseIfNeeded(dbPath) {
  const seedUrl = `${process.env.DATABASE_SEED_URL || ''}`.trim();
  if (!dbPath || !seedUrl) return { restored: false, reason: 'no-seed-url' };
  if (fs.existsSync(dbPath)) return { restored: false, reason: 'db-exists' };

  ensureDir(path.dirname(dbPath));
  await downloadFile(seedUrl, dbPath, process.env.DATABASE_SEED_BEARER_TOKEN);
  return { restored: true, reason: 'downloaded' };
}

function uploadsHaveRuntimeFiles(uploadsDir) {
  if (!fs.existsSync(uploadsDir)) return false;
  return fs.readdirSync(uploadsDir).some((name) => name !== '.gitkeep');
}

async function restoreUploadsIfNeeded(uploadsDir) {
  const seedUrl = `${process.env.UPLOADS_SEED_URL || ''}`.trim();
  if (!seedUrl) return { restored: false, reason: 'no-seed-url' };
  if (uploadsHaveRuntimeFiles(uploadsDir)) return { restored: false, reason: 'uploads-exist' };

  ensureDir(uploadsDir);
  const archivePath = '/tmp/uploads-seed.tar.gz';
  await downloadFile(
    seedUrl,
    archivePath,
    process.env.UPLOADS_SEED_BEARER_TOKEN || process.env.DATABASE_SEED_BEARER_TOKEN
  );

  const result = spawnSync('tar', ['-xzf', archivePath, '-C', uploadsDir], {
    stdio: 'inherit'
  });

  fs.rmSync(archivePath, { force: true });

  if (result.status !== 0) {
    throw new Error(`Uploads seed extract failed with exit code ${result.status}`);
  }

  return { restored: true, reason: 'downloaded-and-extracted' };
}

async function main() {
  const dbPath = resolveSqlitePath(process.env.DATABASE_URL || 'file:/data/prod.db');
  const uploadsDir = path.resolve(process.cwd(), 'uploads');

  ensureDir('/data');
  ensureDir('/data/backups/db');
  ensureDir(uploadsDir);
  ensureDir(path.resolve(process.cwd(), 'logs'));

  if (dbPath) {
    ensureDir(path.dirname(dbPath));
  }

  const databaseSeed = await restoreSeedDatabaseIfNeeded(dbPath);
  const uploadsSeed = await restoreUploadsIfNeeded(uploadsDir);

  process.stdout.write(
    JSON.stringify(
      {
        status: 'ok',
        prepared: true,
        databasePath: dbPath || null,
        uploadsDir,
        seed: {
          database: databaseSeed,
          uploads: uploadsSeed
        },
        cwd: process.cwd()
      },
      null,
      2
    ) + '\n'
  );
}

main().catch((error) => {
  console.error('Koyeb runtime prepare failed:', error.message);
  process.exit(1);
});
