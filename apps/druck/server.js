const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const crypto = require('crypto');

const app = express();

// Schaufenster-Fassung: kein JWT_SECRET noetig, weil die Anmeldung hier
// ausgebaut ist (siehe Kommentar bei authenticate weiter unten).

// Middleware
app.use(cors());
app.use(express.json({ limit: '25mb' }));
// __dirname statt 'public': Der Portfolio-Server startet aus einem anderen
// Verzeichnis, ein relativer Pfad wuerde dort ins Leere zeigen.
app.use(express.static(path.join(__dirname, 'public')));

// Datenbank Setup
const dbPath = path.resolve(__dirname, 'database.sqlite');
let db = new sqlite3.Database(dbPath); // GEÄNDERT IN 'let'

// Tabellen initialisieren
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE,
        pw_hash TEXT,
        role TEXT
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS materials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        price REAL
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS printers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        cost REAL
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        cid TEXT,
        name TEXT,
        data TEXT,
        archived INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // NEU: Projektvorlagen-Tabelle
    db.run(`CREATE TABLE IF NOT EXISTS templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Einkaufsrechnungen (Filament). shipping = Versand/Sonstiges der Rechnung.
    db.run(`CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY,
        supplier TEXT,
        number TEXT,
        date TEXT,
        shipping REAL DEFAULT 0,
        note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Einzelne Filamentrollen - je Rechnungsposition eine Rolle.
    db.run(`CREATE TABLE IF NOT EXISTS spools (
        id TEXT PRIMARY KEY,
        invoice_id TEXT,
        material_id INTEGER,
        name TEXT,
        color TEXT,
        weight_g REAL,
        price REAL,
        purchased_at TEXT,
        note TEXT,
        consumed INTEGER DEFAULT 0
    )`, () => {
        // Migration fuer bestehende Installationen ohne die Spalte. Der Fehler
        // "duplicate column" ist der Normalfall und wird bewusst ignoriert.
        db.run("ALTER TABLE spools ADD COLUMN consumed INTEGER DEFAULT 0", () => { });
    });

    // Eigenverbrauch: alles, was NICHT auf einem Kundenprojekt landet.
    db.run(`CREATE TABLE IF NOT EXISTS own_usage (
        id TEXT PRIMARY KEY,
        material_id INTEGER,
        grams REAL,
        label TEXT,
        date TEXT
    )`);

    // Fortlaufende Zaehler (z.B. Rechnungsnummer).
    db.run(`CREATE TABLE IF NOT EXISTS counters (
        name TEXT PRIMARY KEY,
        value INTEGER DEFAULT 0
    )`);

    // Staffel fuer den Arbeitsaufschlag: bis max_h Stunden gilt percent Prozent.
    // Die oberste Staffel gilt auch fuer alles darueber.
    db.run(`CREATE TABLE IF NOT EXISTS work_tiers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        max_h REAL,
        percent REAL
    )`, () => {
        db.get("SELECT count(*) as count FROM work_tiers", (err, row) => {
            if (err || !row || row.count > 0) return;
            const defaults = [[1, 10], [3, 25], [5, 50], [10, 75]];
            defaults.forEach(t => db.run("INSERT INTO work_tiers (max_h, percent) VALUES (?, ?)", t));
            console.log('Standard-Staffel fuer Arbeitsaufschlag angelegt (bis 1h/10%, 3h/25%, 5h/50%, 10h/75%).');
        });
    });

    // Initialer Admin: Passwort wird zufaellig erzeugt und nur einmalig hier ausgegeben.
    db.get("SELECT count(*) as count FROM users WHERE role='admin'", (err, row) => {
        if (err) return console.error('Admin-Pruefung fehlgeschlagen:', err.message);
        if (!row || row.count > 0) return;

        const pw = crypto.randomBytes(12).toString('base64url');
        bcrypt.hash(pw, 10, (err, hash) => {
            if (err) return console.error('Admin-Anlage fehlgeschlagen:', err.message);
            const id = 'adm_' + Date.now();
            db.run("INSERT INTO users (id, name, pw_hash, role) VALUES (?, ?, ?, ?)",
                [id, 'admin', hash, 'admin'], (err) => {
                    if (err) return console.error('Admin-Anlage fehlgeschlagen:', err.message);
                    console.log([
                        '',
                        '='.repeat(58),
                        ' Kein Admin gefunden - Start-Account wurde angelegt:',
                        '',
                        '   Benutzer:  admin',
                        '   Passwort:  ' + pw,
                        '',
                        ' Dieses Passwort wird NUR JETZT angezeigt.',
                        ' Bitte nach dem ersten Login unter Einstellungen aendern.',
                        '='.repeat(58),
                        ''
                    ].join('\n'));
                });
        });
    });
});

