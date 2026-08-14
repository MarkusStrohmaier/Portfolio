/* ==========================================================================
   FreundeTracker – Datenbank (serverseitig)
   --------------------------------------------------------------------------
   SQLite über das in Node 24 eingebaute Modul „node:sqlite" – dadurch eine
   echte relationale Datenbank ohne npm-Abhängigkeiten.

   Die Datei liegt unter data/freundetracker.db. Passwörter werden mit scrypt
   und zufälligem Salt abgelegt, niemals im Klartext. Sitzungen laufen über
   ein zufälliges Token, das als httpOnly-Cookie beim Browser liegt – JavaScript
   der Seite kommt also nicht heran.
   ========================================================================== */

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'freundetracker.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

/* --------------------------------- Schema -------------------------------- */

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL UNIQUE,
    avatar     TEXT,
    iban       TEXT NOT NULL DEFAULT '',
    paypal     TEXT NOT NULL DEFAULT '',
    phone      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    pw_salt    TEXT NOT NULL,
    pw_hash    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS groups (
    id       TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name     TEXT NOT NULL,
    position INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name     TEXT NOT NULL,
    position INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id       TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name     TEXT NOT NULL,
    position INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS expenses (
    id       TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    title    TEXT NOT NULL,
    amount   REAL NOT NULL,
    payer    TEXT NOT NULL,
    gift_for TEXT,
    date     TEXT NOT NULL,
    position INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS expense_participants (
    expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payments (
    id        TEXT PRIMARY KEY,
    group_id  TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    from_name TEXT NOT NULL,
    to_name   TEXT NOT NULL,
    amount    REAL NOT NULL,
    date      TEXT NOT NULL,
    position  INTEGER NOT NULL
  );

  -- Ein aktiver Einladungslink pro Gruppe. Einen neuen erzeugen ersetzt den
  -- alten automatisch (siehe createInvite) – Teilen eines neuen Links macht
  -- den vorherigen ungültig.
  CREATE TABLE IF NOT EXISTS group_invites (
    group_id   TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
    token      TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contacts (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name     TEXT NOT NULL,
    iban     TEXT NOT NULL DEFAULT '',
    paypal   TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (owner_id, name)
  );

  CREATE TABLE IF NOT EXISTS barcodes (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code     TEXT NOT NULL,
    title    TEXT NOT NULL,
    category TEXT NOT NULL,
    amount   REAL NOT NULL,
    PRIMARY KEY (owner_id, code)
  );

  CREATE INDEX IF NOT EXISTS idx_groups_owner   ON groups(owner_id);
  CREATE INDEX IF NOT EXISTS idx_members_group  ON group_members(group_id);
  CREATE INDEX IF NOT EXISTS idx_events_group   ON events(group_id);
  CREATE INDEX IF NOT EXISTS idx_expenses_event ON expenses(event_id);
  CREATE INDEX IF NOT EXISTS idx_parts_expense  ON expense_participants(expense_id);
  CREATE INDEX IF NOT EXISTS idx_payments_group ON payments(group_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);
`);

/* -------------------------------- Migration ------------------------------ */

/**
 * CREATE TABLE IF NOT EXISTS rührt bestehende Tabellen nicht an – neue Spalten
 * müssen deshalb einzeln nachgezogen werden, sonst verlieren vorhandene
 * Datenbanken beim Update ihre Daten oder brechen ab.
 */
function ensureColumn(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (existing.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn('expenses', 'split_mode', "TEXT NOT NULL DEFAULT 'equal'");
ensureColumn('expense_participants', 'weight', 'REAL');
ensureColumn('groups', 'avatar', 'TEXT');

// Archivieren (2026-08-09): abgeschlossene Reisen/Projekte sollen aus dem
// Weg, aber nicht weg sein – anders als Löschen bleibt alles (Salden,
// Historie) erhalten, nur außer Sicht. Bewusst ein geteiltes Feld wie
// Name/Bild (nicht pro Konto): ist eine Reise für einen vorbei, ist sie es
// für alle. Jedes Mitglied darf umschalten, keine Admin-Beschränkung nötig
// – anders als bei Mitgliedern/Einladungen geht dabei nichts kaputt, das
// sich nicht mit einem zweiten Klick zurückdrehen ließe.
ensureColumn('groups', 'archived', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('events', 'archived', 'INTEGER NOT NULL DEFAULT 0');

/* Änderungsverlauf (2026-08-09) – wer hat wann was in der Gruppe geändert.
   Nur für Admins einsehbar (Vertrauensfrage bei einer Geld-App: aktuell
   kann jedes Mitglied jede Ausgabe ändern oder löschen, ohne dass irgendwo
   eine Spur bleibt). Namen statt Konto-IDs, passend zur Namens-Identität-
   Regel im ganzen Projekt – der Name zum Zeitpunkt der Änderung wird
   eingefroren, damit der Verlauf auch nach einer späteren Umbenennung noch
   lesbar bleibt (kein JOIN auf users nötig, keine Kopplung an ein Konto,
   das später vielleicht gelöscht wird).

   BEWUSST OHNE Fremdschlüssel auf groups(id): Die erste Fassung hatte hier
   `REFERENCES groups(id) ON DELETE CASCADE` – und damit denselben Fehler wie
   seinerzeit group_invites. `saveData()` löscht und schreibt die eigenen
   Gruppen bei JEDEM Speichern komplett neu (Standardmuster im Projekt); die
   Kaskade riss dabei jedes Mal den gesamten Verlauf der Gruppe mit. Ein
   Verlauf, der bei jedem Speichern von vorn beginnt, ist wertlos. Die
   Aufräumarbeit für wirklich gelöschte Gruppen macht stattdessen
   `pruneAudit()` weiter unten. */
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id         TEXT PRIMARY KEY,
    group_id   TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    action     TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

// Migration für Datenbanken, die die erste (kaskadierende) Fassung schon
// angelegt haben: Tabelle ohne Fremdschlüssel neu aufbauen, Inhalt behalten.
if (db.prepare('PRAGMA foreign_key_list(audit_log)').all().length > 0) {
  db.exec('ALTER TABLE audit_log RENAME TO audit_log_alt');
  db.exec(`
    CREATE TABLE audit_log (
      id         TEXT PRIMARY KEY,
      group_id   TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      action     TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.exec('INSERT INTO audit_log SELECT id, group_id, actor_name, action, created_at FROM audit_log_alt');
  db.exec('DROP TABLE audit_log_alt');
}

db.exec('CREATE INDEX IF NOT EXISTS idx_audit_group ON audit_log(group_id, created_at)');

// Einmal beim Start: Verläufe von Gruppen wegräumen, die es nicht mehr gibt
// (das erledigte früher die Kaskade). Bewusst hier und nicht in logAudit –
// Begründung bei pruneVerwaisteAudits().
pruneVerwaisteAudits();

// Gescannte Kassenbons. Bewusst eine EIGENE Tabelle mit eigenen Endpunkten
// statt eines Felds im normalen Datenstand: `saveData` schickt immer den
// kompletten Bestand: Fotos dort hineinzulegen hieße, bei jeder kleinen
// Änderung sämtliche Belegfotos erneut hochzuladen. Die Ausgabe merkt sich
// deshalb nur die kurze receipt_id.
db.exec(`
  CREATE TABLE IF NOT EXISTS receipts (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    photo      TEXT,
    items      TEXT,
    total      REAL,
    created_at TEXT NOT NULL
  )
`);
ensureColumn('expenses', 'receipt_id', 'TEXT');

/* Push-Abos. Ein Konto kann mehrere haben (Handy, Tablet, Laptop) – deshalb
   der Endpunkt als Schlüssel und nicht die Konto-ID. Fällt ein Konto weg,
   verschwinden seine Abos mit (CASCADE); veraltete Abos räumt der Versand
   selbst weg, sobald der Push-Dienst sie ablehnt. */
db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id)');

/* Passwort-Reset-Links (2026-08-09). Es gibt bewusst KEINEN Mailserver in
   diesem Projekt (kein npm, keine externe Abhängigkeit) – also auch keinen
   klassischen "Link per E-Mail"-Reset. Stattdessen erzeugt ein Admin der
   Gruppe einen Einmal-Link nach demselben Muster wie eine Einladung, den er
   demjenigen persönlich schickt (WhatsApp o. Ä.) – die Vertrauensbasis ist
   dieselbe wie bei einer Einladung: man kennt sich. Ein Konto kann immer
   nur EINEN offenen Link haben (ON CONFLICT ersetzt), gültig eine Stunde. */
db.exec(`
  CREATE TABLE IF NOT EXISTS password_resets (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )
`);

// Optionale erweiterte Einstellungen eines Anlasses (Zeitraum) – bewusst
// nullable, ein Anlass braucht das nicht zwingend.
ensureColumn('events', 'start_date', 'TEXT');
ensureColumn('events', 'end_date', 'TEXT');

// Mitgliedschaft an echte Konten: group_members kannte bisher nur group_id
// und name (reiner Platzhalter). id macht jede Zeile eindeutig ansprechbar
// (fürs Umbenennen/Verknüpfen), user_id verknüpft sie optional mit einem
// Konto – NULL bleibt ein Platzhalter-Mitglied wie bisher.
ensureColumn('group_members', 'id', 'TEXT');
ensureColumn('group_members', 'user_id', 'TEXT REFERENCES users(id) ON DELETE SET NULL');

// Für den Schutz vor veralteten Speichervorgängen (siehe saveData): Jede
// Zeile bekommt einen server-eigenen Erstellungszeitpunkt. Schickt ein
// Client einen Stand, der älter ist als eine Zeile, die im Payload fehlt,
// kann er sie unmöglich gekannt haben – sie wird dann nicht gelöscht,
// sondern beim Speichern unverändert wiederhergestellt.
ensureColumn('events', 'created_at', 'TEXT');
ensureColumn('expenses', 'created_at', 'TEXT');
ensureColumn('payments', 'created_at', 'TEXT');
ensureColumn('group_members', 'created_at', 'TEXT');

// Beim Beitritt über einen Einladungslink wird das übernommene Platzhalter-
// Mitglied auf den Kontonamen umbenannt ("Anna" -> "Anna Mueller"). Wer die
// Einladung verschickt hat, hat in seiner App aber noch den ALTEN Namen
// stehen. Speichert er, bevor er neu geladen hat, findet der Server zu
// "Anna" keine Zeile mehr, legt eine neue unverknüpfte an – und die
// verknüpfte fällt weg. Nachgewiesen: der Beigetretene flog dabei komplett
// aus der Gruppe. Deshalb merkt sich die Zeile ihren früheren Namen
// (claimed_from) und wann die Verknüpfung entstand (linked_at). Beides
// zusammen erlaubt es, einen veralteten Namen im Payload als dieselbe Person
// wiederzuerkennen, statt sie zu verdoppeln oder zu verlieren.
ensureColumn('group_members', 'claimed_from', 'TEXT');
ensureColumn('group_members', 'linked_at', 'TEXT');

// Zahlungen brauchen einen Zustand: Wer Geld ERHÄLT, kann eine Zahlung sofort
// verbuchen ("erhalten"). Wer Geld SCHULDET, kann sie nur melden – bestätigen
// muss sie der Empfänger. Gemeldete Zahlungen zählen bewusst NICHT zum Saldo,
// sonst könnte man seine Schuld einseitig für beglichen erklären.
ensureColumn('payments', 'status', 'TEXT');

// Admin-Rechte hängen seit 2026-08-07 am Mitglied, nicht mehr am Ersteller
// der Gruppe. Damit kann es MEHRERE Admins geben und die Rolle lässt sich
// weitergeben – vorher wäre eine Gruppe führungslos gewesen, sobald ihr
// Ersteller sie verlässt oder sein Konto löscht.
ensureColumn('group_members', 'is_admin', 'INTEGER');

// Bestandsdaten ohne bekannten Zeitpunkt: auf das älteste mögliche Datum
// setzen. Das macht sie nie "neuer als der Client-Snapshot" – sie verhalten
// sich dadurch wie bisher (Weglassen aus dem Payload gilt als Löschen),
// statt fälschlich vor jeder Löschung geschützt zu werden.
const EPOCH = '1970-01-01T00:00:00.000Z';
db.exec(`UPDATE events           SET created_at = '${EPOCH}' WHERE created_at IS NULL`);
db.exec(`UPDATE expenses         SET created_at = '${EPOCH}' WHERE created_at IS NULL`);
db.exec(`UPDATE payments         SET created_at = '${EPOCH}' WHERE created_at IS NULL`);
db.exec(`UPDATE group_members    SET created_at = '${EPOCH}' WHERE created_at IS NULL`);

// Bestandszahlungen gelten als bestätigt – sie stammen aus der Zeit, als es
// die Bestätigung noch nicht gab, und wurden bisher voll auf den Saldo
// gerechnet. Ohne diese Zeile würden sie plötzlich als „offen gemeldet"
// gelten und sämtliche Salden der Vergangenheit verändern.
db.exec(`UPDATE payments SET status = 'confirmed' WHERE status IS NULL`);

/* Bestandsgruppen: der bisherige Ersteller wird ihr erster Admin. Zwei
   Schritte, weil beides schiefgehen kann:
   1. Wer laut groups.owner_id der Ersteller ist, bekommt die Rolle.
   2. Bleibt eine Gruppe danach ganz ohne Admin (Ersteller war nie als
      Mitglied verknüpft oder ist ausgetreten), wird das erste verknüpfte
      Mitglied zum Admin. Eine Gruppe ohne Admin wäre sonst für immer
      führungslos – niemand könnte mehr einladen oder Mitglieder pflegen. */
db.exec(`
  UPDATE group_members SET is_admin = 1
  WHERE is_admin IS NULL
    AND user_id IS NOT NULL
    AND user_id = (SELECT owner_id FROM groups WHERE groups.id = group_members.group_id)
`);
db.exec(`UPDATE group_members SET is_admin = 0 WHERE is_admin IS NULL`);
db.prepare(`
  SELECT id FROM groups
  WHERE NOT EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = groups.id AND m.is_admin = 1)
`).all().forEach((g) => {
  const ersatz = db.prepare(
    'SELECT id FROM group_members WHERE group_id = ? AND user_id IS NOT NULL ORDER BY position LIMIT 1'
  ).get(g.id);
  if (ersatz) db.prepare('UPDATE group_members SET is_admin = 1 WHERE id = ?').run(ersatz.id);
});

/* Selbstheilung bei jedem Start, nicht nur einmalig bei der Migration
   (2026-08-09): Vor dem Fix oben blieb beim Verlassen/Löschen eines Kontos
   die is_admin-Markierung an der jetzt kontolosen Zeile hängen – eine
   Gruppe mit einem "Admin", den es nicht mehr gibt, war praktisch
   eingefroren. Betraf jede Gruppe, deren einziger Admin schon vor diesem
   Fix gegangen ist. Deshalb hier zweifach: verwaiste Markierungen weg,
   dann wie oben das erste verknüpfte Mitglied nachrücken lassen. */
db.exec('UPDATE group_members SET is_admin = 0 WHERE is_admin = 1 AND user_id IS NULL');
db.prepare(`
  SELECT id FROM groups
  WHERE NOT EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = groups.id AND m.is_admin = 1)
`).all().forEach((g) => {
  const ersatz = db.prepare(
    'SELECT id FROM group_members WHERE group_id = ? AND user_id IS NOT NULL ORDER BY position LIMIT 1'
  ).get(g.id);
  if (ersatz) db.prepare('UPDATE group_members SET is_admin = 1 WHERE id = ?').run(ersatz.id);
});

/* -------------------------------- Passwörter ----------------------------- */

const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { salt, hash };
}

function checkPassword(password, salt, expected) {
  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const target = Buffer.from(expected, 'hex');
  if (target.length !== actual.length) return false;
  return crypto.timingSafeEqual(actual, target);
}

/* --------------------------------- Helfer -------------------------------- */

const newId = (prefix) =>
  prefix + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

/** Nur unbedenkliche Felder – Salt und Hash verlassen die Datenbankschicht nie. */
const publicUser = (row) => row && {
  id: row.id,
  name: row.name,
  email: row.email,
  avatar: row.avatar || null,
  iban: row.iban || '',
  paypal: row.paypal || '',
  phone: row.phone || '',
  createdAt: row.created_at
};

/** Fehler mit HTTP-Status, damit der Server passend antworten kann. */
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ------------------------- Migration: Mitgliedschaft ---------------------- */

/**
 * Bestehende Gruppen kannten nur owner_id, keine echte Mitgliedschaft.
 * Verknüpft jede Gruppe rückwirkend mit dem Konto ihres Erstellers – als
 * Mitglied, nicht mehr nur als Eigentümer, damit loadData() (die künftig
 * über group_members.user_id statt owner_id filtert) bestehende Gruppen
 * nicht plötzlich verliert. Idempotent: läuft bei jedem Start, ändert aber
 * nur, was noch nicht verknüpft ist.
 */
function migrateOwnersToMembers() {
  db.prepare('SELECT rowid AS rid FROM group_members WHERE id IS NULL').all()
    .forEach((row) => db.prepare('UPDATE group_members SET id = ? WHERE rowid = ?').run(newId('m'), row.rid));

  db.prepare('SELECT id, owner_id FROM groups').all().forEach((group) => {
    const alreadyLinked = db.prepare(
      'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?'
    ).get(group.id, group.owner_id);
    if (alreadyLinked) return;

    const owner = db.prepare('SELECT name FROM users WHERE id = ?').get(group.owner_id);
    if (!owner) return;   // verwaistes owner_id, sollte nicht vorkommen

    const placeholder = db.prepare(
      'SELECT rowid AS rid FROM group_members WHERE group_id = ? AND name = ? AND user_id IS NULL'
    ).get(group.id, owner.name);

    if (placeholder) {
      db.prepare('UPDATE group_members SET user_id = ? WHERE rowid = ?').run(group.owner_id, placeholder.rid);
    } else {
      const nextPosition = db.prepare(
        'SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM group_members WHERE group_id = ?'
      ).get(group.id).pos;
      db.prepare(
        'INSERT INTO group_members (id, group_id, name, position, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(newId('m'), group.id, owner.name, nextPosition, group.owner_id, '1970-01-01T00:00:00.000Z');
    }
  });
}

migrateOwnersToMembers();

/* --------------------------------- Benutzer ------------------------------ */

/**
 * Registrierung ist bewusst geschlossen: Ein Konto entsteht nur über einen
 * gültigen Einladungslink. Ausnahme ist das allererste Konto – sonst käme
 * niemand hinein, der die erste Einladung verschicken könnte. Die Prüfung
 * MUSS hier serverseitig sitzen; ein ausgeblendetes Formular im Browser
 * hält niemanden auf, der die API direkt anspricht.
 */
function register({ name, email, password, inviteToken }) {
  const mail = normalizeEmail(email);
  const clean = String(name || '').trim();

  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount > 0) {
    const invite = inviteToken
      ? db.prepare('SELECT 1 FROM group_invites WHERE token = ?').get(String(inviteToken))
      : null;
    if (!invite) {
      throw new ApiError(403, 'Ein Konto lässt sich nur über einen Einladungslink anlegen.');
    }
  }

  if (!clean) throw new ApiError(400, 'Bitte einen Namen eingeben.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new ApiError(400, 'Bitte eine gültige E-Mail-Adresse eingeben.');
  if (String(password || '').length < 8) throw new ApiError(400, 'Das Passwort braucht mindestens 8 Zeichen.');

  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(mail)) {
    throw new ApiError(409, 'Für diese E-Mail-Adresse gibt es schon ein Konto.');
  }

  const { salt, hash } = hashPassword(password);
  const id = newId('u');

  db.prepare(`
    INSERT INTO users (id, name, email, avatar, created_at, pw_salt, pw_hash)
    VALUES (?, ?, ?, NULL, ?, ?, ?)
  `).run(id, clean, mail, new Date().toISOString(), salt, hash);

  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

const DEMO_EMAIL = 'demo@freundetracker.local';

/**
 * Konto für den Magic-Link "Demo ansehen" auf der Anmeldeseite. Bewusst
 * AUSSERHALB von register(): die Registrierungssperre (nur per Einladung)
 * soll für echte Konten bestehen bleiben, der Demo-Zugang aber ohne Umweg
 * funktionieren. Ein Passwort bekommt das Konto trotzdem (nur nie benutzt,
 * das Login läuft ausschließlich über den Server-Endpunkt) – sonst wäre es
 * über den normalen Login-Weg mit leerem Passwort angreifbar.
 *
 * Idempotent: existiert das Konto schon, wird es unverändert zurückgegeben,
 * nichts wird neu angelegt oder zurückgesetzt.
 */
function ensureDemoUser() {
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(DEMO_EMAIL);
  if (existing) return publicUser(existing);

  const { salt, hash } = hashPassword(crypto.randomBytes(24).toString('hex'));
  const id = newId('u');
  const name = 'Alex';

  db.prepare(`
    INSERT INTO users (id, name, email, avatar, created_at, pw_salt, pw_hash)
    VALUES (?, ?, ?, NULL, ?, ?, ?)
  `).run(id, name, DEMO_EMAIL, new Date().toISOString(), salt, hash);

  // Dieselben Beispieldaten wie bei einer frischen Registrierung (siehe
  // demoData() in public/app.js) – nur serverseitig und mit festen IDs, weil
  // es dieses eingebaute Konto nur EINMAL gibt (kein Aufruf pro Besucher).
  // Läuft nur hier beim allerersten Anlegen, nicht bei jedem Magic-Link-Klick
  // – sonst würden absichtlich gelöschte Demo-Gruppen ständig wiederkehren.
  saveData(id, {
    groups: [
      { id: 'demo-g1', name: 'Reisecrew',      members: [name, 'Anna', 'Ben', 'Clara'] },
      { id: 'demo-g2', name: 'WG Hauptstraße', members: [name, 'Jonas', 'Mira'] },
      { id: 'demo-g3', name: 'Grillabende',    members: [name, 'Ben', 'Mira', 'Tom', 'Lea'] }
    ],
    events: [
      { id: 'demo-ev1', groupId: 'demo-g1', name: 'Urlaub China' },
      { id: 'demo-ev2', groupId: 'demo-g1', name: 'Skiwochenende' },
      { id: 'demo-ev3', groupId: 'demo-g2', name: 'Laufende Kosten' },
      { id: 'demo-ev4', groupId: 'demo-g3', name: 'Sommergrillen' }
    ],
    expenses: [
      { id: 'demo-e1',  eventId: 'demo-ev1', category: 'stay',      title: 'Hotel Shanghai',      amount: 640.00, payer: 'Anna',  date: '2026-07-14' },
      { id: 'demo-e2',  eventId: 'demo-ev1', category: 'food',      title: 'Streetfood Peking',   amount:  78.50, payer: name,    date: '2026-07-16' },
      { id: 'demo-e3',  eventId: 'demo-ev1', category: 'transport', title: 'Bahn nach Xi\'an',    amount: 210.00, payer: 'Ben',   date: '2026-07-17' },
      { id: 'demo-e4',  eventId: 'demo-ev1', category: 'activity',  title: 'Tickets Große Mauer', amount:  96.00, payer: name,    date: '2026-07-19' },
      { id: 'demo-e5',  eventId: 'demo-ev1', category: 'food',      title: 'Abendessen Xi\'an',   amount: 132.40, payer: 'Clara', date: '2026-07-20' },
      { id: 'demo-e6',  eventId: 'demo-ev2', category: 'stay',      title: 'Hütte',               amount: 380.00, payer: name,    date: '2026-07-04' },
      { id: 'demo-e7',  eventId: 'demo-ev2', category: 'activity',  title: 'Skipässe',            amount: 480.00, payer: 'Anna',  date: '2026-07-05' },
      { id: 'demo-e8',  eventId: 'demo-ev3', category: 'other',     title: 'Internet Juli',       amount:  45.00, payer: 'Jonas', date: '2026-07-24' },
      { id: 'demo-e9',  eventId: 'demo-ev3', category: 'shopping',  title: 'Putzmittel',          amount:  23.15, payer: name,    date: '2026-07-18' },
      { id: 'demo-e10', eventId: 'demo-ev4', category: 'food',      title: 'Fleisch & Kohle',     amount:  86.90, payer: name,    date: '2026-07-21' }
    ],
    payments: [
      { id: 'demo-p1', groupId: 'demo-g2', from: 'Mira', to: name, amount: 15.00, date: '2026-07-23' }
    ],
    barcodes: {},
    contacts: {}
  });

  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

function login(email, password) {
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email));

  // Auch ohne Treffer rechnen, damit die Antwortzeit nichts über die
  // Existenz des Kontos verrät.
  const salt = row ? row.pw_salt : 'x'.repeat(32);
  const hash = row ? row.pw_hash : 'y'.repeat(SCRYPT_KEYLEN * 2);
  const ok = checkPassword(String(password || ''), salt, hash);

  if (!row || !ok) throw new ApiError(401, 'E-Mail oder Passwort stimmt nicht.');
  return publicUser(row);
}

function updateUser(userId, patch) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) throw new ApiError(404, 'Konto nicht gefunden.');

  if (patch.email !== undefined) {
    const mail = normalizeEmail(patch.email);
    const taken = db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(mail, userId);
    if (taken) throw new ApiError(409, 'Diese E-Mail-Adresse wird schon von einem anderen Konto genutzt.');
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(mail, userId);
  }

  const columns = { name: 'name', avatar: 'avatar', iban: 'iban', paypal: 'paypal', phone: 'phone' };
  for (const [field, column] of Object.entries(columns)) {
    if (patch[field] === undefined) continue;
    const value = patch[field] === null ? null : String(patch[field]).trim();
    db.prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(value, userId);
  }

  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
}

