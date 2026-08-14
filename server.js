'use strict';
/*
 * Portfolio – lokaler Static-Server (ohne externe Pakete)
 * Läuft auf dem Laptop, ist im WLAN vom Handy erreichbar.
 *
 * Start:  node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORTS = [Number(process.env.PORT) || 4100, 4101, 4102, 8100, 8110];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webmanifest': 'application/manifest+json',
};

function sendFile(filePath, urlPath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Nicht gefunden: ' + urlPath);
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }

  // Ordner (z. B. /fotos) auf ihre index.html auflösen. Der Schrägstrich am
  // Ende muss dabei sein, sonst löst der Browser relative Pfade wie
  // "js/app.js" eine Ebene zu hoch auf und die Seite bekommt keine Dateien.
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) {
      if (!urlPath.endsWith('/')) {
        res.writeHead(302, { Location: urlPath + '/' });
        return res.end();
      }
      return sendFile(path.join(filePath, 'index.html'), urlPath, res);
    }
    sendFile(filePath, urlPath, res);
  });
}

/* ══════════════════ EINGEHÄNGTE WERKZEUGE ══════════════════
   Portfolio und Demos laufen als EIN Dienst unter einer Adresse:

     /            Portfolio
     /dienstplan  Dienstplan → Kalender (reine Browser-Datei in public/)
     /freunde     FreundeTracker  (apps/freunde)
     /druck       MaxlDruck       (apps/druck)

   Beide Apps unter apps/ sind Schaufenster-KOPIEN: ohne Anmeldung und
   mit erfundenen Daten in einer eigenen Datenbank. Die echten Fassungen
   liegen unverändert unter Clauden/FreundeTracker bzw. Clauden/3D-
   Preisrechner und behalten ihre Anmeldung.

   Dass alles unter derselben Adresse läuft, ist nicht nur Kosmetik: Die
   Vorschaufenster weiter oben binden die Demos als <iframe> ein, und erst
   dadurch sind sie „same-origin" – kein verworfenes Sitzungs-Cookie und
   keine Zertifikatswarnung mehr.
   ═══════════════════════════════════════════════════════════ */

const freundeApi = require('./apps/freunde/api');
const druckApp = require('./apps/druck/server');

// Beispieldaten für die Druck-Demo, aber nur in eine noch leere Datenbank –
// wer in der Demo etwas ändert, findet es beim nächsten Start unverändert
// vor. (FreundeTracker macht das selbst beim ersten Anmelden, siehe dort.)
require('./apps/druck/seed-demo').seed(druckApp.demoDb, (err, written) => {
  if (err) console.error('Beispieldaten (Druck):', err.message);
  else if (written) console.log('  Beispieldaten für die Druck-Demo angelegt.');
});

const FREUNDE_PUBLIC = path.join(ROOT, 'apps', 'freunde', 'public');

/** Statische Datei einer eingehängten App ausliefern. */
function serveFrom(baseDir, relPath, res) {
  const filePath = path.normalize(path.join(baseDir, relPath));
  if (!filePath.startsWith(baseDir)) { res.writeHead(403); return res.end('Forbidden'); }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Nicht gefunden');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);

    for (const mount of ['/freunde', '/druck']) {
      if (urlPath !== mount && !urlPath.startsWith(mount + '/')) continue;

      // Ohne Schrägstrich am Ende würde der Browser relative Pfade wie
      // "styles.css" gegen die Wurzel auflösen (/styles.css statt
      // /freunde/styles.css) – die App bekäme keine einzige Datei.
      if (urlPath === mount) {
        res.writeHead(302, { Location: mount + '/' });
        return res.end();
      }

      // Die Apps kennen ihren Unterpfad nicht: Sie sind intern weiterhin
      // auf /api/… und / verdrahtet. Deshalb hier das Präfix abschneiden,
      // bevor sie die Anfrage zu sehen bekommen.
      req.url = req.url.slice(mount.length) || '/';

      if (mount === '/druck') return druckApp(req, res);

      const rest = decodeURIComponent(req.url.split('?')[0]);
      if (rest.startsWith('/api/')) return freundeApi.handleApi(req, res, { secure: false });
      return serveFrom(FREUNDE_PUBLIC, rest === '/' ? '/index.html' : rest, res);
    }

    serveStatic(req, res);
  } catch (e) {
    console.error('Fehler:', e.message);
    if (!res.headersSent) { res.writeHead(500); res.end('Serverfehler'); }
  }
});

function getLanIPs() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  ips.sort((a, b) => {
    const score = ip => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);
    return score(a) - score(b);
  });
  return ips;
}

function listen(i) {
  if (i >= PORTS.length) {
    console.error('Kein freier Port gefunden.');
    process.exit(1);
  }
  const port = PORTS[i];
  server.once('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} belegt, versuche nächsten…`);
      listen(i + 1);
    } else {
      throw err;
    }
  });
  server.listen(port, '0.0.0.0', () => {
    const ips = getLanIPs();
    console.log('\n==================================================');
    console.log('  Portfolio-Server läuft');
    console.log('==================================================');
    console.log(`  Am Laptop:      http://localhost:${port}`);
    ips.forEach(ip => console.log(`  Im WLAN (Handy): http://${ip}:${port}`));
    console.log('--------------------------------------------------');
    console.log('  Portfolio    /');
    console.log('  Dienstplan   /dienstplan-kalender.html');
    console.log('  Fotos        /fotos/     (läuft ganz im Browser)');
    console.log('  Freunde      /freunde/   (Demo, ohne Anmeldung)');
    console.log('  Druck        /druck/     (Demo, ohne Anmeldung)');
    console.log('==================================================\n');
  });
}

listen(0);
