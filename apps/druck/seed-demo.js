/* ==========================================================================
   MaxlDruck – Beispieldaten für die Portfolio-Demo
   --------------------------------------------------------------------------
   Füllt die Demo-Datenbank dieser Schaufenster-Kopie mit erfundenen Kunden,
   Materialien, Druckern und Projekten. Es sind KEINE echten Daten: Die
   richtige App mit den echten Kunden liegt unverändert unter
   Clauden/3D-Preisrechner und wird von hier aus nie angefasst.

   Läuft beim Start des Portfolio-Servers automatisch, aber nur solange die
   Demo-Datenbank leer ist – wer in der Demo etwas anlegt oder löscht,
   bekommt es also nicht beim nächsten Neustart wieder zurückgesetzt.

   Von Hand:  node seed-demo.js
   ========================================================================== */

/* Preise: Material in €/kg, Drucker in €/h – so rechnet der Kalkulator
   (siehe addItem in public/index.html). */
const MATERIALS = [
  { id: 1, name: 'PLA Schwarz',    price: 22.90 },
  { id: 2, name: 'PETG Weiß',      price: 27.50 },
  { id: 3, name: 'PLA Holzoptik',  price: 34.00 },
  { id: 4, name: 'ASA Grau',       price: 41.20 }
];

const PRINTERS = [
  { id: 1, name: 'Bambu Lab X1C', cost: 1.40 },
  { id: 2, name: 'Prusa MK4',     cost: 0.95 }
];

const CUSTOMERS = [
  { id: 'demo-k1', name: 'Bäckerei Hofer' },
  { id: 'demo-k2', name: 'Modellbau Krenn' },
  { id: 'demo-k3', name: 'Tischlerei Wagner' },
  { id: 'demo-k4', name: 'Familie Pichler' }
];

const cents = (n) => Math.round(n * 100) / 100;

/** Ein Druckposten, gerechnet wie im Kalkulator: Material + Druckerzeit. */
function printItem(name, matId, printerId, grams, hours) {
  const mat = MATERIALS.find((m) => m.id === matId);
  const pr = PRINTERS.find((p) => p.id === printerId);
  const cost = cents((mat.price / 1000) * grams + pr.cost * hours);
  return {
    type: 'print',
    name,
    desc: `${mat.name}, ${grams}g, ${hours}h`,
    cost,
    rawCost: cost,
    raw: { mId: String(matId), pId: String(printerId), w: grams, t: hours }
  };
}

/** Zugekauftes Teil (Schrauben, Magnete …) – zählt voll zu den Kosten. */
function partItem(name, qty, unitPrice) {
  const cost = cents(qty * unitPrice);
  return { type: 'part', name, desc: `${qty} Stk`, cost, rawCost: cost, raw: { q: qty, p: unitPrice } };
}

/** Freier Posten (Versand, Verpackung …) – reine Marge, keine Produktionskosten. */
function otherItem(name, price) {
  return { type: 'other', name, desc: 'Sonstiges', cost: cents(price), rawCost: 0, raw: {} };
}

/* Arbeitsaufschlag laut Standard-Staffel (siehe README): bis 1 h +10 %,
   bis 3 h +25 %, bis 5 h +50 %, darüber +75 %. Hier fest eingetragen, weil
   der Wert im echten Projekt beim Speichern eingefroren wird. */
