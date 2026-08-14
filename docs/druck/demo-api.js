/* ==========================================================================
   MaxlDruck – Browser-Fassung der API (Portfolio-Demo)
   --------------------------------------------------------------------------
   Ersetzt den Express-Server: Dieselben Endpunkte, dieselben Antworten, aber
   alles im localStorage des Besuchers. Damit läuft die Demo auf reinem
   Datei-Hosting (GitHub Pages), wo kein Node laufen kann.

   Das Frontend spricht ausschließlich über App.apiCall() mit dem Server –
   deshalb genügt es, hier dieselben Antworten zu liefern. An der Oberfläche
   musste nichts geändert werden.

   Bewusst NICHT nachgebaut ist die Kalkulation: Arbeitsaufschlag, Summen und
   die PDF-Erzeugung liefen ohnehin schon immer im Browser. Der Server war im
   Wesentlichen Datenhaltung – und genau die steht hier.

   Die echte Fassung mit Express, SQLite und Anmeldung liegt unverändert
   unter Clauden/3D-Preisrechner.
   ========================================================================== */

const DemoAPI = (() => {

  const SPEICHER = 'maxldruck-demo-daten';
  const DEMO_NUTZER = { id: 'demo-admin', name: 'Demo', role: 'admin' };

  /* ----------------------------- Beispieldaten ---------------------------- */
  /* Dieselben Werte wie im Seed der Server-Fassung (apps/druck/seed-demo.js),
     damit beide Demos denselben Eindruck machen. */

  const MATERIALIEN = [
    { id: 1, name: 'PLA Schwarz',   price: 22.90 },
    { id: 2, name: 'PETG Weiß',     price: 27.50 },
    { id: 3, name: 'PLA Holzoptik', price: 34.00 },
    { id: 4, name: 'ASA Grau',      price: 41.20 }
  ];

  const DRUCKER = [
    { id: 1, name: 'Bambu Lab X1C', cost: 1.40 },
    { id: 2, name: 'Prusa MK4',     cost: 0.95 }
  ];

  const KUNDEN = [
    { id: 'demo-k1', name: 'Bäckerei Hofer',   role: 'customer' },
    { id: 'demo-k2', name: 'Modellbau Krenn',  role: 'customer' },
    { id: 'demo-k3', name: 'Tischlerei Wagner', role: 'customer' },
    { id: 'demo-k4', name: 'Familie Pichler',  role: 'customer' }
  ];

  const STAFFEL = [
    { id: 1, max_h: 1,  percent: 10 },
    { id: 2, max_h: 3,  percent: 25 },
    { id: 3, max_h: 5,  percent: 50 },
    { id: 4, max_h: 10, percent: 75 }
  ];

  const cent = (n) => Math.round(n * 100) / 100;

  function druckPosten(name, matId, prId, gramm, stunden) {
    const m = MATERIALIEN.find((x) => x.id === matId);
    const p = DRUCKER.find((x) => x.id === prId);
    const kosten = cent((m.price / 1000) * gramm + p.cost * stunden);
    return { type: 'print', name, desc: `${m.name}, ${gramm}g, ${stunden}h`,
             cost: kosten, rawCost: kosten,
             raw: { mId: String(matId), pId: String(prId), w: gramm, t: stunden } };
  }
  const teilPosten = (name, menge, preis) => ({
    type: 'part', name, desc: `${menge} Stk`,
    cost: cent(menge * preis), rawCost: cent(menge * preis), raw: { q: menge, p: preis }
  });
  const sonstPosten = (name, preis) => ({
    type: 'other', name, desc: 'Sonstiges', cost: cent(preis), rawCost: 0, raw: {}
  });

  function beispielProjekte() {
    const liste = [
      { id: 'PRJ-100241', cid: 'demo-k1', name: 'Displayaufsteller Theke',
        items: [druckPosten('Aufsteller groß', 2, 1, 340, 9.5),
                druckPosten('Kartenhalter', 1, 2, 60, 2.0),
                sonstPosten('Verpackung & Versand', 8.50)],
        work: { h: 2 }, workPct: 25, fail: { g: 0, mid: '' }, failSurcharge: 0,
        date: '14.07.2026', status: 'bezahlt', type: 'Standard', notes: '', payments: [] },

      { id: 'PRJ-100258', cid: 'demo-k2', name: 'Getriebegehäuse Prototyp',
        items: [druckPosten('Gehäuse Unterteil', 4, 1, 610, 16.0),
                druckPosten('Gehäuse Deckel', 4, 1, 280, 7.5),
                teilPosten('Gewindeeinsätze M4', 12, 0.35)],
        work: { h: 4 }, workPct: 50, fail: { g: 180, mid: '4' },
        failSurcharge: cent((41.20 / 1000) * 180 * 0.5),
        date: '22.07.2026', status: 'offen', type: 'Prototyp', notes: '',
        payments: [{ val: 50.00, date: '29.07.2026' }] },

      { id: 'PRJ-100263', cid: 'demo-k3', name: 'Bohrschablonen Set',
        items: [druckPosten('Schablone 32mm', 1, 2, 95, 3.0),
                druckPosten('Schablone 50mm', 1, 2, 130, 4.0),
                druckPosten('Schablone 96mm', 1, 2, 210, 6.5)],
        work: { h: 1 }, workPct: 10, fail: { g: 0, mid: '' }, failSurcharge: 0,
        date: '31.07.2026', status: 'bezahlt', type: 'Standard', notes: '', payments: [] },

      { id: 'PRJ-100271', cid: 'demo-k4', name: 'Ersatzteil Rollladengurt',
        items: [druckPosten('Gurtwickler-Abdeckung', 3, 2, 85, 2.5)],
        work: { h: 0.5 }, workPct: 10, fail: { g: 0, mid: '' }, failSurcharge: 0,
        date: '05.08.2026', status: 'offen', type: 'Reparatur', notes: '', payments: [] },

      { id: 'PRJ-100279', cid: 'demo-k2', name: 'Messeteile Kleinserie',
        items: [druckPosten('Logoschild', 2, 1, 150, 4.0),
                druckPosten('Ständer', 1, 1, 420, 11.0),
                teilPosten('Neodym-Magnete', 20, 0.28),
                sonstPosten('Express-Zuschlag', 15.00)],
        work: { h: 6 }, workPct: 75, fail: { g: 0, mid: '' }, failSurcharge: 0,
        date: '07.08.2026', status: 'offen', type: 'Kleinserie', notes: '', payments: [] }
    ];

    // Bezahlte Projekte auf den Cent genau begleichen – sonst stünde
    // „bezahlt“ neben einem offenen Rest.
    liste.forEach((p) => {
      if (p.status !== 'bezahlt') return;
      const posten = p.items.reduce((s, i) => s + i.cost, 0);
      const gesamt = cent(posten * (1 + (p.workPct || 0) / 100) + (p.failSurcharge || 0));
      p.payments = [{ val: gesamt, date: p.date }];
    });
    return liste;
  }

  /* ------------------------- Filament-Einkauf -----------------------------
     Die Mengen sind bewusst auf den Verbrauch der Projekte oben abgestimmt:

       Material          verdruckt   Ausschuss   Eigenbedarf   eingekauft
       PLA Schwarz          915 g         –         320 g        3000 g
       PETG Weiß            490 g         –           –          2000 g
       PLA Holzoptik         85 g         –         150 g        1000 g
       ASA Grau             890 g       180 g         –          2000 g

     Es muss mehr eingekauft als verbraucht sein, sonst meldet die Seite
     „mehr verdruckt als eingekauft erfasst" und der Bestand steht auf 0.
     Zwei Rechnungen je Material sorgen dafür, dass der Preisverlauf (€/kg)
     überhaupt eine Linie zeichnen kann. */

  const RECHNUNGEN = [
    { id: 'INV-DEMO-1', supplier: 'Bambu Lab', number: '2026-4471', date: '2026-06-12', shipping: 6.90, note: '' },
    { id: 'INV-DEMO-2', supplier: 'Bambu Lab', number: '2026-5120', date: '2026-07-18', shipping: 6.90, note: '' },
    { id: 'INV-DEMO-3', supplier: '3DJake',    number: 'R-88213',  date: '2026-08-05', shipping: 4.95, note: 'Sammelbestellung' }
  ];

  const ROLLEN = [
    // consumed: 1 heißt „diese Rolle ist wirklich leer" – geht jeder
    // Schätzung vor und zeigt die Funktion gleich mit.
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

  const frisch = () => ({
    users: KUNDEN.map((k) => ({ ...k })),
    materials: MATERIALIEN.map((m) => ({ ...m })),
    printers: DRUCKER.map((d) => ({ ...d })),
    projects: beispielProjekte(),
    templates: [],
    invoices: RECHNUNGEN.map((r) => ({ ...r })),
    spools: ROLLEN.map((s) => ({ ...s })),
    ownUsage: EIGENBEDARF.map((o) => ({ ...o })),
    workTiers: STAFFEL.map((s) => ({ ...s })),
    counter: 0
  });

  /* ------------------------------- Ablage --------------------------------- */

  let db = null;

  function laden() {
    if (db) return db;
    try {
      const roh = localStorage.getItem(SPEICHER);
      db = roh ? JSON.parse(roh) : frisch();
    } catch {
      db = frisch();
    }
    return db;
  }

  function sichern() {
    try { localStorage.setItem(SPEICHER, JSON.stringify(db)); } catch { /* voll oder gesperrt */ }
  }

  /** Nächste freie Nummer für Tabellen, die serverseitig AUTOINCREMENT hatten. */
  const naechsteId = (liste) => liste.reduce((max, x) => Math.max(max, Number(x.id) || 0), 0) + 1;

  const zahl = (v) => (isFinite(parseFloat(v)) ? parseFloat(v) : 0);

  /* ------------------------- Verbrauchsrechnung ---------------------------
     Gleiche Logik wie in server.js: Über ALLE Projekte, auch archivierte –
     das Filament wurde ja physisch verbraucht, unabhängig vom Archiv. */
  function filamentVerbrauch(d) {
    const byMaterial = {}, byCustomer = {};
    const topf = (mId) => (byMaterial[mId] = byMaterial[mId] || { printed: 0, failed: 0 });

    d.projects.forEach((p) => {
      (p.items || []).forEach((i) => {
        if (i.type !== 'print' || !i.raw || !i.raw.mId) return;
        const g = zahl(i.raw.w);
        topf(String(i.raw.mId)).printed += g;
        byCustomer[p.cid] = (byCustomer[p.cid] || 0) + g;
      });
      if (p.fail && p.fail.mid && zahl(p.fail.g) > 0) {
        topf(String(p.fail.mid)).failed += zahl(p.fail.g);
      }
    });
    return { byMaterial, byCustomer };
  }

  /* ------------------------------- Routen ---------------------------------
     Der Aufbau spiegelt die Express-Routen: erst die Muster mit Platzhalter,
     dann die festen Pfade. */

  function bearbeite(pfad, methode, koerper) {
    const d = laden();
    const q = pfad.split('?')[1] || '';
    const weg = pfad.split('?')[0];
    const teile = weg.split('/').filter(Boolean);   // ['api', 'projects', 'ID', ...]

    const treffer = (muster) => {
      const m = muster.split('/').filter(Boolean);
      if (m.length !== teile.length) return null;
      const werte = {};
      for (let i = 0; i < m.length; i++) {
        if (m[i].startsWith(':')) werte[m[i].slice(1)] = decodeURIComponent(teile[i]);
        else if (m[i] !== teile[i]) return null;
      }
      return werte;
    };

    let p;

    /* --- Anmeldung: entfällt, jeder ist der Demo-Admin --- */
    if (weg === '/api/login')  return { token: 'demo', user: DEMO_NUTZER };
    if (weg === '/api/register') {
      if (!koerper || !koerper.name) return { error: 'Name erforderlich' };
      if (d.users.some((u) => u.name === koerper.name)) return { error: 'Name vergeben' };
      const id = 'c' + Date.now();
      d.users.push({ id, name: koerper.name, role: 'customer' });
      sichern();
      return { success: true, id };
    }
    if (weg === '/api/user/update') return { success: true };

    /* --- Gesamtstand --- */
    if (weg === '/api/data') {
      const archiviert = /archived=true/.test(q);
      return {
        users: d.users,
        customers: d.users.filter((u) => u.role === 'customer').map((u) => ({ id: u.id, name: u.name })),
        materials: d.materials,
        printers: d.printers,
        projects: d.projects.filter((x) => Boolean(x.archived) === archiviert),
        templates: d.templates,
        invoices: [...d.invoices].sort((a, b) => String(b.date).localeCompare(String(a.date))),
        spools: d.spools,
        ownUsage: [...d.ownUsage].sort((a, b) => String(b.date).localeCompare(String(a.date))),
        workTiers: [...d.workTiers].sort((a, b) => a.max_h - b.max_h),
        filamentUsage: filamentVerbrauch(d)
      };
    }

    /* --- Projekte --- */
    if ((p = treffer('/api/projects/:id/archive')) && methode === 'PUT') {
      const pr = d.projects.find((x) => String(x.id) === p.id);
      if (!pr) return { error: 'Projekt nicht gefunden' };
      pr.archived = koerper && koerper.archived ? 1 : 0;
      sichern();
      return { success: true };
    }
    if ((p = treffer('/api/projects/:id/duplicate')) && methode === 'POST') {
      const pr = d.projects.find((x) => String(x.id) === p.id);
      if (!pr) return { error: 'Projekt nicht gefunden' };
      const neu = JSON.parse(JSON.stringify(pr));
      neu.id = 'DUP_' + Date.now();
      neu.name = pr.name + ' (Kopie)';
      neu.payments = [];
      neu.date = new Date().toLocaleDateString('de-DE');
      d.projects.push(neu);
      sichern();
      return { success: true, newId: neu.id };
    }
    if ((p = treffer('/api/projects/:id')) && methode === 'DELETE') {
      d.projects = d.projects.filter((x) => String(x.id) !== p.id);
      sichern();
      return { success: true };
    }
    if (weg === '/api/projects' && methode === 'POST') {
      const i = d.projects.findIndex((x) => String(x.id) === String(koerper.id));
      const satz = { ...koerper, archived: koerper.archived || 0 };
      if (i >= 0) d.projects[i] = satz; else d.projects.push(satz);
      sichern();
      return { success: true };
    }

    /* --- Vorlagen --- */
    if ((p = treffer('/api/templates/:id')) && methode === 'DELETE') {
      d.templates = d.templates.filter((x) => String(x.id) !== p.id);
      sichern();
      return { success: true };
    }
    if (weg === '/api/templates' && methode === 'POST') {
      const id = naechsteId(d.templates);
      d.templates.push({ id, name: koerper.name, data: koerper.data });
      sichern();
      return { success: true, id };
    }

    /* --- Einkaufsrechnungen --- */
    if ((p = treffer('/api/invoices/:id')) && methode === 'DELETE') {
      d.spools = d.spools.filter((s) => String(s.invoice_id) !== p.id);   // Rollen mit weg
      d.invoices = d.invoices.filter((x) => String(x.id) !== p.id);
      sichern();
      return { success: true };
    }
    if (weg === '/api/invoices' && methode === 'POST') {
      if (!koerper.supplier) return { error: 'Lieferant erforderlich' };
      const id = koerper.id || 'INV-' + Date.now();
      const satz = { id, supplier: koerper.supplier, number: koerper.number || '',
                     date: koerper.date || '', shipping: zahl(koerper.shipping), note: koerper.note || '' };
      const i = d.invoices.findIndex((x) => String(x.id) === String(id));
      if (i >= 0) d.invoices[i] = satz; else d.invoices.push(satz);
      sichern();
      return { success: true, id };
    }

    /* --- Filamentrollen --- */
    if ((p = treffer('/api/spools/:id/consume')) && methode === 'PUT') {
      const s = d.spools.find((x) => String(x.id) === p.id);
      if (!s) return { error: 'Rolle nicht gefunden' };
      s.consumed = koerper && koerper.consumed ? 1 : 0;
      sichern();
      return { success: true };
    }
    if ((p = treffer('/api/spools/:id')) && methode === 'PUT') {
      const s = d.spools.find((x) => String(x.id) === p.id);
      if (!s) return { error: 'Rolle nicht gefunden' };
      if (!koerper.name) return { error: 'Name erforderlich' };
      if (zahl(koerper.weight_g) <= 0) return { error: 'Gewicht muss groesser als 0 sein' };
      if (zahl(koerper.price) < 0) return { error: 'Preis darf nicht negativ sein' };
      Object.assign(s, { name: koerper.name, color: koerper.color || '#9ca3af',
                         weight_g: zahl(koerper.weight_g), price: zahl(koerper.price) });
      sichern();
      return { success: true };
    }
    if ((p = treffer('/api/spools/:id')) && methode === 'DELETE') {
      d.spools = d.spools.filter((x) => String(x.id) !== p.id);
      sichern();
      return { success: true };
    }
    if (weg === '/api/spools' && methode === 'POST') {
      if (!koerper.material_id) return { error: 'Material erforderlich' };
      if (zahl(koerper.weight_g) <= 0) return { error: 'Gewicht muss groesser als 0 sein' };
      if (zahl(koerper.price) < 0) return { error: 'Preis darf nicht negativ sein' };
      const id = koerper.id || 'SP-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
      const satz = { id, invoice_id: koerper.invoice_id || null, material_id: koerper.material_id,
                     name: koerper.name || 'Rolle', color: koerper.color || '#6366f1',
                     weight_g: zahl(koerper.weight_g), price: zahl(koerper.price),
                     purchased_at: koerper.purchased_at || '', note: koerper.note || '', consumed: 0 };
      const i = d.spools.findIndex((x) => String(x.id) === String(id));
      if (i >= 0) d.spools[i] = satz; else d.spools.push(satz);
      sichern();
      return { success: true, id };
    }

    /* --- Eigenverbrauch --- */
    if ((p = treffer('/api/own-usage/:id')) && methode === 'DELETE') {
      d.ownUsage = d.ownUsage.filter((x) => String(x.id) !== p.id);
      sichern();
      return { success: true };
    }
    if (weg === '/api/own-usage' && methode === 'POST') {
      if (!koerper.material_id) return { error: 'Material erforderlich' };
      if (zahl(koerper.grams) <= 0) return { error: 'Gramm muss groesser als 0 sein' };
      const id = koerper.id || 'OU-' + Date.now();
      const satz = { id, material_id: koerper.material_id, grams: zahl(koerper.grams),
                     label: koerper.label || 'Eigenbedarf', date: koerper.date || '' };
      const i = d.ownUsage.findIndex((x) => String(x.id) === String(id));
      if (i >= 0) d.ownUsage[i] = satz; else d.ownUsage.push(satz);
      sichern();
      return { success: true, id };
    }

    /* --- Arbeitsaufschlag-Staffel --- */
    if ((p = treffer('/api/work-tiers/:id')) && methode === 'DELETE') {
      d.workTiers = d.workTiers.filter((x) => String(x.id) !== p.id);
      sichern();
      return { success: true };
    }
    if (weg === '/api/work-tiers' && methode === 'POST') {
      if (zahl(koerper.max_h) <= 0) return { error: 'Stunden muessen groesser als 0 sein' };
      if (zahl(koerper.percent) < 0) return { error: 'Prozent darf nicht negativ sein' };
      const id = naechsteId(d.workTiers);
      d.workTiers.push({ id, max_h: zahl(koerper.max_h), percent: zahl(koerper.percent) });
      sichern();
      return { success: true, id };
    }

    /* --- Material und Drucker --- */
    if ((p = treffer('/api/materials/:id')) && methode === 'DELETE') {
      d.materials = d.materials.filter((x) => String(x.id) !== p.id);
      sichern();
      return { success: true };
    }
    if (weg === '/api/materials' && methode === 'POST') {
      if (!koerper.name || !isFinite(koerper.price) || koerper.price < 0) {
        return { error: 'Name und gueltiger Preis erforderlich' };
      }
      const id = naechsteId(d.materials);
      d.materials.push({ id, name: koerper.name, price: zahl(koerper.price) });
      sichern();
      return { id };
    }
    if ((p = treffer('/api/printers/:id')) && methode === 'DELETE') {
      d.printers = d.printers.filter((x) => String(x.id) !== p.id);
      sichern();
      return { success: true };
    }
    if (weg === '/api/printers' && methode === 'POST') {
      if (!koerper.name || !isFinite(koerper.cost) || koerper.cost < 0) {
        return { error: 'Name und gueltige Kosten erforderlich' };
      }
      const id = naechsteId(d.printers);
      d.printers.push({ id, name: koerper.name, cost: zahl(koerper.cost) });
      sichern();
      return { id };
    }

    /* --- Fortlaufende Rechnungsnummer --- */
    if (weg === '/api/invoice-no/next') {
      d.counter = (d.counter || 0) + 1;
      sichern();
      return { number: `RE-${new Date().getFullYear()}-${String(d.counter).padStart(4, '0')}`, value: d.counter };
    }

    /* --- Was ohne Server nicht geht --- */
    if (weg === '/api/db/export' || weg === '/api/db/import' || weg === '/api/db/nuke') {
      return { error: 'Datenbank-Sicherung gibt es nur in der Fassung mit Server. '
                    + 'Hier liegen die Daten in deinem Browser.' };
    }

    return { error: 'Unbekannter Endpunkt: ' + weg };
  }

  return {
    /** Ersetzt fetch(): gibt dasselbe zurück wie der Server als JSON. */
    call(url, methode, koerper) {
      // Absichtlich verzögert: Der echte Aufruf war auch nicht synchron, und
      // die Oberfläche erwartet ein Promise.
      return Promise.resolve().then(() => bearbeite(url, methode || 'GET', koerper));
    },
    zuruecksetzen() {
      try { localStorage.removeItem(SPEICHER); } catch {}
      db = null;
      location.reload();
    }
  };
})();
