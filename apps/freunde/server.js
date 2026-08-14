/* ==========================================================================
   FreundeTracker – Mini-Server
   Liefert nur die Dateien dieses Ordners aus. Noch KEINE API: Konten und
   Ausgaben liegen weiterhin im Browser (siehe store.js).

   Sinn der Sache: Über file:// (Doppelklick auf index.html) sperrt der Browser
   je nach Einstellung den localStorage. Dann lässt sich die Anmeldung nicht
   merken und der Login käme bei jedem Start erneut. Unter http://localhost
   funktioniert das zuverlässig.

   Start:  Start.bat  (oder: node server.js)
   ========================================================================== */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');

const crypto = require('node:crypto');

const { handleApi } = require('./api');

const PORTS = [8090, 8091, 3000, 5000];

// Nur was in public/ liegt, geht ins Netz. Serverdateien (db.js, api.js,
// server.js), die Datenbank und die Zertifikate liegen bewusst daneben.
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_DIR = path.join(__dirname, 'certs');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon'
};

function handle(req, res) {
  const requested = decodeURIComponent(req.url.split('?')[0]);

  // Alles unter /api/ übernimmt die API, der Rest sind Dateien.
  if (requested.startsWith('/api/')) {
    return handleApi(req, res, { secure: scheme === 'https' });
  }

  const filePath = path.join(PUBLIC_DIR, requested === '/' ? 'index.html' : requested);

  // Verhindert Ausbrüche aus public/ (z. B. über ../db.js). Der Trennstrich
  // gehört mit in den Vergleich: ohne ihn würde auch ein Nachbarordner wie
  // "public-alt" die Prüfung bestehen, weil sein Pfad genauso anfängt.
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Verboten');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Nicht gefunden');
      return;
    }

    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

/**
 * Mit Zertifikat wird HTTPS bedient, sonst HTTP.
 * Warum das wichtig ist: Anmeldung (crypto.subtle), Kamera und Zwischenablage
 * gibt es im Browser nur im „sicheren Kontext". Das ist localhost – oder https.
 * Über http://192.168.x.x wäre die App am Handy also nicht benutzbar.
 */
function createServer() {
  const key  = path.join(CERT_DIR, 'key.pem');
  const cert = path.join(CERT_DIR, 'cert.pem');

  // Notausgang: FT_HTTP=1 erzwingt HTTP, falls die Zertifikatswarnung stört.
  // Am Handy fehlen dann Kamera und Zwischenablage – Anmelden geht aber.
  if (process.env.FT_HTTP) return { server: http.createServer(handle), scheme: 'http' };

  if (fs.existsSync(key) && fs.existsSync(cert)) {
    return {
      server: https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handle),
      scheme: 'https'
    };
  }

  return { server: http.createServer(handle), scheme: 'http' };
}

/** IPv4-Adresse im lokalen Netz – die Adresse fürs Handy. */
function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

/**
 * Wechselt das Netz (anderes WLAN, Hotspot, neue DHCP-Adresse), passt das
 * Zertifikat nicht mehr und das Handy zeigt eine Fehlermeldung, die nach einem
 * kaputten Server aussieht. Deshalb hier eine klare Ansage beim Start.
 */
function certCoversAddress(address) {
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(path.join(CERT_DIR, 'cert.pem')));
    return (cert.subjectAltName || '').includes(`IP Address:${address}`);
  } catch {
    return true;   // kein Zertifikat lesbar – dann läuft ohnehin HTTP
  }
}

const { server, scheme } = createServer();

/** Ist der Port belegt, wird der nächste aus der Liste probiert. */
function listen(index = 0) {
  if (index >= PORTS.length) {
    console.error('Kein freier Port gefunden. Bitte laufende Server schließen.');
    process.exit(1);
  }

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') listen(index + 1);
    else { console.error(err.message); process.exit(1); }
  });

  // 0.0.0.0: auch von anderen Geräten im WLAN erreichbar, nicht nur lokal.
  //
  // FT_HOST=127.0.0.1 schnürt das bewusst auf den Rechner selbst ein. Das
  // ist der richtige Weg, wenn ein Vermittler wie Tailscale Funnel davor
  // sitzt: der spricht den Dienst über 127.0.0.1 an, und niemand sonst –
  // auch nicht jemand im selben WLAN – kann dann noch direkt auf den Port.
  // Zusammen mit FT_HTTP=1 (Verschlüsselung übernimmt dann der Vermittler)
  // ergibt das eine saubere Aufteilung, ohne dass unterwegs irgendwo
  // unverschlüsselt durchs Netz geht.
  server.listen(PORTS[index], process.env.FT_HOST || '0.0.0.0', () => {
    const port = PORTS[index];
    const lan = lanAddress();

    console.log('');
    console.log('  FreundeTracker läuft.');
    console.log('');
    console.log('  Auf diesem Laptop:  ' + scheme + '://localhost:' + port);
    if (lan) console.log('  Auf dem Handy:      ' + scheme + '://' + lan + ':' + port);
    console.log('');

    if (scheme === 'https' && lan && !certCoversAddress(lan)) {
      console.log('  ACHTUNG: Das Zertifikat gilt nicht für ' + lan + '.');
      console.log('  Offenbar ist der Laptop in einem anderen Netz als zuletzt.');
      console.log('  Vom Handy aus gibt es damit einen Zertifikatsfehler.');
      console.log('  Neu erstellen (in Git Bash, im Projektordner):');
      console.log('');
      console.log('    openssl req -x509 -newkey rsa:2048 -nodes \\');
      console.log('      -keyout certs/key.pem -out certs/cert.pem -days 825 \\');
      console.log('      -subj "//CN=FreundeTracker" \\');
      console.log('      -addext "subjectAltName=IP:' + lan + ',IP:127.0.0.1,DNS:localhost" \\');
      console.log('      -addext "basicConstraints=critical,CA:FALSE" \\');
      console.log('      -addext "keyUsage=critical,digitalSignature,keyEncipherment" \\');
      console.log('      -addext "extendedKeyUsage=serverAuth"');
    } else if (scheme === 'https') {
      console.log('  Hinweis: Das Zertifikat ist selbst erstellt. Handy und Browser');
      console.log('  zeigen einmalig eine Warnung – dort auf „Erweitert" und');
      console.log('  „Trotzdem fortfahren" tippen.');
    } else {
      console.log('  Achtung: ohne Zertifikat nur HTTP. Am Handy funktionieren dann');
      console.log('  Anmeldung, Kamera und Kopieren nicht.');
    }

    console.log('');
    console.log('  Beenden mit Strg+C oder Fenster schließen.');
    console.log('');
  });
}

listen();