function changePassword(userId, currentPassword, newPassword) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) throw new ApiError(404, 'Konto nicht gefunden.');

  if (!checkPassword(String(currentPassword || ''), row.pw_salt, row.pw_hash)) {
    throw new ApiError(403, 'Das aktuelle Passwort stimmt nicht.');
  }
  if (String(newPassword || '').length < 8) {
    throw new ApiError(400, 'Das neue Passwort braucht mindestens 8 Zeichen.');
  }

  const { salt, hash } = hashPassword(newPassword);
  db.prepare('UPDATE users SET pw_salt = ?, pw_hash = ? WHERE id = ?').run(salt, hash, userId);

  // Alle anderen Geräte abmelden – bei einem Passwortwechsel erwartet man das.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;   // 1 Stunde

/** Räumt abgelaufene Links weg – bei jedem Zugriff, kein Cronjob nötig. */
function pruneExpiredPasswordResets() {
  db.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(new Date().toISOString());
}

/**
 * Erzeugt einen Passwort-Reset-Link für ein Mitglied MIT eigenem Konto.
 * Nur ein Admin der Gruppe darf das – siehe Kommentar bei der Tabelle oben
 * zur Begründung, warum dieser Weg (statt E-Mail) gewählt wurde.
 */
function createPasswordResetLink(groupId, adminUserId, memberName) {
  assertGroupAdmin(groupId, adminUserId, 'einen Passwort-Link erzeugen');
  pruneExpiredPasswordResets();

  const member = db.prepare('SELECT user_id FROM group_members WHERE group_id = ? AND name = ?')
    .get(groupId, String(memberName));
  if (!member?.user_id) {
    throw new ApiError(400, 'Für dieses Mitglied gibt es kein eigenes Konto.');
  }

  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  db.prepare(`
    INSERT INTO password_resets (token, user_id, created_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      token = excluded.token, created_by = excluded.created_by,
      created_at = excluded.created_at, expires_at = excluded.expires_at
  `).run(token, member.user_id, adminUserId, now.toISOString(),
         new Date(now.getTime() + PASSWORD_RESET_TTL_MS).toISOString());

  return token;
}