const PROJECTS = [
  {
    id: 'PRJ-100241', cid: 'demo-k1', name: 'Displayaufsteller Theke',
    items: [
      printItem('Aufsteller groß', 2, 1, 340, 9.5),
      printItem('Kartenhalter', 1, 2, 60, 2.0),
      otherItem('Verpackung & Versand', 8.50)
    ],
    work: { h: 2 }, workPct: 25, fail: { g: 0, mid: '' }, failSurcharge: 0,
    date: '14.07.2026', status: 'bezahlt', type: 'Standard', notes: '',
    payments: [{ val: 62.00, date: '18.07.2026' }]
  },
  {
    id: 'PRJ-100258', cid: 'demo-k2', name: 'Getriebegehäuse Prototyp',
    items: [
      printItem('Gehäuse Unterteil', 4, 1, 610, 16.0),
      printItem('Gehäuse Deckel', 4, 1, 280, 7.5),
      partItem('Gewindeeinsätze M4', 12, 0.35)
    ],
    // 4 h Arbeit → +50 %; ein Fehldruck (180 g ASA) wird zur Hälfte verrechnet
    work: { h: 4 }, workPct: 50, fail: { g: 180, mid: '4' },
    failSurcharge: cents((41.20 / 1000) * 180 * 0.5),
    date: '22.07.2026', status: 'offen', type: 'Prototyp', notes: '',
    payments: [{ val: 50.00, date: '29.07.2026' }]
  },
  {
    id: 'PRJ-100263', cid: 'demo-k3', name: 'Bohrschablonen Set',
    items: [
      printItem('Schablone 32mm', 1, 2, 95, 3.0),
      printItem('Schablone 50mm', 1, 2, 130, 4.0),
      printItem('Schablone 96mm', 1, 2, 210, 6.5)
    ],
    work: { h: 1 }, workPct: 10, fail: { g: 0, mid: '' }, failSurcharge: 0,
    date: '31.07.2026', status: 'bezahlt', type: 'Standard', notes: '',
    payments: [{ val: 41.50, date: '02.08.2026' }]
  },
  {
    id: 'PRJ-100271', cid: 'demo-k4', name: 'Ersatzteil Rollladengurt',
    items: [printItem('Gurtwickler-Abdeckung', 3, 2, 85, 2.5)],
    work: { h: 0.5 }, workPct: 10, fail: { g: 0, mid: '' }, failSurcharge: 0,
    date: '05.08.2026', status: 'offen', type: 'Reparatur', notes: '',
    payments: []
  },
  {
    id: 'PRJ-100279', cid: 'demo-k2', name: 'Messeteile Kleinserie',
    items: [
      printItem('Logoschild', 2, 1, 150, 4.0),
      printItem('Ständer', 1, 1, 420, 11.0),
      partItem('Neodym-Magnete', 20, 0.28),
      otherItem('Express-Zuschlag', 15.00)
    ],
    work: { h: 6 }, workPct: 75, fail: { g: 0, mid: '' }, failSurcharge: 0,
    date: '07.08.2026', status: 'offen', type: 'Kleinserie', notes: '',
    payments: []
  }
];

/* ------------------------- Filament-Einkauf -------------------------------
   Die Mengen sind bewusst auf den Verbrauch der Projekte oben abgestimmt:

     Material          verdruckt   Ausschuss   Eigenbedarf   eingekauft
     PLA Schwarz          915 g         –         320 g        3000 g
     PETG Weiß            490 g         –           –          2000 g
     PLA Holzoptik         85 g         –         150 g        1000 g
     ASA Grau             890 g       180 g         –          2000 g

   Es muss mehr eingekauft als verbraucht sein, sonst meldet die Filament-
   Seite „mehr verdruckt als eingekauft erfasst" und der Bestand steht auf 0.
   Zwei Rechnungen je Material sorgen dafür, dass der Preisverlauf (€/kg)
   überhaupt eine Linie zeichnen kann.

   Dieselben Werte stehen in der Browser-Fassung unter docs/druck/demo-api.js
   – beide Demos sollen denselben Eindruck machen. */

const RECHNUNGEN = [
  { id: 'INV-DEMO-1', supplier: 'Bambu Lab', number: '2026-4471', date: '2026-06-12', shipping: 6.90, note: '' },
  { id: 'INV-DEMO-2', supplier: 'Bambu Lab', number: '2026-5120', date: '2026-07-18', shipping: 6.90, note: '' },
  { id: 'INV-DEMO-3', supplier: '3DJake',    number: 'R-88213',  date: '2026-08-05', shipping: 4.95, note: 'Sammelbestellung' }
];

