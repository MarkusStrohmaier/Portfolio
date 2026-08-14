/* ==========================================================================
   FreundeTracker – API
   --------------------------------------------------------------------------
   Alle /api/… Anfragen. Die Anmeldung wird hier serverseitig geprüft – das
   Frontend kann sie also nicht mehr umgehen.

   Sitzung: zufälliges Token in einem httpOnly-Cookie. Das JavaScript der
   Seite kommt nicht daran, ein gestohlenes Token lässt sich also nicht
   einfach über die Konsole auslesen.
   ========================================================================== */

const db = require('./db');
const push = require('./push');

// Pflichtangabe für VAPID: Der Push-Dienst will wissen, an wen er sich bei
// Problemen wenden kann. Muss eine mailto:- oder https:-Adresse sein.
const PUSH_KONTAKT = process.env.FT_PUSH_CONTACT || 'mailto:admin@freundetracker.local';

/**
 * Verschickt Benachrichtigungen an ein Konto – ohne die laufende Anfrage
 * aufzuhalten und ohne sie scheitern zu lassen. Eine nicht zugestellte
 * Benachrichtigung ist ärgerlich; ein deswegen fehlgeschlagener
 * Speichervorgang wäre deutlich schlimmer.
 */
function benachrichtige(userId, nachricht) {
  const abos = db.pushSubscriptionsOf(userId);
  abos.forEach((abo) => {
    push.senden(abo, nachricht, PUSH_KONTAKT)
      .then((ergebnis) => {
        // Abos, die der Push-Dienst nicht mehr kennt, sofort wegräumen –
        // sonst versucht der Server sie bei jedem Mal erneut.
        if (ergebnis.veraltet) db.dropPushSubscription(abo.endpoint);
      })
      .catch(() => { /* still bleiben: siehe Kommentar oben */ });
  });
}

const COOKIE_NAME = 'ft_session';
const MAX_BODY = 12 * 1024 * 1024;   // Profilbilder als data-URL brauchen Platz

/* --------------------------------- Helfer -------------------------------- */

function readCookies(req) {
  const header = req.headers.cookie || '';
  const jar = {};

  header.split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index < 0) return;
    jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  });

  return jar;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new db.ApiError(413, 'Die Daten sind zu groß.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new db.ApiError(400, 'Ungültige Daten.'));
      }
    });

    req.on('error', reject);
  });
}

function sendJson(res, status, payload, cookie = null) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
  if (cookie) headers['Set-Cookie'] = cookie;

  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

/** Secure setzen wir nur bei https – sonst verwirft der Browser das Cookie. */
const sessionCookie = (token, secure) =>
  `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 90}` +
  (secure ? '; Secure' : '');

const clearCookie = (secure) =>
  `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` + (secure ? '; Secure' : '');

/* ---------------------- Bremse gegen Passwort-Raten ----------------------
   Passwörter sind zwar mit scrypt gehasht, aber ohne Bremse kann ein Skript
   beliebig schnell Passwörter durchprobieren. Im eigenen WLAN ist das
   verschmerzbar; sobald die App von außen erreichbar ist (Tailscale Funnel
   o. Ä.), wird sie binnen Stunden von Scannern gefunden.

   Bewusst eine BREMSE und keine Sperre: das Konto wird nie dauerhaft
   verriegelt, die Wartezeit wächst nur und ist gedeckelt. Eine echte Sperre
   könnte ein Angreifer missbrauchen, um jemanden gezielt auszusperren.

   Die Zähler stehen absichtlich nur im Arbeitsspeicher: ein Schreibzugriff
   auf die Datenbank bei jedem Fehlversuch wäre selbst ein Angriffsziel. Ein
   Serverneustart setzt sie zurück – das ist hinnehmbar, weil ein Angreifer
   den Neustart nicht auslösen kann.
   ------------------------------------------------------------------------ */

const LOGIN_RULES = {
  // Pro Konto: der eigentliche Schutz. Greift unabhängig davon, von wo die
  // Versuche kommen – ein Angreifer gewinnt also nichts, indem er die
  // Adresse wechselt.
  konto:   { free: 3,  baseMs: 2_000, maxMs: 5 * 60_000 },
  // Pro Herkunftsadresse: bremst zusätzlich das Durchprobieren VIELER Konten
  // von einer Stelle aus. Großzügiger angesetzt, weil sich hinter einer
  // Adresse mehrere berechtigte Leute verbergen können (gemeinsames WLAN).
  adresse: { free: 12, baseMs: 1_000, maxMs: 15 * 60_000 }
};

const LOGIN_FORGET_MS = 60 * 60_000;   // nach einer Stunde Ruhe wieder vergessen
const loginFails = new Map();          // Schlüssel -> { fails, until, seen }