/** Öffentliche Vorschau für die Reset-Seite – nur der Name, sonst nichts. */
function getPasswordResetInfo(token) {
  pruneExpiredPasswordResets();
  const row = db.prepare(`
    SELECT users.name FROM password_resets JOIN users ON users.id = password_resets.user_id
    WHERE password_resets.token = ?
  `).get(token);
  if (!row) throw new ApiError(404, 'Dieser Link ist ungültig oder abgelaufen.');
  return { name: row.name };
}

/**
 * Löst den Link ein: neues Passwort setzen, Link verbrauchen, alle
 * bestehenden Sitzungen des Kontos beenden (wie bei changePassword – wer
 * das Passwort vergessen hat, will vermutlich auch ein verlorenes/fremdes
 * Gerät aussperren), und direkt anmelden, damit man nicht extra noch das
 * gerade gesetzte Passwort erneut eintippen muss.
 */
function redeemPasswordReset(token, newPassword) {
  pruneExpiredPasswordResets();
  const row = db.prepare('SELECT user_id FROM password_resets WHERE token = ?').get(token);
  if (!row) throw new ApiError(404, 'Dieser Link ist ungültig oder abgelaufen.');

  if (String(newPassword || '').length < 8) {
    throw new ApiError(400, 'Das neue Passwort braucht mindestens 8 Zeichen.');
  }

  const { salt, hash } = hashPassword(newPassword);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE users SET pw_salt = ?, pw_hash = ? WHERE id = ?').run(salt, hash, row.user_id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
    db.prepare('DELETE FROM password_resets WHERE token = ?').run(token);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const user = publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id));
  const sessionToken = createSession(row.user_id);
  return { user, sessionToken };
}

/**
 * Gibt die Admin-Rolle weiter, falls `userId` der EINZIGE Admin von `groupId`
 * ist – an das dienstälteste andere Mitglied MIT eigenem Konto. Muss vor dem
 * Lösen der Konto-Verknüpfung aufgerufen werden.
 *
 * Gefundener Fehler (2026-08-09): Bisher wurde beim Verlassen/Löschen nur
 * `user_id` genullt, die `is_admin`-Markierung blieb aber an der jetzt
 * kontolosen Zeile hängen. Ergebnis: eine Gruppe mit einem "Admin", den es
 * nicht mehr gibt – niemand konnte mehr einladen oder Mitglieder pflegen,
 * die Gruppe war praktisch eingefroren. Nachgestellt und bestätigt, bevor
 * der Fix geschrieben wurde.
 *
 * @returns {string|null} Name des neuen Admins, falls die Rolle weitergegeben
 *                         wurde – sonst null (war nicht der einzige Admin,
 *                         oder niemand sonst hat ein Konto).
 */
function promoteAdminSuccessor(groupId, userId) {
  const warEinzigerAdmin = db.prepare(
    'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND is_admin = 1'
  ).get(groupId, userId);
  if (!warEinzigerAdmin) return null;

  const andererAdmin = db.prepare(
    'SELECT 1 FROM group_members WHERE group_id = ? AND user_id IS NOT NULL AND user_id != ? AND is_admin = 1'
  ).get(groupId, userId);
  if (andererAdmin) return null;   // nicht der einzige – nichts zu tun

  const naechster = db.prepare(
    'SELECT id, name FROM group_members WHERE group_id = ? AND user_id IS NOT NULL AND user_id != ? ORDER BY created_at ASC, position ASC LIMIT 1'
  ).get(groupId, userId);
  if (!naechster) return null;   // niemand sonst mit Konto da – Gruppe bleibt ohne Admin

  db.prepare('UPDATE group_members SET is_admin = 1 WHERE id = ?').run(naechster.id);
  return naechster.name;
}

/**
 * Löscht das Konto. Gruppen, die ausschließlich diesem Konto gehören, hängen
 * technisch per ON DELETE CASCADE an owner_id – das ist bei geteilten
 * Gruppen nicht mehr richtig, sonst reißt das Löschen eines Kontos eine
 * Gruppe weg, die andere noch nutzen. Deshalb vorher: Besitz an ein anderes
 * verbleibendes Mitglied übergeben, wenn es eins gibt. Gibt es keins mehr,
 * ist ohnehin niemand mehr da, für den die Gruppe erhalten bleiben müsste –
 * sie verschwindet dann wie bisher mit dem Konto.
 */
function deleteUser(userId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('SELECT id FROM groups WHERE owner_id = ?').all(userId).forEach((group) => {
      const successor = db.prepare(
        'SELECT user_id FROM group_members WHERE group_id = ? AND user_id IS NOT NULL AND user_id != ? LIMIT 1'
      ).get(group.id, userId);
      if (successor) {
        db.prepare('UPDATE groups SET owner_id = ? WHERE id = ?').run(successor.user_id, group.id);
      }
    });

    // Admin-Rolle ebenso weitergeben, bevor sie mit dem Konto verschwindet
    // (siehe Kommentar bei promoteAdminSuccessor).
    db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(userId).forEach((row) => {
      promoteAdminSuccessor(row.group_id, userId);
    });

    // Eigene Mitgliedschaft überall lösen, statt die Gruppen anzufassen –
    // der Name bleibt stehen (Historie bleibt lesbar), nur nicht mehr an
    // ein Konto gebunden. is_admin muss mit weg, sonst genau der oben
    // beschriebene Geist-Admin, falls promoteAdminSuccessor niemanden fand.
    db.prepare('UPDATE group_members SET user_id = NULL, is_admin = 0 WHERE user_id = ?').run(userId);

    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/* --------------------------- Mitgliedschaft & Einladungen ----------------- */

/**
 * Serverseitige, gruppenscoped Entsprechung zum Client-renameMember()
 * (public/app.js) – nötig, weil ein neu beitretendes Konto den Gruppenstand
 * noch gar nicht lokal geladen hat, die Umbenennung beim Beitreten (siehe
 * joinViaInvite) also am Server passieren muss. Zieht Ausgaben, Teilnehmer,
 * Geschenke und Zahlungen dieser einen Gruppe mit, damit die Historie
 * konsistent bleibt.
 */
function renameMemberInGroup(groupId, oldName, newName) {
  if (oldName === newName) return;

  db.prepare('UPDATE group_members SET name = ? WHERE group_id = ? AND name = ?').run(newName, groupId, oldName);

  const eventIds = db.prepare('SELECT id FROM events WHERE group_id = ?').all(groupId).map((e) => e.id);
  if (eventIds.length) {
    const inEvents = `(${eventIds.map(() => '?').join(',')})`;
    db.prepare(`UPDATE expenses SET payer = ? WHERE payer = ? AND event_id IN ${inEvents}`).run(newName, oldName, ...eventIds);
    db.prepare(`UPDATE expenses SET gift_for = ? WHERE gift_for = ? AND event_id IN ${inEvents}`).run(newName, oldName, ...eventIds);

    const expenseIds = db.prepare(`SELECT id FROM expenses WHERE event_id IN ${inEvents}`).all(...eventIds).map((e) => e.id);
    if (expenseIds.length) {
      const inExpenses = `(${expenseIds.map(() => '?').join(',')})`;
      db.prepare(`UPDATE expense_participants SET name = ? WHERE name = ? AND expense_id IN ${inExpenses}`)
        .run(newName, oldName, ...expenseIds);
    }
  }

  db.prepare('UPDATE payments SET from_name = ? WHERE from_name = ? AND group_id = ?').run(newName, oldName, groupId);
  db.prepare('UPDATE payments SET to_name = ? WHERE to_name = ? AND group_id = ?').run(newName, oldName, groupId);
}

/** Nur Mitglieder dürfen einen Einladungslink erzeugen. Ein neuer ersetzt den alten. */
/* ---------------------------- Push-Abos ---------------------------------- */

function savePushSubscription(userId, abo) {
  if (!abo?.endpoint || !abo?.keys?.p256dh || !abo?.keys?.auth) {
    throw new ApiError(400, 'Unvollständiges Abo.');
  }
  // Derselbe Endpunkt kann nach einem Kontowechsel auf demselben Gerät einem
  // anderen Konto gehören – deshalb überschreiben statt nur einfügen.
  db.prepare(`
    INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = excluded.user_id, p256dh = excluded.p256dh,
      auth = excluded.auth, created_at = excluded.created_at
  `).run(String(abo.endpoint), userId, String(abo.keys.p256dh), String(abo.keys.auth),
         new Date().toISOString());
  return { ok: true };
}

function deletePushSubscription(userId, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
    .run(String(endpoint || ''), userId);
  return { ok: true };
}

const pushSubscriptionsOf = (userId) =>
  db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId);

