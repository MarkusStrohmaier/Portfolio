/**
 * Beispieldaten für die Filament- & Rechnungsverwaltung.
 *
 *   node seed-filament.js            Beispieldaten anlegen/auffrischen
 *   node seed-filament.js --remove   Beispieldaten restlos entfernen
 *
 * Alle Datensätze tragen "DEMO" in der ID – echte Daten werden nie berührt.
 * Die Mengen sind auf den tatsächlichen Verbrauch der vorhandenen Projekte
 * abgestimmt (PETG ~3.8 kg, PETG-CF 100 g), damit die Auswertung plausibel ist.
 */
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');

const remove = process.argv.includes('--remove');

// material_id: 2 = PETG, 4 = ABS, 5 = PETG-CF (siehe Tabelle materials)
const invoices = [
    { id: 'INV-DEMO-1', supplier: 'Bambu Lab (Beispiel)', number: 'BL-2026-0214', date: '2026-02-12', shipping: 4.99, note: 'Beispieldatensatz' },
    { id: 'INV-DEMO-2', supplier: '3DJake (Beispiel)', number: 'RE-558211', date: '2026-03-05', shipping: 3.95, note: 'Beispieldatensatz' },
    { id: 'INV-DEMO-3', supplier: 'Extrudr (Beispiel)', number: 'EX-2026-1180', date: '2026-05-20', shipping: 0, note: 'Beispieldatensatz' }
];

const spools = [
    // Rechnung 1
    ['SP-DEMO-1', 'INV-DEMO-1', 2, 'PETG Basic Schwarz', '#1c1c1e', 1000, 19.99, '2026-02-12'],
    ['SP-DEMO-2', 'INV-DEMO-1', 2, 'PETG Basic Weiß', '#f1f5f9', 1000, 19.99, '2026-02-12'],
    ['SP-DEMO-3', 'INV-DEMO-1', 2, 'PETG Basic Orange', '#f97316', 1000, 21.99, '2026-02-12'],
    // Rechnung 2
    ['SP-DEMO-4', 'INV-DEMO-2', 2, 'PETG Signalblau', '#2563eb', 1000, 18.49, '2026-03-05'],
    ['SP-DEMO-5', 'INV-DEMO-2', 2, 'PETG Verkehrsrot', '#dc2626', 1000, 18.49, '2026-03-05'],
    ['SP-DEMO-6', 'INV-DEMO-2', 5, 'PETG-CF Carbon', '#27272a', 750, 31.99, '2026-03-05'],
    // Rechnung 3
    ['SP-DEMO-7', 'INV-DEMO-3', 2, 'PETG Maigrün', '#16a34a', 1000, 22.50, '2026-05-20'],
    ['SP-DEMO-8', 'INV-DEMO-3', 4, 'ABS Grau', '#64748b', 1000, 19.90, '2026-05-20']
];

const ownUsage = [
    ['OU-DEMO-1', 2, 250, 'Ersatzteil Waschmaschine (Beispiel)', '2026-03-18'],
    ['OU-DEMO-2', 2, 120, 'Kabelhalter Werkstatt (Beispiel)', '2026-04-02'],
    ['OU-DEMO-3', 4, 300, 'Drucker-Upgrade Halterung (Beispiel)', '2026-06-11'],
    ['OU-DEMO-4', 5, 80, 'Drohnen-Arm privat (Beispiel)', '2026-06-28']
];

db.serialize(() => {
    if (remove) {
        db.run("DELETE FROM spools WHERE id LIKE 'SP-DEMO-%'");
        db.run("DELETE FROM invoices WHERE id LIKE 'INV-DEMO-%'");
        db.run("DELETE FROM own_usage WHERE id LIKE 'OU-DEMO-%'", () => {
            console.log('Beispieldaten entfernt. Deine echten Daten sind unberührt.');
        });
        return;
    }

    invoices.forEach(i => {
        db.run("INSERT OR REPLACE INTO invoices (id, supplier, number, date, shipping, note) VALUES (?, ?, ?, ?, ?, ?)",
            [i.id, i.supplier, i.number, i.date, i.shipping, i.note]);
    });
    spools.forEach(s => {
        db.run(`INSERT OR REPLACE INTO spools (id, invoice_id, material_id, name, color, weight_g, price, purchased_at, note)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Beispieldatensatz')`, s);
    });
    ownUsage.forEach(o => {
        db.run("INSERT OR REPLACE INTO own_usage (id, material_id, grams, label, date) VALUES (?, ?, ?, ?, ?)", o, (err) => {
            if (err) console.error('Fehler:', err.message);
        });
    });

    db.run("SELECT 1", () => {
        console.log(`Beispieldaten angelegt: ${invoices.length} Rechnungen, ${spools.length} Rollen, ${ownUsage.length} Eigenverbrauch-Einträge.`);
        console.log('Entfernen mit:  node seed-filament.js --remove');
    });
});

db.close();
