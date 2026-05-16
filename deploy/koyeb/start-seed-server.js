const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const port = Number(process.env.SEED_PORT || 5055);
const seedDir = path.resolve(process.env.SEED_DIR || path.join(process.cwd(), 'backups', 'forced', 'koyeb-export'));
const token = `${process.env.SEED_TOKEN || ''}`.trim();

function safeResolve(requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0] || '/');
  const relative = decoded.replace(/^\/+/, '');
  const target = path.resolve(seedDir, relative);
  if (!target.startsWith(seedDir + path.sep) && target !== seedDir) return null;
  return target;
}

function unauthorized(res) {
  res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function fileInfo(filePath) {
  const buffer = fs.readFileSync(filePath);
  return {
    name: path.basename(filePath),
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex')
  };
}

if (!token) {
  console.warn('WARNING: SEED_TOKEN is empty. Set SEED_TOKEN before exposing this server through a tunnel.');
}

const server = http.createServer((req, res) => {
  if (token) {
    const expected = `Bearer ${token}`;
    if (req.headers.authorization !== expected) {
      unauthorized(res);
      return;
    }
  }

  if (req.url === '/' || req.url.startsWith('/index')) {
    const files = fs.existsSync(seedDir)
      ? fs.readdirSync(seedDir)
          .filter((name) => fs.statSync(path.join(seedDir, name)).isFile())
          .map((name) => fileInfo(path.join(seedDir, name)))
      : [];
    sendJson(res, 200, { status: 'ok', seedDir, files });
    return;
  }

  const target = safeResolve(req.url);
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  const stream = fs.createReadStream(target);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': fs.statSync(target).size,
    'Content-Disposition': `attachment; filename="${path.basename(target)}"`
  });
  stream.pipe(res);
});

server.listen(port, () => {
  console.log(JSON.stringify({ status: 'seed-server-ready', port, seedDir, tokenRequired: Boolean(token) }, null, 2));
});