const dropPushSubscription = (endpoint) =>
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);

const hasPushSubscription = (userId) =>
  Boolean(db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ? LIMIT 1').get(userId));

/** Konto-ID hinter einem Mitgliedsnamen – nur verknüpfte Mitglieder haben eine. */
const userIdOfMember = (groupId, name) =>
  db.prepare('SELECT user_id FROM group_members WHERE group_id = ? AND name = ?')
    .get(groupId, String(name))?.user_id || null;

/** Ist dieses Konto Admin der Gruppe? Einzige Wahrheit für alle Rechteprüfungen. */
function isGroupAdmin(groupId, userId) {
  if (!userId) return false;
  const row = db.prepare(
    'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND is_admin = 1'
  ).get(groupId, userId);
  return Boolean(row);
}

function assertGroupAdmin(groupId, userId, was) {
  const exists = db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupId);
  if (!exists) throw new ApiError(404, 'Diese Gruppe gibt es nicht mehr.');
  if (!isGroupAdmin(groupId, userId)) {
    throw new ApiError(403, `Nur ein Admin dieser Gruppe kann ${was}.`);
  }
}

const AUDIT_LIMIT_JE_GRUPPE = 200;   // reicht für Wochen bei einer Freundesgruppe, waechst nicht unbegrenzt

/**
 * Trägt einen Eintrag in den Änderungsverlauf ein. Bewusst FEHLERTOLERANT
 * (kein throw): Das Protokollieren darf niemals den eigentlichen
 * Speichervorgang zu Fall bringen – eine fehlende Zeile im Verlauf ist
 * ärgerlich, ein deswegen verlorener Speichervorgang wäre schlimmer.
 */
