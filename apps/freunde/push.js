/* ==========================================================================
   FreundeTracker – Push-Benachrichtigungen
   --------------------------------------------------------------------------
   Web Push komplett mit Node-Bordmitteln (`node:crypto`) – wie das ganze
   Projekt ohne npm-Abhängigkeit. Das ist machbar, weil Web Push nur zwei
   Standards braucht, die Node beide kann:

   1. VAPID (RFC 8292): Der Server weist sich beim Push-Dienst von Google,
      Mozilla oder Apple mit einem signierten Token aus. Das ist ein JWT,
      signiert mit ES256 (elliptische Kurve P-256).

   2. Nachrichtenverschlüsselung (RFC 8291, „aes128gcm"): Der Push-Dienst
      liegt zwischen uns und dem Handy und darf den Inhalt nicht lesen
      können. Deshalb wird jede Nachricht mit einem Schlüssel verschlüsselt,
      der aus einem flüchtigen Schlüsselpaar und den beiden Werten aus dem
      Abo (p256dh, auth) abgeleitet wird.

   Der Serverschlüssel liegt in `certs/vapid.json` (dort, wo auch sonst
   Schlüsselmaterial liegt) und wird beim ersten Start erzeugt. Er darf sich
   NICHT ändern: Alle bestehenden Abos hängen daran und würden ungültig.
   ========================================================================== */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const KEY_FILE = path.join(__dirname, 'certs', 'vapid.json');

/* ----------------------------- base64url --------------------------------- */
const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (str) => Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/* --------------------------- Serverschlüssel ------------------------------ */

/**
 * Lädt das VAPID-Schlüsselpaar oder erzeugt es beim ersten Mal.
 * Der öffentliche Teil wandert zum Browser (er bindet das Abo daran), der
 * private bleibt hier und signiert jede Anfrage an den Push-Dienst.
 */
function loadKeys() {
  try {
    return JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  } catch { /* noch nicht vorhanden – gleich erzeugen */ }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });

  // Unkomprimierter Punkt: 0x04 || X || Y – so erwartet ihn die Push-API.
  const roh = Buffer.concat([Buffer.from([4]), fromB64url(jwk.x), fromB64url(jwk.y)]);

  const keys = {
    publicKey: b64url(roh),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    // Der private Skalar wird für ECDH gebraucht (siehe verschluesseln()).
    privateKeyD: privateKey.export({ format: 'jwk' }).d
  };

  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, JSON.stringify(keys, null, 2));
  return keys;
}

let keys = null;
const getKeys = () => (keys ||= loadKeys());
const publicKey = () => getKeys().publicKey;

/* ------------------------------- VAPID-Token ------------------------------ */

/** Signiertes Token für genau einen Push-Dienst (aud = dessen Herkunft). */
function vapidToken(endpoint, kontakt) {
  const { origin } = new URL(endpoint);
  const kopf = { typ: 'JWT', alg: 'ES256' };
  const inhalt = {
    aud: origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: kontakt
  };

  const daten = `${b64url(JSON.stringify(kopf))}.${b64url(JSON.stringify(inhalt))}`;
  // dsaEncoding: Node liefert sonst DER; JWT verlangt die rohen r||s-Werte.
  const signatur = crypto.sign('sha256', Buffer.from(daten), {
    key: crypto.createPrivateKey(getKeys().privateKeyPem),
    dsaEncoding: 'ieee-p1363'
  });

  return `${daten}.${b64url(signatur)}`;
}

/* ---------------------------- Verschlüsselung ----------------------------- */

const hkdf = (salt, ikm, info, laenge) =>
  Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, laenge));

const infoFeld = (text) => Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])]);

/**
 * Verschlüsselt den Nachrichtentext für genau ein Abo (RFC 8291).
 * Für jede Nachricht entsteht ein neues flüchtiges Schlüsselpaar – dadurch
 * lässt sich aus einer abgefangenen Nachricht nichts über die nächste lernen.
 */
function verschluesseln(text, p256dh, auth) {
  const empfaenger = fromB64url(p256dh);
  const authGeheimnis = fromB64url(auth);

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const eigenerPubkey = ecdh.getPublicKey();
  const gemeinsam = ecdh.computeSecret(empfaenger);

  // Schritt 1: aus gemeinsamem Geheimnis + auth wird das Ausgangsmaterial.
  const schluesselInfo = Buffer.concat([
    infoFeld('WebPush: info'), empfaenger, eigenerPubkey
  ]);
  const ikm = hkdf(authGeheimnis, gemeinsam, schluesselInfo, 32);

  // Schritt 2: daraus Inhaltsschlüssel und Nonce.
  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, infoFeld('Content-Encoding: aes128gcm'), 16);
  const nonce = hkdf(salt, ikm, infoFeld('Content-Encoding: nonce'), 12);

  // 0x02 ist die Füll-Markierung; sie gehört mit in den verschlüsselten Teil.
  const klartext = Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const chiffre = Buffer.concat([cipher.update(klartext), cipher.final(), cipher.getAuthTag()]);

  // Kopf des Datenstroms: salt | Datensatzgröße | Länge des Pubkeys | Pubkey
  const groesse = Buffer.alloc(4);
  groesse.writeUInt32BE(4096, 0);
  return Buffer.concat([
    salt, groesse, Buffer.from([eigenerPubkey.length]), eigenerPubkey, chiffre
  ]);
}

/* -------------------------------- Versand -------------------------------- */

/**
 * Schickt eine Nachricht an ein Abo.
 * @returns {Promise<{ok:boolean, status:number, veraltet:boolean}>}
 *          `veraltet` heißt: Der Push-Dienst kennt das Abo nicht mehr
 *          (App deinstalliert, Benachrichtigungen abgeschaltet). Solche Abos
 *          gehören gelöscht, sonst sammeln sich Karteileichen an.
 */
function senden(abo, nachricht, kontakt) {
  return new Promise((resolve) => {
    let koerper;
    try {
      koerper = verschluesseln(JSON.stringify(nachricht), abo.p256dh, abo.auth);
    } catch (error) {
      return resolve({ ok: false, status: 0, veraltet: false, fehler: error.message });
    }

    const url = new URL(abo.endpoint);
    const anfrage = https.request({
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'Authorization': `vapid t=${vapidToken(abo.endpoint, kontakt)}, k=${publicKey()}`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': koerper.length,
        'TTL': 86400
      }
    }, (antwort) => {
      antwort.resume();   // Inhalt verwerfen, aber die Verbindung sauber schließen
      const status = antwort.statusCode || 0;
      resolve({ ok: status >= 200 && status < 300, status, veraltet: status === 404 || status === 410 });
    });

    anfrage.on('error', (error) =>
      resolve({ ok: false, status: 0, veraltet: false, fehler: error.message }));
    anfrage.write(koerper);
    anfrage.end();
  });
}

// `verschluesseln` wird mit exportiert, damit sie prüfbar ist: Ein Test kann
// die Rolle des Browsers einnehmen und die Nachricht wieder entschlüsseln.
// Bei Verschlüsselung ist „sieht richtig aus" wertlos – entweder es lässt
// sich gegenprüfen oder man weiß es nicht.
module.exports = { publicKey, senden, verschluesseln };