// Hilfsfunktionen
const hashPW = async (pw) => await bcrypt.hash(pw, 10);
const checkPW = async (pw, hash) => await bcrypt.compare(pw, hash);

// Ein defekter Datensatz darf nie den ganzen Request blockieren.
const safeParse = (json, fallback = {}) => {
    try {
        const v = JSON.parse(json);
        return (v && typeof v === 'object') ? v : fallback;
    } catch (e) {
        return fallback;
    }
};

/* ===================== SCHAUFENSTER-FASSUNG =========================
   Das hier ist die Demo-Kopie fuer das Portfolio, NICHT die echte App
   (die liegt unverändert unter Clauden/3D-Preisrechner).

   Die Anmeldung ist bewusst ausgebaut: Jeder Besucher ist automatisch
   derselbe Demo-Admin. Das ist nur vertretbar, weil diese Kopie
   ausschliesslich auf einer eigenen Demo-Datenbank mit erfundenen
   Kunden und Projekten arbeitet – es gibt hier keine echten Daten zu
   schuetzen. In der echten App bleibt die Auth vollstaendig bestehen.
   ==================================================================== */
const DEMO_USER = { id: 'demo-admin', name: 'Demo', role: 'admin' };

const authenticate = (req, res, next) => {
    req.user = DEMO_USER;
    next();
};

const isAdmin = (req, res, next) => next();

/* Weil die Anmeldung ausgebaut ist, waeren diese beiden Endpunkte fuer jeden
   frei aufrufbar – und beide machen die Demo mit einem Aufruf unbrauchbar:
   'nuke' loescht saemtliche Daten, 'import' ersetzt die ganze Datenbank durch
   eine hochgeladene Datei. Im Frontend sind sie nicht verlinkt; das genuegt
   aber nicht, denn die Adresse laesst sich auch direkt aufrufen. */
const DEMO_GESPERRT = ['/api/db/nuke', '/api/db/import'];
app.use((req, res, next) => {
    if (DEMO_GESPERRT.includes(req.path)) {
        return res.status(403).json({ error: 'In der Demo nicht möglich.' });
    }
    next();
});

// === ROUTES ===

// 1. Auth & User Management
// Schaufenster-Fassung: Die Anmeldung laesst jeden als Demo-Admin durch.
// Das Frontend meldet sich beim Laden von selbst an, dieser Endpunkt ist
// nur noch dafuer da, dass der bestehende Ablauf im Frontend funktioniert.
app.post('/api/login', (req, res) => {
    res.json({ token: 'demo', user: DEMO_USER });
});

const MIN_PW_LEN = 8;
const checkPwPolicy = (pw) =>
    (typeof pw === 'string' && pw.length >= MIN_PW_LEN) ? null : `Passwort muss mindestens ${MIN_PW_LEN} Zeichen haben`;

