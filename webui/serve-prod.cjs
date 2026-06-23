const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '5173', 10);
const API_TARGET = process.env.API_TARGET || 'http://localhost:8088';
const DIST = path.join(__dirname, 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
};

function proxyApi(req, res) {
  const url = new URL(req.url, API_TARGET);
  const opts = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname + url.search,
    method: req.method,
    headers: { ...req.headers, host: url.host },
  };
  const proxy = http.request(opts, (upstream) => {
    res.writeHead(upstream.statusCode, upstream.headers);
    upstream.pipe(res);
  });
  proxy.on('error', () => {
    res.writeHead(502);
    res.end('Bad Gateway');
  });
  req.pipe(proxy);
}

function serveFile(filePath, res) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const content = fs.readFileSync(filePath);
    const headers = { 'Content-Type': mime };
    if (ext !== '.html') {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    }
    res.writeHead(200, headers);
    res.end(content);
  } catch {
    return false;
  }
  return true;
}

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  let filePath = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath);

  if (serveFile(filePath, res)) return;

  if (!serveFile(path.join(DIST, 'index.html'), res)) {
    res.writeHead(404);
    res.end('Not Found');
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    return proxyApi(req, res);
  }
  serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Production server: http://localhost:${PORT}`);
  console.log(`API proxy → ${API_TARGET}`);
});