const ROLLEN = [
  // consumed: 1 heißt „diese Rolle ist wirklich leer" – geht jeder Schätzung
  // vor und zeigt die Funktion gleich mit.
  { id: 'SP-DEMO-1', invoice_id: 'INV-DEMO-1', material_id: 1, name: 'PLA Schwarz',   color: '#1f2937', weight_g: 1000, price: 21.99, purchased_at: '2026-06-12', note: '', consumed: 1 },
  { id: 'SP-DEMO-2', invoice_id: 'INV-DEMO-1', material_id: 1, name: 'PLA Schwarz',   color: '#1f2937', weight_g: 1000, price: 21.99, purchased_at: '2026-06-12', note: '', consumed: 0 },
  { id: 'SP-DEMO-3', invoice_id: 'INV-DEMO-1', material_id: 2, name: 'PETG Weiß',     color: '#f1f5f9', weight_g: 1000, price: 26.49, purchased_at: '2026-06-12', note: '', consumed: 0 },
  { id: 'SP-DEMO-4', invoice_id: 'INV-DEMO-2', material_id: 4, name: 'ASA Grau',      color: '#9ca3af', weight_g: 1000, price: 39.90, purchased_at: '2026-07-18', note: '', consumed: 0 },
  { id: 'SP-DEMO-5', invoice_id: 'INV-DEMO-2', material_id: 4, name: 'ASA Grau',      color: '#9ca3af', weight_g: 1000, price: 39.90, purchased_at: '2026-07-18', note: '', consumed: 0 },
  { id: 'SP-DEMO-6', invoice_id: 'INV-DEMO-2', material_id: 3, name: 'PLA Holzoptik', color: '#b4794a', weight_g: 1000, price: 33.90, purchased_at: '2026-07-18', note: '', consumed: 0 },
  { id: 'SP-DEMO-7', invoice_id: 'INV-DEMO-3', material_id: 1, name: 'PLA Schwarz',   color: '#1f2937', weight_g: 1000, price: 19.49, purchased_at: '2026-08-05', note: '', consumed: 0 },
  { id: 'SP-DEMO-8', invoice_id: 'INV-DEMO-3', material_id: 2, name: 'PETG Weiß',     color: '#f1f5f9', weight_g: 1000, price: 24.99, purchased_at: '2026-08-05', note: '', consumed: 0 }
];

const EIGENBEDARF = [
  { id: 'OU-DEMO-1', material_id: 1, grams: 320, label: 'Ersatzteil Waschmaschine', date: '2026-07-12' },
  { id: 'OU-DEMO-2', material_id: 3, grams: 150, label: 'Bilderrahmen Wohnzimmer',  date: '2026-08-02' }
];

/* Gesamtpreis wie in der App: Postensumme + Arbeitsaufschlag + Fehldruck.
   Damit stimmen die Zahlungen unten exakt mit den Rechnungsbeträgen
   überein – sonst stünde in der Demo „bezahlt" neben einem offenen Rest. */
const totalOf = (p) => {
  const items = p.items.reduce((sum, i) => sum + i.cost, 0);
  return cents(items * (1 + (p.workPct || 0) / 100) + (p.failSurcharge || 0));
};

// Was als bezahlt gilt, wird auf den Cent genau beglichen.
PROJECTS.forEach((p) => {
  if (p.status === 'bezahlt') p.payments = [{ val: totalOf(p), date: p.payments[0]?.date || p.date }];
});

/**
 * Legt die Beispieldaten an. Rührt nichts an, was schon da ist.
 *
 * @param db  Verbindung aus server.js. Bewusst dieselbe und keine eigene:
 *            Die Tabellen entstehen dort beim Start, und sqlite3 arbeitet
 *            Befehle je Verbindung der Reihe nach ab – mit einer zweiten
 *            Verbindung wäre das ein Wettlauf ("no such table: projects").
 */
