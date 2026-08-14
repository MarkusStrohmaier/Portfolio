/* ==========================================================================
   FreundeTracker – Datenschicht (Browser-Fassung für die Portfolio-Demo)
   --------------------------------------------------------------------------
   Diese Fassung kommt OHNE Server aus: Alles liegt im localStorage des
   Besuchers. Damit läuft die Demo auf reinem Datei-Hosting (GitHub Pages),
   wo kein Node laufen kann.

   Die Schnittstelle ist absichtlich dieselbe wie bei der Server-Fassung
   (siehe apps/freunde/public/store.js) – deshalb musste an der Oberfläche
   keine Zeile geändert werden. Das Projekt war ursprünglich ohnehin so
   gebaut; die Server-Fassung kam erst später dazu.

   Was hier NICHT geht und warum, steht in NUR_MIT_SERVER weiter unten. Diese
   Aufrufe werfen einen erklärenden Fehler, statt still nichts zu tun – die
   Oberfläche zeigt ihn dann als Meldung an.

   Die echte Fassung mit Server, Konten und geteilten Gruppen liegt
   unverändert unter Clauden/FreundeTracker.
   ========================================================================== */

const Store = (() => {

  const SPEICHER = 'ft-demo-daten';
  const NUTZER   = { id: 'demo', name: 'Alex', email: 'demo@freundetracker.local',
                     avatar: null, iban: '', paypal: '', phone: '',
                     createdAt: '2026-07-01T00:00:00.000Z' };

  /* Was ohne Server unmöglich ist – mit Begründung, die der Besucher zu
     sehen bekommt. Lieber eine klare Ansage als ein Knopf, der ins Leere
     greift. */
  const NUR_MIT_SERVER = {
    register:        'Konten gibt es in der Demo nicht – du bist automatisch angemeldet.',
    login:           'Konten gibt es in der Demo nicht – du bist automatisch angemeldet.',
    logout:          'Abmelden gibt es in der Demo nicht: Es gibt kein Konto, zu dem man zurückkehren könnte.',
    changePassword:  'Ein Passwort gibt es in dieser Demo nicht.',
    deleteAccount:   'In der Demo gibt es kein Konto zum Löschen. Zum Zurücksetzen: „Demo zurücksetzen“ unten auf der Seite.',
    createInvite:    'Einladungen brauchen einen Server, den beide Seiten erreichen. In der Demo liegen alle Daten nur in deinem Browser.',
    getInviteInfo:   'Einladungen brauchen einen Server – in der Demo nicht verfügbar.',
    joinInvite:      'Einladungen brauchen einen Server – in der Demo nicht verfügbar.',
    createResetLink: 'Passwort-Links brauchen einen Server – in der Demo nicht verfügbar.',
    getResetInfo:    'Passwort-Links brauchen einen Server – in der Demo nicht verfügbar.',
    redeemReset:     'Passwort-Links brauchen einen Server – in der Demo nicht verfügbar.',
    pushKey:         'Benachrichtigungen verschickt ein Server. Ohne Server kann dich nichts erreichen, wenn die Seite zu ist.',
    pushSubscribe:   'Benachrichtigungen brauchen einen Server – in der Demo nicht verfügbar.',
    pushUnsubscribe: 'Benachrichtigungen brauchen einen Server – in der Demo nicht verfügbar.',
    pushTest:        'Benachrichtigungen brauchen einen Server – in der Demo nicht verfügbar.',
    getAuditLog:     'Den Änderungsverlauf führt der Server mit. In der Demo arbeitet nur eine Person, deshalb gibt es nichts aufzuzeichnen.'
  };

  const nichtVerfuegbar = (was) => () => Promise.reject(new Error(NUR_MIT_SERVER[was]));

  /* ------------------------------ Ablage -------------------------------- */

  function lesen() {
    try {
      const roh = localStorage.getItem(SPEICHER);
      return roh ? JSON.parse(roh) : null;
    } catch {
      return null;   // beschädigt oder gesperrt – dann eben von vorn
    }
  }

  function schreiben(daten) {
    try {
      localStorage.setItem(SPEICHER, JSON.stringify(daten));
      return true;
    } catch {
      // Privates Fenster oder Speicher voll. Die App läuft weiter, der Stand
      // ist nach dem Neuladen nur wieder der Anfangszustand.
      return false;
    }
  }

  /* Beispieldaten – dieselben wie in der Server-Fassung (ensureDemoUser in
     db.js), damit beide Demos denselben Eindruck machen. */
  function beispieldaten() {
    const ich = NUTZER.name;
    return {
      groups: [
        { id: 'g1', name: 'Reisecrew',      members: [ich, 'Anna', 'Ben', 'Clara'] },
        { id: 'g2', name: 'WG Hauptstraße', members: [ich, 'Jonas', 'Mira'] },
        { id: 'g3', name: 'Grillabende',    members: [ich, 'Ben', 'Mira', 'Tom', 'Lea'] }
      ],
      events: [
        { id: 'ev1', groupId: 'g1', name: 'Urlaub China' },
        { id: 'ev2', groupId: 'g1', name: 'Skiwochenende' },
        { id: 'ev3', groupId: 'g2', name: 'Laufende Kosten' },
        { id: 'ev4', groupId: 'g3', name: 'Sommergrillen' }
      ],
      expenses: [
        { id: 'e1',  eventId: 'ev1', category: 'stay',      title: 'Hotel Shanghai',      amount: 640.00, payer: 'Anna',  date: '2026-07-14' },
        { id: 'e2',  eventId: 'ev1', category: 'food',      title: 'Streetfood Peking',   amount:  78.50, payer: ich,     date: '2026-07-16' },
        { id: 'e3',  eventId: 'ev1', category: 'transport', title: 'Bahn nach Xi\'an',    amount: 210.00, payer: 'Ben',   date: '2026-07-17' },
        { id: 'e4',  eventId: 'ev1', category: 'activity',  title: 'Tickets Große Mauer', amount:  96.00, payer: ich,     date: '2026-07-19' },
        { id: 'e5',  eventId: 'ev1', category: 'food',      title: 'Abendessen Xi\'an',   amount: 132.40, payer: 'Clara', date: '2026-07-20' },
        { id: 'e6',  eventId: 'ev2', category: 'stay',      title: 'Hütte',               amount: 380.00, payer: ich,     date: '2026-07-04' },
        { id: 'e7',  eventId: 'ev2', category: 'activity',  title: 'Skipässe',            amount: 480.00, payer: 'Anna',  date: '2026-07-05' },
        { id: 'e8',  eventId: 'ev3', category: 'other',     title: 'Internet Juli',       amount:  45.00, payer: 'Jonas', date: '2026-07-24' },
        { id: 'e9',  eventId: 'ev3', category: 'shopping',  title: 'Putzmittel',          amount:  23.15, payer: ich,     date: '2026-07-18' },
        { id: 'e10', eventId: 'ev4', category: 'food',      title: 'Fleisch & Kohle',     amount:  86.90, payer: ich,     date: '2026-07-21' }
      ],
      payments: [
        { id: 'p1', groupId: 'g2', from: 'Mira', to: ich, amount: 15.00, date: '2026-07-23', status: 'confirmed' }
      ],
      contacts: {},
      barcodes: {},
      receipts: {}
    };
  }

  /** Sorgt dafür, dass die Felder da sind, die die Oberfläche erwartet. */
  function vollstaendig(daten) {
    const d = daten || beispieldaten();
    d.groups = (d.groups || []).map((g) => ({
      ...g,
      members: g.members || [],
      // Ohne Server gibt es keine fremden Konten: Der Besucher ist in jeder
      // Gruppe der Admin und das einzige verknüpfte Mitglied.
      admins: [NUTZER.name],
      linked: [NUTZER.name],
      memberAvatars: {},
      createdBy: g.createdBy || NUTZER.name,
      archived: Boolean(g.archived)
    }));
    d.events    = d.events    || [];
    d.expenses  = d.expenses  || [];
    d.payments  = d.payments  || [];
    d.contacts  = d.contacts  || {};
    d.barcodes  = d.barcodes  || {};
    d.receipts  = d.receipts  || {};
    return d;
  }

  const jetzt = () => new Date().toISOString();

  /* ------------------------------ Zugriffe ------------------------------- */

  function laden() {
    const daten = vollstaendig(lesen());
    schreiben(daten);
    // Geschenke für einen selbst blendet die Server-Fassung aus. Hier gibt
    // es nur eine Person – wer sich selbst beschenkt, darf es auch sehen.
    return { ...daten, linkedContacts: {}, asOf: jetzt() };
  }

  function speichern(neu) {
    const alt = vollstaendig(lesen());
    const daten = {
      groups:   neu.groups   || [],
      events:   neu.events   || [],
      expenses: neu.expenses || [],
      payments: neu.payments || [],
      contacts: neu.contacts || {},
      barcodes: neu.barcodes || {},
      receipts: alt.receipts        // Belege haben eigene Aufrufe, siehe unten
    };
    const ok = schreiben(daten);
    return { ok, asOf: jetzt() };
  }

  /** Gruppe entfernen – ohne Server ist Verlassen und Löschen dasselbe. */
  function gruppeEntfernen(groupId) {
    const d = vollstaendig(lesen());
    const eventIds = d.events.filter((e) => String(e.groupId) === String(groupId)).map((e) => e.id);
    d.groups   = d.groups.filter((g) => String(g.id) !== String(groupId));
    d.events   = d.events.filter((e) => String(e.groupId) !== String(groupId));
    d.expenses = d.expenses.filter((e) => !eventIds.includes(e.eventId));
    d.payments = d.payments.filter((p) => String(p.groupId) !== String(groupId));
    schreiben(d);
  }

  return {
    /* --- Anmeldung: entfällt, es gibt genau einen Besucher --- */
    session:   () => Promise.resolve(lesen() ? NUTZER : null),
    demoLogin: () => { laden(); return Promise.resolve(NUTZER); },

    updateProfile: (patch) => {
      Object.assign(NUTZER, patch || {});
      return Promise.resolve(NUTZER);
    },

    /* --- Daten --- */
    loadData: () => Promise.resolve(laden()),
    saveData: (daten) => Promise.resolve(speichern(daten)),

    /* --- Belege: eigene Ablage, damit die Fotos nicht bei jedem Speichern
           mitgeschleppt werden (gleiche Aufteilung wie mit Server) --- */
    saveReceipt: (beleg) => {
      const d = vollstaendig(lesen());
      const id = 'r' + Date.now().toString(36);
      d.receipts[id] = { id, ...beleg, createdAt: jetzt() };
      schreiben(d);
      return Promise.resolve({ id });
    },
    getReceipt: (id) => {
      const d = vollstaendig(lesen());
      return d.receipts[id]
        ? Promise.resolve(d.receipts[id])
        : Promise.reject(new Error('Beleg nicht gefunden.'));
    },

    /* --- Gruppen --- */
    leaveGroup: (groupId) => { gruppeEntfernen(groupId); return Promise.resolve({ neuerAdmin: null }); },
    deleteGroupExplicit: (groupId) => { gruppeEntfernen(groupId); return Promise.resolve({ ok: true }); },
    // Ohne fremde Konten gibt es niemanden, dem man Rechte geben könnte.
    setGroupAdmin: () => Promise.reject(new Error(
      'Admin-Rechte ergeben nur Sinn, wenn mehrere Konten in einer Gruppe sind. In der Demo bist du allein.')),

    /* --- Alles, was zwingend einen Server braucht --- */
    register:        nichtVerfuegbar('register'),
    login:           nichtVerfuegbar('login'),
    logout:          nichtVerfuegbar('logout'),
    changePassword:  nichtVerfuegbar('changePassword'),
    deleteAccount:   nichtVerfuegbar('deleteAccount'),
    createInvite:    nichtVerfuegbar('createInvite'),
    getInviteInfo:   nichtVerfuegbar('getInviteInfo'),
    joinInvite:      nichtVerfuegbar('joinInvite'),
    createResetLink: nichtVerfuegbar('createResetLink'),
    getResetInfo:    nichtVerfuegbar('getResetInfo'),
    redeemReset:     nichtVerfuegbar('redeemReset'),
    pushKey:         nichtVerfuegbar('pushKey'),
    pushSubscribe:   nichtVerfuegbar('pushSubscribe'),
    pushUnsubscribe: nichtVerfuegbar('pushUnsubscribe'),
    pushTest:        nichtVerfuegbar('pushTest'),
    getAuditLog:     nichtVerfuegbar('getAuditLog'),

    /* --- Demo zurücksetzen (ersetzt „Konto löschen“) --- */
    demoZuruecksetzen: () => {
      try { localStorage.removeItem(SPEICHER); } catch {}
      location.reload();
    }
  };
})();
