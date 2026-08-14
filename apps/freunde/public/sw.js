/* ==========================================================================
   FreundeTracker – Service Worker
   --------------------------------------------------------------------------
   Zweck: (1) Chrome verlangt einen registrierten Service Worker mit
   Fetch-Handler, bevor „Zum Startbildschirm hinzufügen" als echte
   App-Installation angeboten wird. (2) Die statische App-Hülle (HTML/CSS/JS)
   wird gecacht, damit die App auch ohne Verbindung startet.

   /api/-Aufrufe werden bewusst NIE gecacht – die Daten (Gruppen, Ausgaben,
   Saldo) sollen immer frisch vom Server kommen, nie aus einem alten Stand.

   -------------------------------------------------------------------------
   ERST NETZ, Speicher nur als Rückfall (seit 2026-08-06).

   Vorher lief die App-Hülle nach „stale-while-revalidate": erst aus dem
   Speicher antworten, im Hintergrund aktualisieren. Das kostete bei JEDER
   Änderung einen App-Start Verzögerung – beim Öffnen lief noch der vorige
   Codestand, erst der zweite Start zeigte den neuen. Beim Testen des
   Rechnungs-Scanners hat genau das für Verwirrung gesorgt: gemessen wurde
   teils die alte Fassung.

   Verschärfend kam dazu, dass der Browser eine neue Fassung von sw.js nur
   holt, wenn sich DIESE Datei ändert. Ändert sich nur app.js oder
   receipt.js, wird der Speicher gar nicht erst neu aufgebaut.

   Deshalb jetzt umgekehrt: zuerst das Netz fragen, den Speicher nur
   benutzen, wenn keine Verbindung da ist. Im eigenen WLAN kostet das kaum
   messbar Zeit; ein alter Codestand, den man für den neuen hält, kostet
   dagegen eine halbe Stunde Fehlersuche. Unveränderliche Dateien (Icons)
   laufen weiterhin zuerst aus dem Speicher – da gibt es nichts zu verpassen.
   ========================================================================== */

const CACHE_NAME = 'freundetracker-v4';

// Dateien, die sich nie ändern, ohne dass sich ihr Name ändert: hier bleibt
// „erst Speicher" richtig – sie sind groß(-ish), unveränderlich und man
// gewinnt nichts, sie jedes Mal neu zu holen.
const IMMUTABLE_RE = /^\/icons\//;

const SHELL_FILES = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/account.js',
  '/payments.js',
  '/receipt.js',
  '/invite.js',
  '/store.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Nur die eigene App-Hülle behandeln – API-Aufrufe und fremde Origins
  // laufen unverändert direkt durch (kein respondWith = normales Verhalten).
  if (event.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Icons: erst Speicher (siehe IMMUTABLE_RE oben).
  if (IMMUTABLE_RE.test(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetchAndStore(event.request))
    );
    return;
  }

  // App-Hülle: erst Netz, Speicher nur als Rückfall.
  event.respondWith(
    fetchAndStore(event.request).catch(() =>
      // Keine Verbindung. Der genaue Treffer zuerst; für eine Navigation
      // (Adresse aufrufen, App starten) notfalls die Startseite, sonst
      // stünde man trotz gefülltem Speicher vor einer Fehlerseite.
      caches.match(event.request).then((cached) =>
        cached || (event.request.mode === 'navigate' ? caches.match('/index.html') : undefined)
      )
    )
  );
});

/* ------------------------- Push-Benachrichtigungen -----------------------
   Der Server schickt den Inhalt verschlüsselt; hier kommt er entschlüsselt
   an. Anzeigen ist Pflicht: Browser erlauben ein Push-Abo nur, wenn auf
   jede Nachricht auch wirklich eine sichtbare Benachrichtigung folgt.
   Deshalb notfalls ein neutraler Text statt gar nichts. */
self.addEventListener('push', (event) => {
  let inhalt = {};
  try { inhalt = event.data ? event.data.json() : {}; } catch { /* Notfalltext unten */ }

  event.waitUntil(self.registration.showNotification(inhalt.titel || 'FreundeTracker', {
    body: inhalt.text || 'Es gibt etwas Neues.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { ziel: inhalt.ziel || '/' },
    // Gleiches Kennzeichen = neue Meldung ersetzt die alte, statt den
    // Sperrbildschirm mit Wiederholungen zuzustellen.
    tag: inhalt.titel || 'freundetracker'
  }));
});

/* Antippen soll ein bereits offenes Fenster nach vorn holen, statt ein
   zweites daneben zu öffnen – sonst hat man die App am Ende dreimal auf. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const ziel = event.notification.data?.ziel || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((fenster) => {
      const offen = fenster.find((f) => f.url.includes(self.location.origin));
      if (offen) return offen.focus();
      return self.clients.openWindow(ziel);
    })
  );
});

/** Holt aus dem Netz und legt eine Kopie in den Speicher (für den Offline-Fall). */
function fetchAndStore(request) {
  return fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
    }
    return response;
  });
}