function seed(db, callback = () => {}) {
  db.serialize(() => {
    // Schon befüllt? Dann nichts tun – sonst kämen in der Demo gelöschte
    // Projekte bei jedem Serverstart wieder zurück.
    db.get('SELECT COUNT(*) AS n FROM projects', (err, row) => {
      // Die Verbindung wird hier nie geschlossen – sie gehört dem Server,
      // der danach weiterarbeitet.
      if (err || (row && row.n > 0)) return callback(err || null, false);

      db.serialize(() => {
        const mat = db.prepare('INSERT OR REPLACE INTO materials (id, name, price) VALUES (?, ?, ?)');
        MATERIALS.forEach((m) => mat.run(m.id, m.name, m.price));
        mat.finalize();

        const pr = db.prepare('INSERT OR REPLACE INTO printers (id, name, cost) VALUES (?, ?, ?)');
        PRINTERS.forEach((p) => pr.run(p.id, p.name, p.cost));
        pr.finalize();

        // Kunden sind Benutzerkonten mit der Rolle "customer". Ein Passwort
        // bekommen sie bewusst nicht: In der Demo ist die Anmeldung ohnehin
        // ausgebaut, und ein leerer Hash lässt niemanden durch.
        const usr = db.prepare('INSERT OR REPLACE INTO users (id, name, pw_hash, role) VALUES (?, ?, ?, ?)');
        CUSTOMERS.forEach((c) => usr.run(c.id, c.name, '', 'customer'));
        usr.finalize();

        const prj = db.prepare('INSERT OR REPLACE INTO projects (id, cid, name, data, archived) VALUES (?, ?, ?, ?, 0)');
        PROJECTS.forEach((p) => prj.run(p.id, p.cid, p.name, JSON.stringify(p)));
        prj.finalize();

        // Filament-Einkauf: Rechnungen, Rollen, Eigenbedarf
        const inv = db.prepare('INSERT OR REPLACE INTO invoices (id, supplier, number, date, shipping, note) VALUES (?, ?, ?, ?, ?, ?)');
        RECHNUNGEN.forEach((r) => inv.run(r.id, r.supplier, r.number, r.date, r.shipping, r.note));
        inv.finalize();

        const sp = db.prepare(`INSERT OR REPLACE INTO spools
          (id, invoice_id, material_id, name, color, weight_g, price, purchased_at, note, consumed)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        ROLLEN.forEach((s) => sp.run(s.id, s.invoice_id, s.material_id, s.name, s.color,
                                     s.weight_g, s.price, s.purchased_at, s.note, s.consumed));
        sp.finalize();

        const ou = db.prepare('INSERT OR REPLACE INTO own_usage (id, material_id, grams, label, date) VALUES (?, ?, ?, ?, ?)');
        EIGENBEDARF.forEach((o) => ou.run(o.id, o.material_id, o.grams, o.label, o.date));
        ou.finalize((err2) => callback(err2 || null, true));
      });
    });
  });
}

module.exports = { seed };

// Direkt aufgerufen (node seed-demo.js) statt eingebunden: server.js laden,
// damit die Tabellen entstehen, und dessen Verbindung mitbenutzen.
if (require.main === module) {
  const app = require('./server');
  seed(app.demoDb, (err, written) => {
    if (err) { console.error('Beispieldaten fehlgeschlagen:', err.message); process.exit(1); }
    console.log(written ? 'Beispieldaten angelegt.' : 'Es sind bereits Daten vorhanden – nichts geändert.');
    // Beenden statt close(): server.js legt im Hintergrund noch sein
    // Admin-Konto an, das hier niemanden interessiert – eine geschlossene
    // Verbindung würde dabei nur eine Fehlermeldung erzeugen.
    process.exit(0);
  });
}