app.post('/api/register', authenticate, isAdmin, async (req, res) => {
    const { name, pw, role } = req.body || {};
    if (role === 'admin') return res.status(403).json({ error: 'Admin-Erstellung nicht erlaubt.' });
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Name erforderlich' });

    const pwError = checkPwPolicy(pw);
    if (pwError) return res.status(400).json({ error: pwError });

    try {
        const hash = await hashPW(pw);
        const id = 'c' + Date.now();
        db.run("INSERT INTO users (id, name, pw_hash, role) VALUES (?, ?, ?, ?)", [id, name, hash, 'customer'], (err) => {
            if (err) return res.status(400).json({ error: 'Name vergeben' });
            res.json({ success: true, id });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/user/update', authenticate, async (req, res) => {
    const { name, pw } = req.body || {};
    const userId = req.user.id;
    if (!name || !pw) return res.status(400).json({ error: 'Daten fehlen' });

    const pwError = checkPwPolicy(pw);
    if (pwError) return res.status(400).json({ error: pwError });

    try {
        const hash = await hashPW(pw);
        db.run("UPDATE users SET name = ?, pw_hash = ? WHERE id = ?", [name, hash, userId], function (err) {
            if (err) return res.status(400).json({ error: 'Name evtl. vergeben' });
            res.json({ success: true });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. Data Fetching (erweitert um Templates und Archiv-Filter)
app.get('/api/data', authenticate, (req, res) => {
    const response = {
        users: [], materials: [], printers: [], projects: [], templates: [],
        invoices: [], spools: [], ownUsage: [], workTiers: [],
        filamentUsage: { byMaterial: {}, byCustomer: {} }
    };
    const showArchived = req.query.archived === 'true';

    const p1 = new Promise(resolve => {
        if (req.user.role === 'admin') {
            db.all("SELECT id, name, role FROM users WHERE role='customer'", (err, rows) => {
                response.customers = rows || [];
                resolve();
            });
        } else {
            response.customers = [{ id: req.user.id, name: req.user.name }];
            resolve();
        }
    });

    const p2 = new Promise(resolve => db.all("SELECT * FROM materials", (err, rows) => {
        response.materials = rows || [];
        resolve();
    }));

    const p3 = new Promise(resolve => db.all("SELECT * FROM printers", (err, rows) => {
        response.printers = rows || [];
        resolve();
    }));

    const p4 = new Promise(resolve => {
        let query = "SELECT * FROM projects WHERE archived = ?";
        let params = [showArchived ? 1 : 0];
        if (req.user.role !== 'admin') {
            query += " AND cid = ?";
            params.push(req.user.id);
        }
        db.all(query, params, (err, rows) => {
            if (err) console.error('Projekte laden:', err.message);
            response.projects = (rows || []).map(row => {
                const data = safeParse(row.data);
                return { ...data, id: row.id, cid: row.cid, name: row.name, archived: row.archived };
            });
            resolve();
        });
    });

    // NEU: Templates laden
    const p5 = new Promise(resolve => {
        if (req.user.role === 'admin') {
            db.all("SELECT * FROM templates", (err, rows) => {
                if (err) console.error('Vorlagen laden:', err.message);
                response.templates = (rows || []).map(row => ({
                    id: row.id,
                    name: row.name,
                    data: safeParse(row.data)
                }));
                resolve();
            });
        } else {
            resolve();
        }
    });

    // Einkaufsdaten sind Betriebsinterna - nur fuer Admins.
    const p6 = new Promise(resolve => {
        if (req.user.role !== 'admin') return resolve();
        let open = 5;
        const done = () => { if (--open === 0) resolve(); };

        db.all("SELECT * FROM work_tiers ORDER BY max_h ASC", (err, rows) => {
            if (err) console.error('Staffel laden:', err.message);
            response.workTiers = rows || [];
            done();
        });

        // Verbrauch bewusst ueber ALLE Projekte, auch archivierte: das Filament
        // wurde physisch verbraucht, unabhaengig vom Archiv-Status im UI.
        db.all("SELECT cid, data FROM projects", (err, rows) => {
            if (err) console.error('Verbrauch berechnen:', err.message);
            const byMaterial = {}, byCustomer = {};
            const bucket = (mId) => (byMaterial[mId] = byMaterial[mId] || { printed: 0, failed: 0 });

            (rows || []).forEach(row => {
                const p = safeParse(row.data);
                (p.items || []).forEach(i => {
                    if (i.type !== 'print' || !i.raw || !i.raw.mId) return;
                    const g = parseFloat(i.raw.w) || 0;
                    bucket(String(i.raw.mId)).printed += g;
                    byCustomer[row.cid] = (byCustomer[row.cid] || 0) + g;
                });
                // Fehldrucke: verbrauchtes Material ohne Gegenwert.
                if (p.fail && p.fail.mid && parseFloat(p.fail.g) > 0) {
                    bucket(String(p.fail.mid)).failed += parseFloat(p.fail.g);
                }
            });
            response.filamentUsage = { byMaterial, byCustomer };
            done();
        });
        db.all("SELECT * FROM invoices ORDER BY date DESC", (err, rows) => {
            if (err) console.error('Rechnungen laden:', err.message);
            response.invoices = rows || [];
            done();
        });
        db.all("SELECT * FROM spools", (err, rows) => {
            if (err) console.error('Rollen laden:', err.message);
            response.spools = rows || [];
            done();
        });
        db.all("SELECT * FROM own_usage ORDER BY date DESC", (err, rows) => {
            if (err) console.error('Eigenverbrauch laden:', err.message);
            response.ownUsage = rows || [];
            done();
        });
    });

    Promise.all([p1, p2, p3, p4, p5, p6]).then(() => res.json(response));
});

// 3. Projects (erweitert)
app.post('/api/projects', authenticate, (req, res) => {
    const p = req.body;
    if (req.user.role !== 'admin' && p.cid !== req.user.id) {
        return res.status(403).json({ error: 'Nicht erlaubt' });
    }
    const dataStr = JSON.stringify(p);
    db.run(`INSERT OR REPLACE INTO projects (id, cid, name, data, archived) VALUES (?, ?, ?, ?, ?)`,
        [p.id, p.cid, p.name, dataStr, p.archived || 0],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

app.delete('/api/projects/:id', authenticate, isAdmin, (req, res) => {
    db.run("DELETE FROM projects WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// NEU: Projekt archivieren/wiederherstellen
app.put('/api/projects/:id/archive', authenticate, isAdmin, (req, res) => {
    const { archived } = req.body;
    db.run("UPDATE projects SET archived = ? WHERE id = ?", [archived ? 1 : 0, req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// NEU: Projekt duplizieren
app.post('/api/projects/:id/duplicate', authenticate, isAdmin, (req, res) => {
    db.get("SELECT * FROM projects WHERE id = ?", [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Projekt nicht gefunden' });

        const data = safeParse(row.data);
        const newId = 'DUP_' + Date.now();
        data.id = newId;
        data.name = data.name + ' (Kopie)';
        data.payments = [];
        data.date = new Date().toLocaleDateString('de-DE');

        db.run("INSERT INTO projects (id, cid, name, data, archived) VALUES (?, ?, ?, ?, 0)",
            [newId, row.cid, data.name, JSON.stringify(data)],
            (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, newId });
            }
        );
    });
});

// 4. Templates (NEU)
app.post('/api/templates', authenticate, isAdmin, (req, res) => {
    const { name, data } = req.body;
    db.run("INSERT INTO templates (name, data) VALUES (?, ?)", [name, JSON.stringify(data)], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
    });
});

app.delete('/api/templates/:id', authenticate, isAdmin, (req, res) => {
    db.run("DELETE FROM templates WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// 4b. Filament-Einkauf: Rechnungen, Rollen, Eigenverbrauch (alles Admin only)
const num = (v) => (isFinite(parseFloat(v)) ? parseFloat(v) : 0);

app.post('/api/invoices', authenticate, isAdmin, (req, res) => {
    const { id, supplier, number, date, shipping, note } = req.body || {};
    if (!supplier) return res.status(400).json({ error: 'Lieferant erforderlich' });

    const invId = id || 'INV-' + Date.now();
    db.run(`INSERT OR REPLACE INTO invoices (id, supplier, number, date, shipping, note) VALUES (?, ?, ?, ?, ?, ?)`,
        [invId, supplier, number || '', date || '', num(shipping), note || ''],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: invId });
        });
});

// Rechnung loeschen nimmt ihre Rollen mit - eine Rolle ohne Rechnung waere ein Waisenkind.
app.delete('/api/invoices/:id', authenticate, isAdmin, (req, res) => {
    db.serialize(() => {
        let failed = null;
        db.run("DELETE FROM spools WHERE invoice_id = ?", [req.params.id], (err) => { if (err) failed = err.message; });
        db.run("DELETE FROM invoices WHERE id = ?", [req.params.id], (err) => {
            if (err || failed) return res.status(500).json({ error: (err && err.message) || failed });
            res.json({ success: true });
        });
    });
});

app.post('/api/spools', authenticate, isAdmin, (req, res) => {
    const { id, invoice_id, material_id, name, color, weight_g, price, purchased_at, note } = req.body || {};
    if (!material_id) return res.status(400).json({ error: 'Material erforderlich' });
    if (num(weight_g) <= 0) return res.status(400).json({ error: 'Gewicht muss groesser als 0 sein' });
    if (num(price) < 0) return res.status(400).json({ error: 'Preis darf nicht negativ sein' });

    const spoolId = id || 'SP-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    db.run(`INSERT OR REPLACE INTO spools (id, invoice_id, material_id, name, color, weight_g, price, purchased_at, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [spoolId, invoice_id || null, material_id, name || 'Rolle', color || '#6366f1',
            num(weight_g), num(price), purchased_at || '', note || ''],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: spoolId });
        });
});

// Rolle als (nicht) verbraucht markieren - Alternative zum Loeschen, wenn eine
// konkrete Rolle leer ist, aber Kaufpreis/Historie erhalten bleiben sollen.
app.put('/api/spools/:id/consume', authenticate, isAdmin, (req, res) => {
    const consumed = req.body && req.body.consumed ? 1 : 0;
    db.run("UPDATE spools SET consumed = ? WHERE id = ?", [consumed, req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Rolle nicht gefunden' });
        res.json({ success: true });
    });
});

// Rolle bearbeiten (Name, Farbe, Gewicht, Preis) - z.B. um Importnamen zu glaetten.
app.put('/api/spools/:id', authenticate, isAdmin, (req, res) => {
    const { name, color, weight_g, price } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Name erforderlich' });
    if (num(weight_g) <= 0) return res.status(400).json({ error: 'Gewicht muss groesser als 0 sein' });
    if (num(price) < 0) return res.status(400).json({ error: 'Preis darf nicht negativ sein' });

    db.run("UPDATE spools SET name = ?, color = ?, weight_g = ?, price = ? WHERE id = ?",
        [name, color || '#9ca3af', num(weight_g), num(price), req.params.id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Rolle nicht gefunden' });
            res.json({ success: true });
        });
});

app.delete('/api/spools/:id', authenticate, isAdmin, (req, res) => {
    db.run("DELETE FROM spools WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Fortlaufende, lueckenlose Rechnungsnummer (fuer Ausgangsrechnungen an Kunden).
// Atomar hochzaehlen, damit keine Nummer doppelt oder uebersprungen wird.
app.post('/api/invoice-no/next', authenticate, isAdmin, (req, res) => {
    db.serialize(() => {
        db.run("INSERT OR IGNORE INTO counters (name, value) VALUES ('invoice', 0)");
        db.run("UPDATE counters SET value = value + 1 WHERE name = 'invoice'", (err) => {
            if (err) return res.status(500).json({ error: err.message });
            db.get("SELECT value FROM counters WHERE name = 'invoice'", (err, row) => {
                if (err || !row) return res.status(500).json({ error: 'Zaehler-Fehler' });
                const year = new Date().getFullYear();
                res.json({ number: `RE-${year}-${String(row.value).padStart(4, '0')}`, value: row.value });
            });
        });
    });
});

app.post('/api/own-usage', authenticate, isAdmin, (req, res) => {
    const { id, material_id, grams, label, date } = req.body || {};
    if (!material_id) return res.status(400).json({ error: 'Material erforderlich' });
    if (num(grams) <= 0) return res.status(400).json({ error: 'Gramm muss groesser als 0 sein' });

    const uId = id || 'OU-' + Date.now();
    db.run(`INSERT OR REPLACE INTO own_usage (id, material_id, grams, label, date) VALUES (?, ?, ?, ?, ?)`,
        [uId, material_id, num(grams), label || 'Eigenbedarf', date || ''],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: uId });
        });
});

app.delete('/api/own-usage/:id', authenticate, isAdmin, (req, res) => {
    db.run("DELETE FROM own_usage WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// 4c. Staffel fuer den Arbeitsaufschlag
app.post('/api/work-tiers', authenticate, isAdmin, (req, res) => {
    const { max_h, percent } = req.body || {};
    if (num(max_h) <= 0) return res.status(400).json({ error: 'Stunden muessen groesser als 0 sein' });
    if (num(percent) < 0) return res.status(400).json({ error: 'Prozent darf nicht negativ sein' });

    db.run("INSERT INTO work_tiers (max_h, percent) VALUES (?, ?)", [num(max_h), num(percent)], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
    });
});

app.delete('/api/work-tiers/:id', authenticate, isAdmin, (req, res) => {
    db.run("DELETE FROM work_tiers WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// 5. Settings (Admin only)
app.post('/api/materials', authenticate, isAdmin, (req, res) => {
    const { name, price } = req.body || {};
    if (!name || !isFinite(price) || price < 0) {
        return res.status(400).json({ error: 'Name und gueltiger Preis erforderlich' });
    }
    db.run("INSERT INTO materials (name, price) VALUES (?, ?)", [name, price], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID });
    });
});

app.delete('/api/materials/:id', authenticate, isAdmin, (req, res) => {
    db.run("DELETE FROM materials WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.post('/api/printers', authenticate, isAdmin, (req, res) => {
    const { name, cost } = req.body || {};
    if (!name || !isFinite(cost) || cost < 0) {
        return res.status(400).json({ error: 'Name und gueltige Kosten erforderlich' });
    }
    db.run("INSERT INTO printers (name, cost) VALUES (?, ?)", [name, cost], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID });
    });
});

app.delete('/api/printers/:id', authenticate, isAdmin, (req, res) => {
    db.run("DELETE FROM printers WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// 6. Backup / Export
app.get('/api/db/export', authenticate, isAdmin, (req, res) => {
    res.download(dbPath, 'maxldruck_backup.sqlite');
});

const upload = multer({ dest: 'uploads/', limits: { fileSize: 100 * 1024 * 1024 } });

// Jede SQLite-Datei beginnt mit diesem Header. Schuetzt davor, dass eine
// versehentlich gewaehlte Datei die komplette Datenbank ueberschreibt.
const isSqliteFile = (file, cb) => {
    fs.open(file, 'r', (err, fd) => {
        if (err) return cb(err, false);
        const buf = Buffer.alloc(16);
        fs.read(fd, buf, 0, 16, 0, (err, bytes) => {
            fs.close(fd, () => { });
            if (err) return cb(err, false);
            cb(null, bytes === 16 && buf.toString('utf8', 0, 15) === 'SQLite format 3');
        });
    });
};

app.post('/api/db/import', authenticate, isAdmin, upload.single('dbfile'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Keine Datei' });

    const tmpPath = req.file.path;
    const cleanup = () => fs.unlink(tmpPath, () => { });

    isSqliteFile(tmpPath, (err, valid) => {
        if (err || !valid) {
            cleanup();
            return res.status(400).json({ error: 'Das ist keine gueltige SQLite-Datenbank. Import abgebrochen.' });
        }

        // Sicherheitskopie der aktuellen DB, damit ein Fehlimport zurueckholbar bleibt.
        const backupPath = dbPath + '.bak-' + Date.now();
        fs.copyFile(dbPath, backupPath, (err) => {
            if (err) {
                cleanup();
                return res.status(500).json({ error: 'Sicherheitskopie fehlgeschlagen, Import abgebrochen' });
            }

            db.close((err) => {
                if (err) console.error('Fehler beim Schliessen:', err.message);

                // Verbindung immer wieder aufbauen - auch im Fehlerfall, sonst ist der Server tot.
                const reopen = (cb) => { db = new sqlite3.Database(dbPath, cb); };

                fs.copyFile(tmpPath, dbPath, (copyErr) => {
                    cleanup();
                    if (copyErr) {
                        // Fehlgeschlagen: alten Stand zurueckholen.
                        fs.copyFile(backupPath, dbPath, () => {
                            reopen(() => res.status(500).json({ error: 'Import fehlgeschlagen, alter Stand wiederhergestellt' }));
                        });
                        return;
                    }
                    reopen((err) => {
                        if (err) {
                            return res.status(500).json({ error: 'Konnte neue DB nicht laden. Sicherheitskopie: ' + path.basename(backupPath) });
                        }
                        console.log('DB importiert. Sicherheitskopie: ' + path.basename(backupPath));
                        res.json({ success: true, backup: path.basename(backupPath) });
                    });
                });
            });
        });
    });
});

app.post('/api/db/nuke', authenticate, isAdmin, (req, res) => {
    let failed = null;
    const track = (err) => { if (err && !failed) failed = err.message; };

    db.serialize(() => {
        db.run("DELETE FROM projects", track);
        db.run("DELETE FROM materials", track);
        db.run("DELETE FROM printers", track);
        db.run("DELETE FROM templates", track);
        db.run("DELETE FROM spools", track);
        db.run("DELETE FROM invoices", track);
        db.run("DELETE FROM own_usage", track);
        // Antwort erst, wenn wirklich alles durchgelaufen ist.
        db.run("DELETE FROM users WHERE role != 'admin'", (err) => {
            track(err);
            if (failed) return res.status(500).json({ error: failed });
            res.json({ success: true });
        });
    });
});

// NEU: CSV Export
app.get('/api/export/csv', authenticate, isAdmin, (req, res) => {
    db.all("SELECT * FROM projects WHERE archived = 0", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        let csv = 'ID;Name;Kunde;Datum;Status;Summe;Bezahlt;Offen\n';

        rows.forEach(row => {
            const data = safeParse(row.data);
            const total = (data.items || []).reduce((a, b) => a + b.cost, 0);
            const paid = (data.payments || []).reduce((a, b) => a + b.val, 0);
            const open = total - paid;
            csv += `${row.id};${row.name};${row.cid};${data.date || '-'};${data.status || 'neu'};${total.toFixed(2)};${paid.toFixed(2)};${open.toFixed(2)}\n`;
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=projekte_export.csv');
        res.send(csv);
    });
});

/* Schaufenster-Fassung: Diese Kopie horcht NICHT selbst auf einem Port,
   sondern wird vom Portfolio-Server unter /druck eingehaengt (siehe
   Portfolio/server.js). Deshalb hier nur exportieren statt listen().

   Die Datenbank-Verbindung haengt mit dran: Die Beispieldaten (seed-demo.js)
   muessen dieselbe Verbindung benutzen, sonst laufen sie los, bevor die
   CREATE-TABLE-Befehle hier oben durch sind. */
app.demoDb = db;
module.exports = app;