/**
 * Schlüssel, unter denen dieser Versuch gezählt wird.
 *
 * Loopback-Adressen werden bewusst ÜBERSPRUNGEN: steht später ein
 * Gegenstelle-Dienst wie Tailscale Funnel davor, kommen alle Anfragen von
 * 127.0.0.1 – die Adressbremse würde dann alle Nutzer gemeinsam ausbremsen,
 * sobald ein Einziger herumprobiert. Die Kontobremse greift weiterhin.
 * Wenn Funnel scharf geschaltet wird, ist hier die Stelle, an der die echte
 * Absenderadresse aus dem Weiterleitungs-Kopf gelesen werden müsste – aber
 * nur mit ausdrücklicher Entscheidung, welchem Vermittler man traut
 * (ungeprüft übernommen wäre der Kopf frei fälschbar und die Bremse wertlos).
 */
function loginKeys(req, email) {
  const keys = [`konto:${String(email || '').trim().toLowerCase()}`];
  const addr = req.socket?.remoteAddress || '';
  const loopback = addr === '::1' || addr.startsWith('127.') || addr === '::ffff:127.0.0.1';
  if (addr && !loopback) keys.push(`adresse:${addr}`);
  return keys;
}

const ruleFor = (key) => LOGIN_RULES[key.slice(0, key.indexOf(':'))];

/** Wirft 429, solange die Wartezeit für einen der Schlüssel noch läuft. */
function assertLoginAllowed(keys) {
  const now = Date.now();
  let waitMs = 0;

  for (const key of keys) {
    const entry = loginFails.get(key);
    if (entry && entry.until > now) waitMs = Math.max(waitMs, entry.until - now);
  }
  if (!waitMs) return;

  const seconds = Math.ceil(waitMs / 1000);
  const text = seconds >= 60
    ? `${Math.ceil(seconds / 60)} Minuten`
    : `${seconds} Sekunden`;
  throw new db.ApiError(429, `Zu viele Fehlversuche. Bitte in ${text} noch einmal versuchen.`);
}

function noteLoginFailure(keys) {
  const now = Date.now();

  for (const key of keys) {
    const rule = ruleFor(key);
    const entry = loginFails.get(key) || { fails: 0, until: 0, seen: now };
    entry.fails += 1;
    entry.seen = now;

    // Die ersten Versuche bleiben frei – wer sich schlicht vertippt, soll
    // nicht sofort warten müssen. Danach verdoppelt sich die Wartezeit.
    const over = entry.fails - rule.free;
    entry.until = over > 0
      ? now + Math.min(rule.maxMs, rule.baseMs * 2 ** (over - 1))
      : 0;

    loginFails.set(key, entry);
  }

  // Aufräumen, damit die Liste nicht unbegrenzt wächst.
  if (loginFails.size > 500) {
    for (const [key, entry] of loginFails) {
      if (now - entry.seen > LOGIN_FORGET_MS) loginFails.delete(key);
    }
  }
}

/** Nach erfolgreicher Anmeldung ist die Vorgeschichte hinfällig. */
function clearLoginFailures(keys) {
  keys.forEach((key) => loginFails.delete(key));
}

/** Wirft, wenn niemand angemeldet ist – schützt alle privaten Endpunkte. */
function requireUser(req) {
  const token = readCookies(req)[COOKIE_NAME];
  const user = db.userByToken(token);
  if (!user) throw new db.ApiError(401, 'Nicht angemeldet.');
  return { user, token };
}

/* --------------------------------- Routen -------------------------------- */