function logAudit(groupId, actorName, action) {
  try {
    db.prepare('INSERT INTO audit_log (id, group_id, actor_name, action, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(newId('al'), groupId, actorName, action, new Date().toISOString());

    // Nur gelegentlich aufräumen (nicht bei jedem Eintrag), spart Abfragen
    // im Normalfall: 200 Einträge sind schnell erreicht, aber nicht bei
    // jedem einzelnen davon lohnt sich schon eine Aufräum-Abfrage.
    if (Math.random() < 0.1) pruneAudit(groupId);
  } catch { /* siehe Kommentar oben: nie werfen */ }
}

/** Kappt den Verlauf EINER Gruppe auf AUDIT_LIMIT_JE_GRUPPE Einträge. */
function pruneAudit(groupId) {
  const ueberzaehlige = db.prepare(`
    SELECT id FROM audit_log WHERE group_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?
  `).all(groupId, AUDIT_LIMIT_JE_GRUPPE);
  if (ueberzaehlige.length) {
    const platzhalter = ueberzaehlige.map(() => '?').join(',');
    db.prepare(`DELETE FROM audit_log WHERE id IN (${platzhalter})`).run(...ueberzaehlige.map((r) => r.id));
  }
}

/**
 * Räumt Verläufe wirklich gelöschter Gruppen weg – das erledigte früher die
 * Fremdschlüssel-Kaskade, die weg musste (siehe Tabellendefinition).
 *
 * Läuft NUR beim Start und beim ausdrücklichen Löschen einer Gruppe, bewusst
 * NICHT in `logAudit()`: Innerhalb der Transaktion von `saveData()` sind
 * zeitweise mehrere eigene Gruppen gelöscht und noch nicht wieder
 * eingefügt – eine Waisen-Bereinigung in diesem Moment würde deren Verlauf
 * mitlöschen. Genau diese Sorte Wechselwirkung war der ursprüngliche Fehler.
 */
function pruneVerwaisteAudits() {
  try {
    db.prepare('DELETE FROM audit_log WHERE group_id NOT IN (SELECT id FROM groups)').run();
  } catch { /* Aufräumen darf nie den Start verhindern */ }
}

/** Änderungsverlauf einer Gruppe – nur für Admins, jüngste zuerst. */
function getAuditLog(groupId, userId) {
  assertGroupAdmin(groupId, userId, 'den Änderungsverlauf einsehen');
  return db.prepare(
    'SELECT actor_name AS actorName, action, created_at AS createdAt FROM audit_log WHERE group_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(groupId, AUDIT_LIMIT_JE_GRUPPE);
}

/**
 * Admin-Rechte geben oder entziehen. Nur Admins dürfen das, und der letzte
 * Admin kann sich die Rechte nicht selbst nehmen – sonst bliebe die Gruppe
 * führungslos zurück und niemand könnte mehr einladen oder Mitglieder pflegen.
 */
function setGroupAdmin(groupId, userId, memberName, sollAdmin) {
  assertGroupAdmin(groupId, userId, 'Admin-Rechte vergeben');

  const member = db.prepare('SELECT id, user_id, is_admin FROM group_members WHERE group_id = ? AND name = ?')
    .get(groupId, String(memberName));
  if (!member) throw new ApiError(404, 'Dieses Mitglied gibt es nicht.');
  if (!member.user_id) {
    throw new ApiError(400, 'Nur Mitglieder mit eigenem Konto können Admin werden.');
  }

  if (!sollAdmin) {
    const andere = db.prepare(
      'SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND is_admin = 1 AND id != ?'
    ).get(groupId, member.id).n;
    if (andere === 0) {
      throw new ApiError(409, 'Das ist der letzte Admin – bestimme zuerst jemand anderen.');
    }
  }

  db.prepare('UPDATE group_members SET is_admin = ? WHERE id = ?').run(sollAdmin ? 1 : 0, member.id);

  const actorName = db.prepare('SELECT name FROM users WHERE id = ?').get(userId)?.name || '?';
  logAudit(groupId, actorName, sollAdmin
    ? `Admin-Rechte vergeben an: ${memberName}`
    : `Admin-Rechte entzogen: ${memberName}`);

  return { ok: true };
}

function createInvite(groupId, userId) {
  // Die Prüfung gehört hierher und nicht ins Frontend: einen ausgeblendeten
  // Knopf umgeht man mit einem einzigen API-Aufruf.
  assertGroupAdmin(groupId, userId, 'einen Einladungslink erzeugen');

  const token = crypto.randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO group_invites (group_id, token, created_at) VALUES (?, ?, ?)
    ON CONFLICT(group_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at
  `).run(groupId, token, new Date().toISOString());

  return token;
}

/** Öffentliche Vorschau für die Beitritts-Seite – keine Beträge, nur Namen. */
function getInviteInfo(token) {
  const invite = db.prepare('SELECT group_id FROM group_invites WHERE token = ?').get(token);
  if (!invite) throw new ApiError(404, 'Dieser Einladungslink ist ungültig oder wurde erneuert.');

  const group = db.prepare('SELECT id, name, avatar FROM groups WHERE id = ?').get(invite.group_id);
  if (!group) throw new ApiError(404, 'Diese Gruppe gibt es nicht mehr.');

  const openMembers = db.prepare(
    'SELECT name FROM group_members WHERE group_id = ? AND user_id IS NULL ORDER BY position'
  ).all(group.id).map((m) => m.name);

  return { groupId: group.id, groupName: group.name, groupAvatar: group.avatar || null, openMembers };
}

/**
 * Tritt einer Gruppe über einen Einladungslink bei. Mit claimName wird ein
 * bestehendes Platzhalter-Mitglied übernommen (und auf den eigenen
 * Kontonamen umbenannt); ohne claimName entsteht ein neuer Mitgliedseintrag.
 * Die Namens-Identität-Regel (Mitgliedsname == Kontoname) gilt auch hier,
 * deshalb die Kollisionsprüfung gegen bereits vorhandene Namen.
 */
function joinViaInvite(token, userId, claimName) {
  const invite = db.prepare('SELECT group_id FROM group_invites WHERE token = ?').get(token);
  if (!invite) throw new ApiError(404, 'Dieser Einladungslink ist ungültig oder wurde erneuert.');
  const groupId = invite.group_id;

  const already = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
  if (already) return { groupId };   // schon Mitglied – nichts zu tun

  const me = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
  if (!me) throw new ApiError(404, 'Konto nicht gefunden.');
  const myName = me.name;

  if (claimName) {
    const placeholder = db.prepare(
      'SELECT 1 FROM group_members WHERE group_id = ? AND name = ? AND user_id IS NULL'
    ).get(groupId, claimName);
    if (!placeholder) throw new ApiError(400, 'Dieses Mitglied wurde inzwischen schon von jemand anderem übernommen.');
  }

  // Kollision: Ein anderer Name in der Gruppe darf nicht schon so heißen wie
  // man selbst – außer es ist genau der Platzhalter, den man gerade
  // übernimmt (dann verschwindet die "Kollision" ja durchs Umbenennen).
  const conflict = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND name = ?').get(groupId, myName);
  const claimingSelf = claimName && claimName === myName;
  if (conflict && !claimingSelf) {
    throw new ApiError(409, `In dieser Gruppe gibt es bereits ein Mitglied namens "${myName}". Bitte ändere zuerst deinen Namen im Profil.`);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const now = new Date().toISOString();
    if (claimName) {
      if (claimName !== myName) renameMemberInGroup(groupId, claimName, myName);
      // claimed_from/linked_at: siehe Kommentar bei ensureColumn oben. Ohne
      // sie verliert der Beigetretene die Gruppe, sobald der Einladende mit
      // seinem noch alten Stand speichert.
      db.prepare(
        'UPDATE group_members SET user_id = ?, claimed_from = ?, linked_at = ? WHERE group_id = ? AND name = ?'
      ).run(userId, claimName !== myName ? claimName : null, now, groupId, myName);
    } else {
      const nextPosition = db.prepare(
        'SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM group_members WHERE group_id = ?'
      ).get(groupId).pos;
      db.prepare(
        // is_admin = 0: wer über einen Einladungslink dazukommt, ist normales
        // Mitglied. Rechte vergibt ausschließlich ein bestehender Admin.
        'INSERT INTO group_members (id, group_id, name, position, user_id, created_at, linked_at, is_admin) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
      ).run(newId('m'), groupId, myName, nextPosition, userId, now, now);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  // 4. Push-Anlass: Gruppenbeitritt. An alle bestehenden Mitglieder MIT
  // Konto außer den Beitretenden selbst – das ist der einzige der vier
  // Anlässe, der nicht in saveData() passiert (dort speichert ja der
  // Beitretende selbst noch gar nichts).
  const groupName = db.prepare('SELECT name FROM groups WHERE id = ?').get(groupId)?.name || '';
  logAudit(groupId, myName, claimName && claimName !== myName
    ? `${myName} ist der Gruppe beigetreten (übernahm den Platz von „${claimName}")`
    : `${myName} ist der Gruppe beigetreten`);
  const benachrichtigungen = db.prepare(
    'SELECT user_id AS empfaengerId FROM group_members WHERE group_id = ? AND user_id IS NOT NULL AND user_id != ?'
  ).all(groupId, userId).map((row) => ({
    empfaengerId: row.empfaengerId, titel: 'Neues Mitglied',
    text: `${myName} ist „${groupName}" beigetreten.`, ziel: '/'
  }));

  return { groupId, benachrichtigungen };
}

/**
 * Verlässt eine Gruppe freiwillig. Der Name bleibt in der Historie stehen,
 * nur die Konto-Verknüpfung verschwindet. War man Ersteller, geht der
 * "Besitz" an ein anderes verbleibendes Mitglied über – bleibt niemand
 * übrig, verschwindet die Gruppe (analog zu deleteUser). War man der
 * einzige Admin, geht auch diese Rolle weiter (siehe promoteAdminSuccessor).
 *
 * @returns {{ neuerAdmin: string|null }} Für eine Ansage im Frontend
 *          ("Du warst der letzte Admin – die Rechte gehen an …").
 */
function leaveGroup(groupId, userId) {
  const membership = db.prepare('SELECT name FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
  if (!membership) throw new ApiError(404, 'Du bist kein Mitglied dieser Gruppe.');

  db.exec('BEGIN IMMEDIATE');
  try {
    const group = db.prepare('SELECT owner_id FROM groups WHERE id = ?').get(groupId);
    if (group && group.owner_id === userId) {
      const successor = db.prepare(
        'SELECT user_id FROM group_members WHERE group_id = ? AND user_id IS NOT NULL AND user_id != ? LIMIT 1'
      ).get(groupId, userId);
      if (successor) {
        db.prepare('UPDATE groups SET owner_id = ? WHERE id = ?').run(successor.user_id, groupId);
      } else {
        db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);   // Rest folgt per CASCADE
        db.exec('COMMIT');
        return { neuerAdmin: null };
      }
    }

    const neuerAdmin = promoteAdminSuccessor(groupId, userId);

    // is_admin muss mit auf 0, sonst bleibt bei "niemand sonst mit Konto da"
    // (promoteAdminSuccessor findet dann niemanden) die Markierung an der
    // jetzt kontolosen Zeile hängen – exakt der Fehler, der hier behoben wird.
    db.prepare('UPDATE group_members SET user_id = NULL, is_admin = 0 WHERE group_id = ? AND user_id = ?').run(groupId, userId);
    db.exec('COMMIT');
    logAudit(groupId, membership.name, `${membership.name} hat die Gruppe verlassen`);
    return { neuerAdmin };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Löscht eine Gruppe vollständig – der einzige Weg, eine Gruppe mit mehr als
 * einem verlinkten Konto zu löschen (saveData lässt das bei "echt geteilten"
 * Gruppen bewusst nicht mehr über bloßes Weglassen zu, siehe dort). Nur der
 * Ersteller darf das, und zwar ausdrücklich – kein Speichervorgang kann das
 * versehentlich auslösen.
 */
function deleteGroupExplicit(groupId, userId) {
  const group = db.prepare('SELECT owner_id FROM groups WHERE id = ?').get(groupId);
  if (!group) throw new ApiError(404, 'Diese Gruppe gibt es nicht mehr.');
  if (group.owner_id !== userId) throw new ApiError(403, 'Nur der Ersteller kann diese Gruppe löschen.');

  db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);   // Rest folgt per CASCADE
  // audit_log hängt bewusst nicht an der Kaskade (siehe Tabellendefinition),
  // deshalb hier ausdrücklich mit weg.
  db.prepare('DELETE FROM audit_log WHERE group_id = ?').run(groupId);
}

/* -------------------------------- Sitzungen ------------------------------ */

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
    .run(token, userId, new Date().toISOString());
  return token;
}

function userByToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT users.* FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ?
  `).get(token);
  return publicUser(row) || null;
}

function deleteSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/* ---------------------------------- Daten -------------------------------- */

/** Baut den Datenstand des Nutzers in genau der Form, die das Frontend nutzt. */
function loadData(userId) {
  // Zeitpunkt dieser Momentaufnahme – der Client schickt ihn beim nächsten
  // Speichern als "asOf" mit zurück (siehe saveData). Damit lässt sich
  // erkennen, ob eine Zeile entstanden ist, NACHDEM dieser Stand geladen
  // wurde – so eine Zeile darf ein veralteter Speichervorgang nie löschen.
  const asOf = new Date().toISOString();

  const myName = db.prepare('SELECT name FROM users WHERE id = ?').get(userId)?.name;

  // Sichtbar sind Gruppen, in denen der Nutzer laut group_members Mitglied
  // ist – nicht mehr nur die eigenen (owner_id). Damit sieht man auch
  // Gruppen, denen man per Einladung beigetreten ist.
  const groups = db.prepare(`
    SELECT groups.*, users.name AS created_by_name
    FROM groups
    JOIN users ON users.id = groups.owner_id
    WHERE groups.id IN (SELECT group_id FROM group_members WHERE user_id = ?)
    ORDER BY groups.position
  `).all(userId);
  const groupIds = groups.map((g) => g.id);

  const inGroups = groupIds.length
    ? `(${groupIds.map(() => '?').join(',')})`
    : '(NULL)';

  const members = db.prepare(`SELECT * FROM group_members WHERE group_id IN ${inGroups} ORDER BY position`).all(...groupIds);
  const events = db.prepare(`SELECT * FROM events WHERE group_id IN ${inGroups} ORDER BY position`).all(...groupIds);
  const payments = db.prepare(`SELECT * FROM payments WHERE group_id IN ${inGroups} ORDER BY position`).all(...groupIds);

  const eventIds = events.map((e) => e.id);
  const inEvents = eventIds.length ? `(${eventIds.map(() => '?').join(',')})` : '(NULL)';

  const expenses = db.prepare(`SELECT * FROM expenses WHERE event_id IN ${inEvents} ORDER BY position`).all(...eventIds);

  const expenseIds = expenses.map((e) => e.id);
  const inExpenses = expenseIds.length ? `(${expenseIds.map(() => '?').join(',')})` : '(NULL)';
  const participants = db.prepare(`SELECT * FROM expense_participants WHERE expense_id IN ${inExpenses} ORDER BY position`).all(...expenseIds);

  const membersByGroup = {};
  const adminsByGroup = {};
  // Wer hat ein eigenes Konto? Wichtig als eigenes Feld: `linkedContacts`
  // (weiter unten) listet nur Mitglieder, die ZUSÄTZLICH eine IBAN/PayPal
  // hinterlegt haben – für "kann Admin werden" oder "kann einen Passwort-
  // Link bekommen" ist das der falsche Filter, das hätte den Knopf bei fast
  // jedem echten Mitglied verschwinden lassen (gefunden beim Testen von
  // Nr. 2 – betraf rückwirkend auch den Admin-Umschalter von Nr. 35).
  const linkedByGroup = {};
  members.forEach((m) => {
    (membersByGroup[m.group_id] ||= []).push(m.name);
    if (m.is_admin) (adminsByGroup[m.group_id] ||= []).push(m.name);
    if (m.user_id) (linkedByGroup[m.group_id] ||= []).push(m.name);
  });

  const partsByExpense = {};
  const weightsByExpense = {};
  participants.forEach((p) => {
    (partsByExpense[p.expense_id] ||= []).push(p.name);
    if (p.weight !== null && p.weight !== undefined) {
      (weightsByExpense[p.expense_id] ||= {})[p.name] = p.weight;
    }
  });

  const contacts = {};
  db.prepare('SELECT * FROM contacts WHERE owner_id = ?').all(userId).forEach((c) => {
    contacts[c.name] = { iban: c.iban, paypal: c.paypal };
  });

  // Echte Bankverbindung verlinkter Mitkonten – im Unterschied zu "contacts"
  // (manuell eingetragen, pro eigenem Konto) kommt das direkt aus dem Profil
  // des anderen Kontos, muss also nicht mehr abgetippt werden. Nur Konten,
  // die selbst eine IBAN/PayPal hinterlegt haben, tauchen hier auf.
  const linkedUserIds = [...new Set(
    members.filter((m) => m.user_id && m.user_id !== userId).map((m) => m.user_id)
  )];
  const linkedUsersById = {};
  if (linkedUserIds.length) {
    const placeholders = linkedUserIds.map(() => '?').join(',');
    db.prepare(`SELECT id, iban, paypal, avatar FROM users WHERE id IN (${placeholders})`)
      .all(...linkedUserIds).forEach((u) => { linkedUsersById[u.id] = u; });
  }
  const linkedContacts = {};

  // Profilbilder der Mitglieder, damit in den Ausgleichszeilen ein Gesicht
  // statt nur Initialen steht. Bewusst PRO GRUPPE statt als eine globale
  // Namensliste: derselbe Anzeigename kann in zwei Gruppen zu zwei
  // verschiedenen Konten gehören – eine globale Zuordnung würde dann das
  // falsche Bild zeigen.
  //
  // Das eigene Bild fehlt hier absichtlich (der Client hat es in
  // state.user.avatar). Sonst läge dasselbe Bild in jeder einzelnen Gruppe
  // noch einmal im Datenstand – bei 14 Gruppen das Vierzehnfache umsonst.
  const memberAvatarsByGroup = {};
  members.forEach((m) => {
    if (!m.user_id || m.user_id === userId) return;
    const u = linkedUsersById[m.user_id];
    if (!u) return;
    if (u.iban || u.paypal) linkedContacts[m.name] = { iban: u.iban || '', paypal: u.paypal || '' };
    if (u.avatar) (memberAvatarsByGroup[m.group_id] ||= {})[m.name] = u.avatar;
  });

  const barcodes = {};
  db.prepare('SELECT * FROM barcodes WHERE owner_id = ?').all(userId).forEach((b) => {
    barcodes[b.code] = { title: b.title, category: b.category, amount: b.amount };
  });

  return {
    groups: groups.map((g) => ({
      id: g.id, name: g.name, avatar: g.avatar || null,
      members: membersByGroup[g.id] || [], createdBy: g.created_by_name,
      // Namen statt IDs, passend zur Namens-Identität-Regel im Frontend.
      admins: adminsByGroup[g.id] || [],
      linked: linkedByGroup[g.id] || [],
      memberAvatars: memberAvatarsByGroup[g.id] || {},
      archived: Boolean(g.archived)
    })),
    events: events.map((e) => ({
      id: e.id, groupId: e.group_id, name: e.name,
      startDate: e.start_date || null, endDate: e.end_date || null,
      archived: Boolean(e.archived)
    })),
    // Geschenke für einen selbst nie ausliefern – bisher wurde das nur im
    // Browser ausgeblendet (visibleExpenses()), war im Netzwerkverkehr aber
    // einsehbar. Andere Mitglieder (Geber, unbeteiligte Dritte) sehen den
    // Eintrag weiterhin ganz normal.
    expenses: expenses.filter((e) => e.gift_for !== myName).map((e) => ({
      id: e.id,
      eventId: e.event_id,
      category: e.category,
      title: e.title,
      amount: e.amount,
      payer: e.payer,
      giftFor: e.gift_for || null,
      participants: partsByExpense[e.id] || [],
      split: { mode: e.split_mode || 'equal', values: weightsByExpense[e.id] || {} },
      date: e.date,
      receiptId: e.receipt_id || null
    })),
    payments: payments.map((p) => ({
      id: p.id, groupId: p.group_id, from: p.from_name, to: p.to_name, amount: p.amount, date: p.date,
      // Fehlt der Wert (Bestandsdaten), gilt die Zahlung als bestätigt.
      status: p.status === 'pending' ? 'pending' : 'confirmed'
    })),
    contacts,
    linkedContacts,
    barcodes,
    asOf
  };
}

/**
 * Schreibt den Datenstand des Nutzers neu.
 * Bewusst „alles ersetzen" statt einzelner Änderungsbefehle: Das Frontend
 * schickt ohnehin seinen vollständigen lokalen Stand, und eine Transaktion
 * sorgt dafür, dass niemals ein halber Stand in der Datenbank landet.
 *
 * WICHTIG (Mehrbenutzer-Fix): Früher wurden ALLE Gruppen von owner_id
 * gelöscht und aus dem Payload neu geschrieben. Sobald eine Gruppe mehrere
 * Konten hat, darf ein Speichervorgang aber niemals Gruppen anfassen, in
 * denen der Speichernde kein Mitglied ist – sonst würde ein Konto beim
 * Speichern versehentlich fremde, nicht geteilte Gruppen löschen. Angefasst
 * werden deshalb nur: Gruppen, in denen der Nutzer laut group_members
 * Mitglied ist (fehlen sie im Payload, gilt das weiterhin als "löschen" –
 * das ist der bestehende Lösch-Mechanismus), plus brandneue Gruppen, die es
 * in der Datenbank noch gar nicht gibt (das ist "anlegen").
 *
 * WICHTIG (Konsistenz-Fix): Selbst innerhalb einer Gruppe, die man anfassen
 * darf, ist "im Payload fehlt = löschen" gefährlich, sobald mehrere Konten
 * an derselben Gruppe arbeiten. Lädt Person B die Daten, trägt Person A
 * danach eine neue Ausgabe ein, und speichert B dann (mit seinem jetzt
 * veralteten Stand) irgendetwas anderes, würde A's Ausgabe stillschweigend
 * gelöscht – nachgewiesen im Gesamttest vom 2026-08-04. Deshalb bekommt
 * jede Zeile einen server-eigenen `created_at`, und der Client schickt beim
 * Speichern zurück, von wann sein Stand ist (`asOf`, kommt ursprünglich aus
 * loadData). Fehlt eine Zeile im Payload, aber ist sie NEUER als `asOf`,
 * kann der Client sie unmöglich gekannt haben – sie wird nicht gelöscht,
 * sondern nach dem Neuschreiben unverändert wiederhergestellt ("survivor").
 * Zusätzlich: Geschenke an den Speichernden selbst sind IMMER geschützt,
 * unabhängig vom Zeitstempel – der Beschenkte bekommt sie ja nie zu Gesicht
 * (siehe loadData), sein Payload kann sie also strukturell nie enthalten.
 */
function saveData(userId, data) {
  const groups = Array.isArray(data?.groups) ? data.groups : [];
  const events = Array.isArray(data?.events) ? data.events : [];
  const expenses = Array.isArray(data?.expenses) ? data.expenses : [];
  const payments = Array.isArray(data?.payments) ? data.payments : [];
  const contacts = data?.contacts && typeof data.contacts === 'object' ? data.contacts : {};
  const barcodes = data?.barcodes && typeof data.barcodes === 'object' ? data.barcodes : {};

  const EPOCH = '1970-01-01T00:00:00.000Z';
  // Fehlt "asOf" oder ist er kein String: auf das älteste Datum zurückfallen.
  // Das schützt dann ausnahmslos jede vorhandene Zeile vor dem Löschen durch
  // Weglassen – im Zweifel lieber nichts löschen als fremde Daten verlieren.
  const asOf = typeof data?.asOf === 'string' && data.asOf ? data.asOf : EPOCH;
  const now = new Date().toISOString();

  const payloadGroupIds = groups.map((g) => String(g.id));
  const existingGroupIds = new Set(db.prepare('SELECT id FROM groups').all().map((r) => r.id));
  const myGroupIds = new Set(
    db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(userId).map((r) => r.group_id)
  );

  // Bestehende Gruppen, die dieser Speichervorgang löschen/neuschreiben darf.
  const touchable = new Set([...myGroupIds].filter((id) => existingGroupIds.has(id)));
  // Gruppen, die es noch gar nicht gibt, dürfen immer angelegt werden.
  const newGroupIds = new Set(payloadGroupIds.filter((id) => !existingGroupIds.has(id)));

  // Fehlt eine Gruppe im Payload, galt das schon immer als "löschen" (so
  // funktioniert das Löschen von Gruppen/Anlässen/Ausgaben im Frontend
  // grundsätzlich – weglassen statt eines eigenen Lösch-Aufrufs). Bei einer
  // Gruppe mit nur einem Konto ist das unbedenklich: Nur der Speichernde
  // selbst kann sich damit etwas kaputt machen. Sobald ein zweites echtes
  // Konto verlinkt ist, wäre das gefährlich – ein veralteter lokaler Stand
  // (z. B. direkt nach dem Beitreten, bevor neu geladen wurde) würde sonst
  // die Gruppe für alle anderen mitlöschen. Für "echt geteilte" Gruppen ist
  // Löschen deshalb nur noch über den eigenen, expliziten Endpunkt möglich
  // (deleteGroupExplicit / DELETE /api/groups/:id), nicht mehr durchs bloße
  // Weglassen aus einem Speichervorgang.
  const deletableByOmission = new Set(
    [...touchable].filter((id) => {
      const linked = db.prepare(
        'SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND user_id IS NOT NULL'
      ).get(id).n;
      return linked <= 1;
    })
  );

  const myName = db.prepare('SELECT name FROM users WHERE id = ?').get(userId)?.name;

  // Nur Gruppen aus dem Payload übernehmen, die auch erlaubt sind – schützt
  // zusätzlich davor, dass ein manipulierter Payload fremde group_ids enthält.
  const ownGroups = new Set(
    groups.filter((g) => touchable.has(String(g.id)) || newGroupIds.has(String(g.id))).map((g) => String(g.id))
  );
  const ownEvents = new Set(events.filter((e) => ownGroups.has(String(e.groupId))).map((e) => e.id));

  // Verknüpfungen (welcher Name gehört zu welchem Konto, wer hat die Gruppe
  // ursprünglich erstellt) VOR dem Löschen sichern – der Client kennt nur
  // Namen, keine Konten, würde beides beim Neuschreiben sonst verlieren.
  const previousMembersByGroup = {};
  const previousOwnerByGroup = {};
  // Einladungslinks hängen per ON DELETE CASCADE an der Gruppe – wird die
  // Gruppe beim normalen Speichern gelöscht und neu angelegt (Standardmuster
  // hier), reißt das den Link mit, ohne dass ihn je jemand neu erzeugt. Der
  // Client weiß nichts von group_invites (das ist reine Server-Verwaltung),
  // kann so einen Link also auch nicht zurückschicken – deshalb hier sichern
  // und nach dem Neuschreiben unverändert wiederherstellen.
  /* Wer soll hinterher benachrichtigt werden?
     Drei Anlässe (ein vierter, Gruppenbeitritt, sitzt in joinViaInvite –
     dort passiert das, nicht hier). Verschickt wird in JEDEM Fall erst nach
     dem Commit unten, nie hier: eine Benachrichtigung darf das Speichern
     nie gefährden. Jede Benachrichtigung bekommt Titel/Text schon hier
     fertig mit – api.js muss die fachliche Formulierung nicht kennen. */
  const benachrichtigungen = [];
  const formatEuro = (n) => Number(n).toFixed(2).replace('.', ',') + ' €';

  // 1) Zahlung gemeldet – der Zahler wartet auf Bestätigung durch den
  //    Empfänger, der das sonst nur beim zufälligen Öffnen der App merkt.
  // 2) Zahlung bestätigt – der ZAHLER erfährt, dass sein Geld angekommen ist.
  // Beides an derselben Stelle erkannt: der VORHERIGE Stand jeder Zahlung
  // (vor dem Löschen+Neuschreiben unten) verrät, ob eine Zeile neu ist oder
  // gerade den Zustand gewechselt hat.
  const vorherigeZahlungen = new Map(
    db.prepare('SELECT id, status FROM payments').all().map((z) => [String(z.id), z.status])
  );
  payments.filter((z) => ownGroups.has(String(z.groupId))).forEach((z) => {
    const vorher = vorherigeZahlungen.get(String(z.id));
    const gruppe = groups.find((g) => String(g.id) === String(z.groupId))?.name || '';

    if (vorher === undefined && z.status === 'pending') {
      logAudit(String(z.groupId), myName, `Zahlung gemeldet: ${z.from} → ${z.to} (${formatEuro(z.amount)})`);
      const empfaengerId = userIdOfMember(String(z.groupId), z.to);
      if (empfaengerId && empfaengerId !== userId) {
        benachrichtigungen.push({
          empfaengerId, titel: 'Zahlung bestätigen',
          text: `${z.from} hat dir ${formatEuro(z.amount)} überwiesen${gruppe ? ` (${gruppe})` : ''}.`,
          ziel: '/'
        });
      }
    } else if (vorher === undefined && z.status === 'confirmed') {
      // Direkt vom Empfänger verbucht ("Zahlung erhalten"), ohne den
      // Umweg über eine Meldung – anderer Text als beim Bestätigen einer
      // fremden Meldung weiter unten.
      logAudit(String(z.groupId), myName, `Zahlung erhalten: ${z.from} → ${z.to} (${formatEuro(z.amount)})`);
    } else if (vorher === 'pending' && z.status === 'confirmed') {
      logAudit(String(z.groupId), myName, `Zahlung bestätigt: ${z.from} → ${z.to} (${formatEuro(z.amount)})`);
      const zahlerId = userIdOfMember(String(z.groupId), z.from);
      if (zahlerId && zahlerId !== userId) {
        benachrichtigungen.push({
          empfaengerId: zahlerId, titel: 'Zahlung bestätigt',
          text: `${z.to} hat deine Überweisung von ${formatEuro(z.amount)} bestätigt${gruppe ? ` (${gruppe})` : ''}.`,
          ziel: '/'
        });
      }
    }
  });

  // 3) Neue Ausgabe, an der man beteiligt ist – nicht bei bloßem Bearbeiten
  //    einer bestehenden, nur beim erstmaligen Anlegen (ID noch unbekannt).
  //    Teilnehmer-Auflösung spiegelt bewusst participantsOf() im Frontend:
  //    leere/fehlende Liste heißt "alle Mitglieder" (abzüglich Beschenktem).
  // Map statt Set: für den Änderungsverlauf unten wird auch der ALTE Stand
  // gebraucht (Titel/Betrag), um "angelegt" von "geändert" zu unterscheiden.
  const alteAusgabenById = new Map(
    db.prepare('SELECT id, title, amount FROM expenses').all().map((e) => [String(e.id), e])
  );
  expenses.forEach((e) => {
    if (alteAusgabenById.has(String(e.id))) return;
    if (!ownEvents.has(String(e.eventId))) return;

    const event = events.find((ev) => String(ev.id) === String(e.eventId));
    const group = event && groups.find((g) => String(g.id) === String(event.groupId));
    if (!group) return;

    const members = Array.isArray(group.members) ? group.members : [];
    const eligible = e.giftFor ? members.filter((m) => m !== e.giftFor) : members;
    const listed = Array.isArray(e.participants) ? e.participants.filter((p) => eligible.includes(p)) : [];
    const teilnehmer = listed.length ? listed : eligible;

    teilnehmer.filter((name) => name !== myName).forEach((name) => {
      const empfaengerId = userIdOfMember(String(group.id), name);
      if (!empfaengerId || empfaengerId === userId) return;
      benachrichtigungen.push({
        empfaengerId, titel: 'Neue Ausgabe',
        text: `${myName} hat „${e.title}" eingetragen (${formatEuro(e.amount)}, ${group.name}).`,
        ziel: '/'
      });
    });
  });

  const previousInviteByGroup = {};
  // Für den Änderungsverlauf: Name/Bild/Archiviert-Zustand VOR dem
  // Neuschreiben, um zu erkennen, was sich durch dieses Speichern
  // tatsächlich geändert hat.
  const previousGroupInfoByGroup = {};
  // Alter Anlass-Stand je Gruppe (für den Änderungsverlauf weiter unten in
  // events.forEach) – hier statt dort befüllt, weil hier ohnehin schon
  // "SELECT * FROM events WHERE group_id = ?" für die Survivor-Erkennung läuft.
  const alteEventsByGroup = {};
  touchable.forEach((groupId) => {
    previousMembersByGroup[groupId] = new Map(
      db.prepare('SELECT name, id, user_id, created_at, claimed_from, linked_at, position, is_admin FROM group_members WHERE group_id = ?')
        .all(groupId).map((m) => [m.name, m])
    );
    previousOwnerByGroup[groupId] = db.prepare('SELECT owner_id FROM groups WHERE id = ?').get(groupId)?.owner_id;
    previousInviteByGroup[groupId] = db.prepare('SELECT token, created_at FROM group_invites WHERE group_id = ?').get(groupId);
    previousGroupInfoByGroup[groupId] = db.prepare('SELECT name, avatar, archived FROM groups WHERE id = ?').get(groupId);
  });

  // ---- Überlebende Zeilen VOR dem Löschen sichern -------------------------
  // Nur für Gruppen, die neu geschrieben werden (nicht komplett gelöscht) –
  // bei einer echten Löschung gibt es nichts zu bewahren.
  const survivorMembers = [];
  const survivorEvents = [];
  const survivorExpenses = [];
  const survivorParticipants = [];
  const survivorPayments = [];

  [...ownGroups].filter((id) => touchable.has(id)).forEach((groupId) => {
    const payloadMemberNames = new Set(
      (groups.find((g) => String(g.id) === groupId)?.members || []).map(String)
    );
    db.prepare('SELECT * FROM group_members WHERE group_id = ?').all(groupId).forEach((row) => {
      if (!payloadMemberNames.has(row.name) && row.created_at > asOf) survivorMembers.push(row);
    });

    const payloadEventIds = new Set(
      events.filter((e) => String(e.groupId) === groupId).map((e) => String(e.id))
    );
    const groupEvents = db.prepare('SELECT * FROM events WHERE group_id = ?').all(groupId);
    groupEvents.forEach((row) => {
      if (!payloadEventIds.has(row.id) && row.created_at > asOf) survivorEvents.push(row);
    });
    // Für den Änderungsverlauf im events.forEach unten: alter Stand je ID,
    // um angelegt/gelöscht/umbenannt/archiviert zu unterscheiden.
    alteEventsByGroup[groupId] = new Map(groupEvents.map((row) => [String(row.id), row]));
    groupEvents.forEach((row) => {
      // Wirklich gelöscht (nicht nur ein Survivor, der gleich zurückkommt).
      if (!payloadEventIds.has(row.id) && row.created_at <= asOf) {
        logAudit(groupId, myName, `Anlass gelöscht: ${row.name}`);
      }
    });

    // Ausgaben hängen an Anlässen, nicht direkt an der Gruppe – deshalb über
    // ALLE aktuell existierenden Anlässe dieser Gruppe gehen (nicht nur die,
    // die der Client kennt), sonst blieben Ausgaben unter einem dem Client
    // unbekannten, überlebenden Anlass unentdeckt.
    groupEvents.forEach((eventRow) => {
      const payloadExpenseIds = new Set(
        expenses.filter((e) => String(e.eventId) === eventRow.id).map((e) => String(e.id))
      );
      db.prepare('SELECT * FROM expenses WHERE event_id = ?').all(eventRow.id).forEach((row) => {
        if (payloadExpenseIds.has(row.id)) return;
        const isGiftToMe = row.gift_for === myName;
        if (isGiftToMe || row.created_at > asOf) {
          survivorExpenses.push(row);
          db.prepare('SELECT * FROM expense_participants WHERE expense_id = ?').all(row.id)
            .forEach((p) => survivorParticipants.push(p));
        } else {
          // Wirklich gelöscht (kein Survivor-Fall). Betrag mit in den
          // Verlauf, weil "Ausgabe gelöscht: Ente" allein nicht sagt, wie
          // viel Geld damit aus der Rechnung verschwunden ist.
          logAudit(groupId, myName, `Ausgabe gelöscht: ${row.title} (${formatEuro(row.amount)})`);
        }
      });
    });

    const payloadPaymentIds = new Set(
      payments.filter((p) => String(p.groupId) === groupId).map((p) => String(p.id))
    );
    db.prepare('SELECT * FROM payments WHERE group_id = ?').all(groupId).forEach((row) => {
      if (payloadPaymentIds.has(row.id)) return;
      if (row.created_at > asOf) { survivorPayments.push(row); return; }
      // Zahlungen verschwinden im Normalfall nur, wenn der Empfänger eine
      // gemeldete Zahlung ablehnt ("Stimmt nicht" im Zahlungs-Sheet) – daher
      // die Formulierung, nicht schlicht "gelöscht".
      logAudit(groupId, myName, `Zahlungsmeldung abgelehnt: ${row.from_name} → ${row.to_name} (${formatEuro(row.amount)})`);
    });
  });

  db.exec('BEGIN IMMEDIATE');
  try {
    // Touchable Gruppen, die im Payload stehen, werden ohnehin gleich neu
    // eingefügt (normales Update) – die müssen unabhängig vom Schutz für
    // "echt geteilte" Gruppen erst gelöscht werden, sonst schlägt das
    // Einfügen an der UNIQUE-Constraint auf groups.id fehl. Der Schutz gilt
    // ausschließlich für Gruppen, die im Payload FEHLEN (dort würde
    // Löschen sonst implizit durchs bloße Weglassen passieren).
    const toDelete = [...touchable].filter(
      (id) => payloadGroupIds.includes(id) || deletableByOmission.has(id)
    );
    if (toDelete.length) {
      const placeholders = toDelete.map(() => '?').join(',');
      db.prepare(`DELETE FROM groups WHERE id IN (${placeholders})`).run(...toDelete);   // Rest folgt per CASCADE
    }
    db.prepare('DELETE FROM contacts WHERE owner_id = ?').run(userId);
    db.prepare('DELETE FROM barcodes WHERE owner_id = ?').run(userId);

    const insertGroup = db.prepare('INSERT INTO groups (id, owner_id, name, avatar, position, archived) VALUES (?, ?, ?, ?, ?, ?)');
    const insertInvite = db.prepare('INSERT INTO group_invites (group_id, token, created_at) VALUES (?, ?, ?)');
    // is_admin gehört zwingend mit ins INSERT: saveData löscht und schreibt
    // die Gruppe bei jedem Speichern neu. Fehlte die Spalte hier, wären die
    // Admin-Rechte nach dem nächsten Speichervorgang weg – und niemand
    // könnte mehr einladen. Der Client schickt sie nie mit; sie kommt
    // ausschließlich aus dem gespeicherten Stand bzw. aus setGroupAdmin().
    const insertMember = db.prepare(
      'INSERT INTO group_members (id, group_id, name, position, user_id, created_at, is_admin) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const insertEvent = db.prepare(
      'INSERT INTO events (id, group_id, name, position, created_at, start_date, end_date, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const insertExpense = db.prepare(`
      INSERT INTO expenses (id, event_id, category, title, amount, payer, gift_for, date, position, split_mode, created_at, receipt_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertPart = db.prepare('INSERT INTO expense_participants (expense_id, name, position, weight) VALUES (?, ?, ?, ?)');
    const insertPayment = db.prepare(`
      INSERT INTO payments (id, group_id, from_name, to_name, amount, date, position, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertContact = db.prepare('INSERT INTO contacts (owner_id, name, iban, paypal) VALUES (?, ?, ?, ?)');
    const insertBarcode = db.prepare('INSERT INTO barcodes (owner_id, code, title, category, amount) VALUES (?, ?, ?, ?, ?)');

    groups.forEach((group, index) => {
      const groupId = String(group.id);
      if (!ownGroups.has(groupId)) return;

      // owner_id nur bei brandneuen Gruppen setzen; bei bestehenden bleibt
      // der ursprüngliche Ersteller erhalten, statt auf den Speichernden zu
      // wechseln (sonst würde jede Umbenennung durch ein anderes Mitglied
      // den "Ersteller" der Gruppe verändern).
      const owner = previousOwnerByGroup[groupId] || userId;
      insertGroup.run(groupId, owner, String(group.name), group.avatar || null, index, group.archived ? 1 : 0);

      // Änderungsverlauf: Name/Bild/Archiv-Zustand gegen den Stand VOR
      // diesem Speichern vergleichen. Kein vorheriger Stand = brandneue
      // Gruppe, dann reicht ein einziger Eintrag statt dreier Vergleiche.
      const vorherGroup = previousGroupInfoByGroup[groupId];
      if (!vorherGroup) {
        logAudit(groupId, myName, 'Gruppe angelegt');
      } else {
        if (vorherGroup.name !== String(group.name)) {
          logAudit(groupId, myName, `Gruppe umbenannt: „${vorherGroup.name}" → „${group.name}"`);
        }
        if ((vorherGroup.avatar || null) !== (group.avatar || null)) {
          logAudit(groupId, myName, 'Gruppenbild geändert');
        }
        if (Boolean(vorherGroup.archived) !== Boolean(group.archived)) {
          logAudit(groupId, myName, group.archived ? 'Gruppe archiviert' : 'Gruppe aus dem Archiv geholt');
        }
      }

      // Siehe Kommentar oben bei previousInviteByGroup: die Gruppe wurde
      // gerade eben gelöscht+neu angelegt, ein vorhandener Link muss deshalb
      // unverändert zurück, sonst verschwindet er bei diesem Speichern.
      const prevInvite = previousInviteByGroup[groupId];
      if (prevInvite) {
        insertInvite.run(groupId, prevInvite.token, prevInvite.created_at);
      }

      const previous = previousMembersByGroup[groupId] || new Map();

      // Ein Mitglied, das inzwischen ein Konto übernommen hat, heißt jetzt
      // anders als im (womöglich veralteten) Payload. Über claimed_from ist
      // es unter seinem FRÜHEREN Namen weiterhin auffindbar – sonst gälte es
      // als gelöscht und der Beigetretene verlöre die Gruppe.
      const byFormerName = new Map();
      previous.forEach((m) => { if (m.claimed_from) byFormerName.set(m.claimed_from, m); });

      /* Mitgliederliste ändern darf nur der Admin (= Ersteller) der Gruppe.
         Alle anderen speichern hier zwar mit (Ausgaben, Zahlungen, Anlässe),
         ihre Mitgliederliste wird aber verworfen und der gespeicherte Stand
         beibehalten.

         Bewusst die GANZE Liste ignorieren statt nur neue Namen zu filtern:
         Mitglieder werden über den Namen zugeordnet: käme eine Umbenennung
         durch, wäre der alte Name im Payload nicht mehr enthalten und das
         Mitglied würde gelöscht statt umbenannt. Der gespeicherte Stand ist
         hier die sichere Wahl.

         Beitritte über den Einladungslink laufen nicht hierüber, sondern
         über joinViaInvite() – die funktionieren also weiterhin. */
      // Neu angelegte Gruppen haben noch keine Mitgliederzeilen und damit
      // auch noch keinen Admin – wer sie anlegt, darf sie selbstverständlich
      // befüllen. Bei bestehenden Gruppen entscheidet das is_admin-Kennzeichen.
      const istNeu = previous.size === 0;
      const istAdmin = istNeu || [...previous.values()].some((m) => m.user_id === userId && m.is_admin);
      const memberNames = istAdmin
        ? (Array.isArray(group.members) ? group.members : [])
        : [...previous.values()].sort((a, b) => a.position - b.position).map((m) => m.name);

      const written = new Set();
      let position = 0;
      // Für den Änderungsverlauf: nur ECHTE Neuzugänge zählen, keine
      // Umbenennungen/Übernahmen (die haben ja ein "prior").
      const neuHinzugefuegt = [];

      memberNames.forEach((rawName) => {
        const payloadName = String(rawName);
        const prior = previous.get(payloadName) || byFormerName.get(payloadName);

        // Enthält der Payload alten UND neuen Namen derselben Person (weil
        // der Stand zwischendurch neu geladen wurde), darf sie nicht doppelt
        // entstehen – der erste Treffer gewinnt.
        if (prior && written.has(prior.id)) return;
        if (!prior) neuHinzugefuegt.push(payloadName);

        // Der gespeicherte Name gewinnt über den Payload-Namen: der Beitritt
        // hat bewusst umbenannt, ein veralteter Client darf das nicht
        // zurückdrehen.
        const name = prior ? prior.name : payloadName;
        // Der eigene Name im Payload ist laut Namens-Identität-Regel immer
        // das eigene Konto – auch wenn man sich gerade selbst umbenannt hat
        // und der alte Name deshalb nicht mehr in "previous" auftaucht.
        const linkedUserId = name === myName ? userId : (prior ? prior.user_id : null);

        // Brandneue Gruppe: wer sie anlegt, wird ihr erster Admin. Sonst
        // gäbe es niemanden, der einladen dürfte.
        const adminKennzeichen = prior ? (prior.is_admin ? 1 : 0)
          : (istNeu && name === myName ? 1 : 0);

        insertMember.run(
          prior ? prior.id : newId('m'), groupId, name, position++, linkedUserId,
          prior ? prior.created_at : now, adminKennzeichen
        );
        if (prior) written.add(prior.id);
        // claimed_from/linked_at unverändert mitschreiben, sonst ginge die
        // Wiedererkennung beim nächsten Speichern verloren.
        if (prior && (prior.claimed_from || prior.linked_at)) {
          db.prepare('UPDATE group_members SET claimed_from = ?, linked_at = ? WHERE id = ?')
            .run(prior.claimed_from, prior.linked_at, prior.id);
        }
      });

      // Mitglieder mit Konto, die im Payload gar nicht vorkommen und deren
      // Verknüpfung NEUER ist als der Stand des Speichernden: der kann sie
      // nicht gemeint haben, also bleiben sie. Ein bewusstes Entfernen
      // (nach einem Neuladen) funktioniert dadurch weiterhin.
      previous.forEach((m) => {
        if (written.has(m.id) || !m.user_id) return;
        if (!m.linked_at || m.linked_at <= asOf) return;
        insertMember.run(m.id, groupId, m.name, position++, m.user_id, m.created_at, m.is_admin ? 1 : 0);
        written.add(m.id);
        db.prepare('UPDATE group_members SET claimed_from = ?, linked_at = ? WHERE id = ?')
          .run(m.claimed_from, m.linked_at, m.id);
      });

      // Mitglieder, die seit dem Snapshot des Speichernden dazugekommen
      // sind und ihm deshalb unbekannt waren, unverändert wiederherstellen.
      survivorMembers.filter((m) => m.group_id === groupId).forEach((m) => {
        if (written.has(m.id)) return;
        insertMember.run(m.id, groupId, m.name, position++, m.user_id, m.created_at, m.is_admin ? 1 : 0);
        written.add(m.id);
      });

      // Änderungsverlauf: echte Neuzugänge und tatsächlich verschwundene
      // Mitglieder (weder umbenannt noch survivorMember – deren id steht
      // nicht in "written"). Läuft für JEDES Speichern mit, findet im
      // Normalfall aber nichts – das ist gewollt, kein Sonderfall nötig.
      neuHinzugefuegt.forEach((name) => logAudit(groupId, myName, `Mitglied hinzugefügt: ${name}`));
      previous.forEach((m) => {
        if (!written.has(m.id)) logAudit(groupId, myName, `Mitglied entfernt: ${m.name}`);
      });
    });

    events.forEach((event, index) => {
      if (!ownEvents.has(event.id)) return;   // verwaiste Einträge nicht übernehmen
      insertEvent.run(
        String(event.id), String(event.groupId), String(event.name), index, now,
        event.startDate ? String(event.startDate) : null,
        event.endDate ? String(event.endDate) : null,
        event.archived ? 1 : 0
      );

      const gId = String(event.groupId);
      const vorherEvent = alteEventsByGroup[gId]?.get(String(event.id));
      if (!vorherEvent) {
        logAudit(gId, myName, `Anlass angelegt: ${event.name}`);
      } else {
        if (vorherEvent.name !== String(event.name)) {
          logAudit(gId, myName, `Anlass umbenannt: „${vorherEvent.name}" → „${event.name}"`);
        }
        if (Boolean(vorherEvent.archived) !== Boolean(event.archived)) {
          logAudit(gId, myName, `Anlass ${event.archived ? 'archiviert' : 'aus dem Archiv geholt'}: ${event.name}`);
        }
      }
    });
    survivorEvents.forEach((row, i) => {
      insertEvent.run(row.id, row.group_id, row.name, events.length + i, row.created_at, row.start_date, row.end_date, row.archived);
    });

    expenses.forEach((expense, index) => {
      if (!ownEvents.has(expense.eventId)) return;

      const mode = ['equal', 'amount', 'share'].includes(expense.split?.mode)
        ? expense.split.mode : 'equal';
      const weights = expense.split?.values || {};

      insertExpense.run(
        String(expense.id), String(expense.eventId), String(expense.category),
        String(expense.title), Number(expense.amount), String(expense.payer),
        expense.giftFor ? String(expense.giftFor) : null, String(expense.date), index, mode, now,
        expense.receiptId ? String(expense.receiptId) : null
      );

      (Array.isArray(expense.participants) ? expense.participants : []).forEach((name, i) =>
        insertPart.run(String(expense.id), String(name), i,
          mode === 'equal' ? null : (Number(weights[name]) || 0)));

      // Änderungsverlauf: eventId -> groupId auflösen wie beim Push-Anlass
      // "neue Ausgabe" oben – Ausgaben kennen nur ihren Anlass, nicht direkt
      // die Gruppe.
      const eArt = events.find((ev) => String(ev.id) === String(expense.eventId));
      const eGroupId = eArt && String(eArt.groupId);
      if (eGroupId) {
        const vorherAusgabe = alteAusgabenById.get(String(expense.id));
        if (!vorherAusgabe) {
          logAudit(eGroupId, myName, `Ausgabe angelegt: ${expense.title} (${formatEuro(expense.amount)})`);
        } else if (vorherAusgabe.title !== String(expense.title) || Number(vorherAusgabe.amount) !== Number(expense.amount)) {
          logAudit(eGroupId, myName, `Ausgabe geändert: ${expense.title} (${formatEuro(expense.amount)})`);
        }
      }
    });

    // Überlebende Ausgaben (unbekannt-neu ODER Geschenk an den Speichernden
    // selbst) unverändert samt Teilnehmerliste wiederherstellen.
    survivorExpenses.forEach((row, i) => {
      insertExpense.run(
        row.id, row.event_id, row.category, row.title, row.amount, row.payer,
        row.gift_for, row.date, expenses.length + i, row.split_mode, row.created_at, row.receipt_id
      );
    });
    survivorParticipants.forEach((row) => {
      insertPart.run(row.expense_id, row.name, row.position, row.weight);
    });

    payments.forEach((payment, index) => {
      if (!ownGroups.has(payment.groupId)) return;
      insertPayment.run(
        String(payment.id), String(payment.groupId), String(payment.from),
        String(payment.to), Number(payment.amount), String(payment.date), index, now,
        payment.status === 'pending' ? 'pending' : 'confirmed'
      );
    });
    survivorPayments.forEach((row, i) => {
      insertPayment.run(row.id, row.group_id, row.from_name, row.to_name, row.amount, row.date,
        payments.length + i, row.created_at, row.status || 'confirmed');
    });

    Object.entries(contacts).forEach(([name, c]) =>
      insertContact.run(userId, String(name), String(c?.iban || ''), String(c?.paypal || '')));

    Object.entries(barcodes).forEach(([code, b]) =>
      insertBarcode.run(userId, String(code), String(b?.title || ''), String(b?.category || 'other'), Number(b?.amount) || 0));

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  // Frischer Zeitstempel für den Client: Alles, was gerade gespeichert wurde
  // (eigene Änderungen inklusive), ist ihm ab jetzt bekannt – ein späterer
  // Speichervorgang kann diesen neueren Stand als Grundlage nehmen, statt
  // auf dem alten "asOf" von vor dieser Änderung sitzen zu bleiben.
  return { asOf: now, benachrichtigungen };
}

/* -------------------------------- Belege --------------------------------- */

/** Legt einen gescannten Kassenbon ab und gibt seine ID zurück. */
function saveReceipt(userId, { photo, items, total }) {
  const id = newId('r');
  db.prepare(
    'INSERT INTO receipts (id, owner_id, photo, items, total, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    userId,
    typeof photo === 'string' ? photo : null,
    JSON.stringify(Array.isArray(items) ? items : []),
    Number(total) || 0,
    new Date().toISOString()
  );
  return id;
}

/**
 * Beleg lesen. Sichtbar für den Ersteller und für alle, die über eine
 * gemeinsame Gruppe an der zugehörigen Ausgabe beteiligt sind – aber nie
 * für den Beschenkten, wenn die Ausgabe ein Geschenk für ihn ist (gleiche
 * Geheimhaltung wie in loadData).
 */
function getReceipt(userId, receiptId) {
  const row = db.prepare('SELECT * FROM receipts WHERE id = ?').get(receiptId);
  if (!row) throw new ApiError(404, 'Beleg nicht gefunden.');

  if (row.owner_id !== userId) {
    const myName = db.prepare('SELECT name FROM users WHERE id = ?').get(userId)?.name;
    const allowed = db.prepare(`
      SELECT COUNT(*) AS n
        FROM expenses e
        JOIN events ev        ON ev.id = e.event_id
        JOIN group_members gm ON gm.group_id = ev.group_id
       WHERE e.receipt_id = ?
         AND gm.user_id = ?
         AND (e.gift_for IS NULL OR e.gift_for <> ?)
    `).get(receiptId, userId, myName || '').n;
    if (!allowed) throw new ApiError(403, 'Kein Zugriff auf diesen Beleg.');
  }

  let items = [];
  try { items = JSON.parse(row.items || '[]'); } catch { items = []; }
  return { id: row.id, photo: row.photo, items, total: row.total, createdAt: row.created_at };
}

module.exports = {
  ApiError,
  register, login, updateUser, changePassword, deleteUser, ensureDemoUser,
  createSession, userByToken, deleteSession,
  loadData, saveData,
  saveReceipt, getReceipt,
  createInvite, getInviteInfo, joinViaInvite, leaveGroup, deleteGroupExplicit,
  setGroupAdmin, isGroupAdmin,
  savePushSubscription, deletePushSubscription, pushSubscriptionsOf,
  dropPushSubscription, hasPushSubscription,
  createPasswordResetLink, getPasswordResetInfo, redeemPasswordReset,
  getAuditLog
};
