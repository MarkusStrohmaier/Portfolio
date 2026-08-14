'use strict';
/*
 * Vorschau für die GitHub-Pages-Fassung (docs/).
 *
 * Liefert AUSSCHLIESSLICH Dateien aus – keine API, keine Datenbank, kein
 * Node-Backend. Genau das macht GitHub Pages auch. Läuft die Seite hier,
 * läuft sie dort.
 *
 * Start:  node docs-preview.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'docs');
const PORT = Number(process.env.PORT) || 4200;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp4': 'video/mp4'
};

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }

  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) {
      if (!urlPath.endsWith('/')) { res.writeHead(302, { Location: urlPath + '/' }); return res.end(); }
      return datei(path.join(filePath, 'index.html'));
    }
    datei(filePath);
  });

  function datei(p) {
    fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Nicht gefunden'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    });
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  Vorschau der GitHub-Pages-Fassung (nur Dateien, kein Backend)');
  console.log('  http://localhost:' + PORT);
  console.log('');
});