async function handleApi(req, res, { secure }) {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  try {
    // Routen mit einem Platzhalter im Pfad (Gruppen-ID, Einladungs-Token)
    // lassen sich nicht als switch-Literal schreiben – deshalb vorab per
    // Muster geprüft, bevor der Rest wie gewohnt über den switch läuft.
    const groupInvite = route.match(/^POST \/api\/groups\/([^/]+)\/invite$/);
    if (groupInvite) {
      const { user } = requireUser(req);
      const token = db.createInvite(decodeURIComponent(groupInvite[1]), user.id);
      return sendJson(res, 200, { token });
    }

    // Admin-Rechte geben/entziehen. Eigener Endpunkt statt über den normalen
    // Datenstand: Rechte gehören nicht in einen Payload, den jeder Client
    // frei zusammenstellt.
    const groupAdmin = route.match(/^POST \/api\/groups\/([^/]+)\/admin$/);
    if (groupAdmin) {
      const { user } = requireUser(req);
      const body = await readBody(req);
      return sendJson(res, 200, db.setGroupAdmin(
        decodeURIComponent(groupAdmin[1]), user.id, body.name, Boolean(body.isAdmin)
      ));
    }

    // Änderungsverlauf einer Gruppe. Nur ein Admin darf das sehen
    // (assertGroupAdmin in db.js, wie beim Admin-Endpunkt oben).
    const groupAudit = route.match(/^GET \/api\/groups\/([^/]+)\/audit$/);
    if (groupAudit) {
      const { user } = requireUser(req);
      return sendJson(res, 200, db.getAuditLog(decodeURIComponent(groupAudit[1]), user.id));
    }

    // Passwort-Reset-Link für ein Gruppenmitglied erzeugen. Nur ein Admin
    // darf das (assertGroupAdmin in db.js) – siehe Kommentar bei der
    // password_resets-Tabelle zur Begründung des Wegs (kein Mailserver).
    const resetCreate = route.match(/^POST \/api\/groups\/([^/]+)\/members\/([^/]+)\/reset-link$/);
    if (resetCreate) {
      const { user } = requireUser(req);
      const token = db.createPasswordResetLink(
        decodeURIComponent(resetCreate[1]), user.id, decodeURIComponent(resetCreate[2])
      );
      return sendJson(res, 200, { token });
    }

    // Vorschau der Reset-Seite: bewusst OHNE Anmeldung erreichbar (wer den
    // Link hat, ist ja gerade ausgesperrt) und OHNE sensible Daten – nur der
    // Name, damit man sieht "für wen ist das".
    const resetInfo = route.match(/^GET \/api\/password-reset\/([^/]+)$/);
    if (resetInfo) {
      return sendJson(res, 200, db.getPasswordResetInfo(decodeURIComponent(resetInfo[1])));
    }

    const resetRedeem = route.match(/^POST \/api\/password-reset\/([^/]+)$/);
    if (resetRedeem) {
      const body = await readBody(req);
      const { user, sessionToken } = db.redeemPasswordReset(decodeURIComponent(resetRedeem[1]), body.password);
      return sendJson(res, 200, user, sessionCookie(sessionToken, secure));
    }

    const groupLeave = route.match(/^POST \/api\/groups\/([^/]+)\/leave$/);
    if (groupLeave) {
      const { user } = requireUser(req);
      const { neuerAdmin } = db.leaveGroup(decodeURIComponent(groupLeave[1]), user.id);
      return sendJson(res, 200, { ok: true, neuerAdmin });
    }

    const groupDelete = route.match(/^DELETE \/api\/groups\/([^/]+)$/);
    if (groupDelete) {
      const { user } = requireUser(req);
      db.deleteGroupExplicit(decodeURIComponent(groupDelete[1]), user.id);
      return sendJson(res, 200, { ok: true });
    }

    const inviteJoin = route.match(/^POST \/api\/invite\/([^/]+)\/join$/);
    if (inviteJoin) {
      const { user } = requireUser(req);
      const body = await readBody(req);
      const { groupId, benachrichtigungen } = db.joinViaInvite(
        decodeURIComponent(inviteJoin[1]), user.id, body.claimName || null
      );
      // Erst nachdem der Beitritt steht – siehe benachrichtige() oben.
      (benachrichtigungen || []).forEach((n) => benachrichtige(n.empfaengerId, n));
      return sendJson(res, 200, { groupId });
    }

    // Belege liegen bewusst NICHT im normalen Datenstand (siehe db.js):
    // sonst würde jedes Speichern sämtliche Fotos erneut hochladen.
    const receiptGet = route.match(/^GET \/api\/receipts\/([^/]+)$/);
    if (receiptGet) {
      const { user } = requireUser(req);
      return sendJson(res, 200, db.getReceipt(user.id, decodeURIComponent(receiptGet[1])));
    }

    const inviteInfo = route.match(/^GET \/api\/invite\/([^/]+)$/);
    if (inviteInfo) {
      // Öffentlich einsehbar – die Vorschau muss vor dem Anmelden sichtbar sein.
      return sendJson(res, 200, db.getInviteInfo(decodeURIComponent(inviteInfo[1])));
    }

    switch (route) {

      case 'POST /api/register': {
        const body = await readBody(req);
        const user = db.register(body);
        const token = db.createSession(user.id);
        return sendJson(res, 201, user, sessionCookie(token, secure));
      }

      case 'POST /api/login': {
        const body = await readBody(req);
        const keys = loginKeys(req, body.email);

        // Erst bremsen, DANN prüfen: solange die Wartezeit läuft, wird das
        // Passwort gar nicht erst gerechnet – das hält auch den Server frei.
        assertLoginAllowed(keys);

        let user;
        try {
          user = db.login(body.email, body.password);
        } catch (error) {
          if (error instanceof db.ApiError && error.status === 401) noteLoginFailure(keys);
          throw error;
        }

        clearLoginFailures(keys);
        const token = db.createSession(user.id);
        return sendJson(res, 200, user, sessionCookie(token, secure));
      }

      // Schaufenster-Fassung (Portfolio-Demo): Die App meldet sich beim
      // Laden von selbst hierueber an, es gibt keine Anmeldemaske mehr.
      // Antwortet deshalb mit dem Konto als JSON (nicht mit einer
      // Weiterleitung) – der Aufruf kommt aus fetch(), nicht aus einem Link.
      // Das Konto samt Beispieldaten entsteht beim ersten Aufruf.
      case 'GET /api/demo-login': {
        const user = db.ensureDemoUser();
        const token = db.createSession(user.id);
        return sendJson(res, 200, user, sessionCookie(token, secure));
      }

      /* Schaufenster-Fassung: Alles, was das gemeinsame Demo-Konto
         unbrauchbar machen könnte, ist hier abgeschaltet – nicht nur die
         Knöpfe im Frontend, sondern der Endpunkt selbst. Ein ausgeblendeter
         Knopf hält niemanden auf, der die Entwicklerkonsole öffnet.

           abmelden        → Anmeldemaske ohne Zugangsdaten für alle danach
           Konto löschen   → Demo-Konto samt Beispieldaten endgültig weg
           Passwort ändern → beendet alle Sitzungen, sperrt das Konto zu   */
      case 'POST /api/logout':
      case 'DELETE /api/me':
      case 'POST /api/me/password':
        return sendJson(res, 403, { error: 'In der Demo nicht möglich.' });

      case 'GET /api/me': {
        const token = readCookies(req)[COOKIE_NAME];
        return sendJson(res, 200, db.userByToken(token));   // null = nicht angemeldet
      }

      case 'PATCH /api/me': {
        const { user } = requireUser(req);
        const body = await readBody(req);
        return sendJson(res, 200, db.updateUser(user.id, body));
      }

      // (Passwort ändern und Konto löschen: siehe gesperrter Zweig oben.)

      case 'GET /api/data': {
        const { user } = requireUser(req);
        return sendJson(res, 200, db.loadData(user.id));
      }

      case 'PUT /api/data': {
        const { user } = requireUser(req);
        const body = await readBody(req);
        const { asOf, benachrichtigungen } = db.saveData(user.id, body);

        // Erst nachdem gespeichert ist – siehe benachrichtige(). Titel/Text
        // kommen jetzt fertig aus db.js (vier Anlässe statt einem seit
        // Nr. 5: Zahlung gemeldet/bestätigt, neue Ausgabe – der vierte,
        // Gruppenbeitritt, läuft über den eigenen Endpunkt oben).
        (benachrichtigungen || []).forEach((n) => benachrichtige(n.empfaengerId, n));

        return sendJson(res, 200, { ok: true, asOf });
      }

      /* -------------------------- Push-Abos --------------------------- */

      case 'GET /api/push/key': {
        // Öffentlich: der Browser braucht den Schlüssel, um überhaupt ein Abo
        // anlegen zu können. Er ist zum Veröffentlichen gedacht.
        return sendJson(res, 200, { key: push.publicKey() });
      }

      case 'POST /api/push/subscribe': {
        const { user } = requireUser(req);
        const body = await readBody(req);
        return sendJson(res, 200, db.savePushSubscription(user.id, body.subscription));
      }

      case 'POST /api/push/unsubscribe': {
        const { user } = requireUser(req);
        const body = await readBody(req);
        return sendJson(res, 200, db.deletePushSubscription(user.id, body.endpoint));
      }

      case 'POST /api/push/test': {
        // Damit man beim Einschalten sofort sieht, ob es wirklich ankommt –
        // sonst merkt man einen kaputten Aufbau erst Wochen später.
        const { user } = requireUser(req);
        if (!db.hasPushSubscription(user.id)) {
          throw new db.ApiError(400, 'Für dieses Konto ist noch kein Gerät angemeldet.');
        }
        benachrichtige(user.id, {
          titel: 'FreundeTracker',
          text: 'Benachrichtigungen funktionieren.',
          ziel: '/'
        });
        return sendJson(res, 200, { ok: true });
      }

      case 'POST /api/receipts': {
        const { user } = requireUser(req);
        const body = await readBody(req);
        return sendJson(res, 201, { id: db.saveReceipt(user.id, body) });
      }

      default:
        return sendJson(res, 404, { error: 'Unbekannter Endpunkt.' });
    }
  } catch (error) {
    if (error instanceof db.ApiError) {
      return sendJson(res, error.status, { error: error.message });
    }

    console.error('API-Fehler:', error);
    return sendJson(res, 500, { error: 'Auf dem Server ist etwas schiefgelaufen.' });
  }
}

module.exports = { handleApi };
