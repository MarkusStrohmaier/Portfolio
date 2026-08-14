/* ==========================================================================
   FreundeTracker – Anwendungslogik
   Hierarchie: Gruppe → Anlass → Kategorie → Ausgabe
   Gelesen und geschrieben wird ausschließlich über Store (store.js).
   Gestartet wird die App von account.js, sobald die Anmeldung geklärt ist.
   ========================================================================== */

/* ------------------------------- Konstanten ------------------------------ */

const THEME_KEY = 'ft-theme';

/** Kategorien gliedern die Ausgaben innerhalb eines Anlasses. */
const CATEGORIES = {
  food:      { label: 'Essen & Trinken', icon: 'M6 3v8a3 3 0 0 0 6 0V3M9 11v10M18 3c-1.5 1.5-2 3.5-2 6v3h3V3z' },
  stay:      { label: 'Unterkunft',      icon: 'M4 11 12 4l8 7M6 10v10h12V10' },
  transport: { label: 'Transport',       icon: 'M5 17V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10M5 17h14M5 17v2M19 17v2M8 11h8' },
  activity:  { label: 'Aktivitäten',     icon: 'M12 3l2.6 5.6 6 .8-4.4 4.2 1.1 6L12 16.8 6.7 19.6l1.1-6L3.4 9.4l6-.8z' },
  shopping:  { label: 'Einkauf',         icon: 'M4 7h16l-1.4 12.2a2 2 0 0 1-2 1.8H7.4a2 2 0 0 1-2-1.8zM9 7V5a3 3 0 0 1 6 0v2' },
  household: { label: 'Haushalt',        icon: 'M13 2 3 14h7l-1 8 10-12h-7z' },
  health:    { label: 'Gesundheit',      icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v8M8 12h8' },
  entertainment: { label: 'Unterhaltung', icon: 'M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1-2 2H6a2 2 0 0 1-2-2 2 2 0 0 0 0-4zM12 6v2M12 11v2M12 16v2' },
  gift:      { label: 'Geschenke',       icon: 'M4 11h16v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM3 7h18v4H3zM12 7v14M12 7S10.5 3 8.5 3a2 2 0 0 0 0 4zM12 7s1.5-4 3.5-4a2 2 0 0 1 0 4z' },
  other:     { label: 'Sonstiges',       icon: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 8v5M12 16h.01' }
};

const DEFAULT_CATEGORY = 'other';

/**
 * „Geschenke" ist keine frei wählbare Kategorie – sie wird automatisch gesetzt,
 * wenn ein Geschenk erfasst wird. Sonst gäbe es Geschenke ohne Beschenkten.
 */
const SELECTABLE_CATEGORIES = Object.keys(CATEGORIES).filter((key) => key !== 'gift');

/* ---------------------------------- State -------------------------------- */

const state = {
  user: null,                    // angemeldeter Benutzer (aus Store)
  stack: [{ name: 'groups' }],   // Navigationsverlauf, letzter Eintrag = sichtbar
  data: { groups: [], events: [], expenses: [], payments: [], barcodes: {}, contacts: {}, linkedContacts: {}, asOf: null }
};

/** Name, unter dem der angemeldete Benutzer in Gruppen auftaucht. */
const me = () => (state.user ? state.user.name : '');

const view = () => state.stack[state.stack.length - 1];

/* --------------------------------- Helfer -------------------------------- */

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/** Namen kommen aus Nutzereingaben und landen in innerHTML – daher maskieren. */
const esc = (value) => String(value).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const euro = (n) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n);

const formatDate = (iso) =>
  new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'short' }).format(new Date(iso));

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Zeitraum eines Anlasses als lesbarer Text, oder null wenn nichts gesetzt ist. */
function eventDateRange(event) {
  if (!event.startDate && !event.endDate) return null;
  const fmt = (iso) => new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso));
  if (event.startDate && event.endDate && event.startDate !== event.endDate) {
    return `${fmt(event.startDate)} – ${fmt(event.endDate)}`;
  }
  return fmt(event.startDate || event.endDate);
}

/** Initialen aus den Wortanfängen – Zahlen und Sonderzeichen werden ignoriert. */
const initials = (name) => {
  const words = String(name).split(/\s+/).filter((w) => /^\p{L}/u.test(w));
  return (words.length ? words.slice(0, 2).map((w) => w[0]).join('') : String(name).slice(0, 2)).toUpperCase();
};

const nextId = (prefix) => prefix + Math.random().toString(36).slice(2, 9);

const icon = (path) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;

/** Bild oder Initialen – für Benutzer- und Gruppenbilder gleichermaßen. */
/**
 * Bildadresse für ein <img src="…">. Zwei Absicherungen, beide nötig:
 *
 * 1. esc(): Ohne Maskierung könnte man aus dem Attribut ausbrechen. Ein
 *    Profilbild, das jemand über die API auf `" onerror="…` setzt, würde
 *    sonst bei JEDEM Gruppenmitglied Code ausführen, sobald es angezeigt
 *    wird – Profil- und Gruppenbilder sieht die ganze Gruppe.
 * 2. Erlaubte Schemas: nur eingebettete Bilder (data:image/), https und
 *    projekteigene Pfade. So kann hier auch künftig nichts landen, was gar
 *    kein Bild ist.
 *
 * Passt die Adresse nicht ins Muster, gibt es die Initialen statt eines
 * kaputten Bildes – ausfallen soll die Anzeige deswegen nicht.
 */
const safeImageUrl = (url) => {
  const value = String(url || '');
  return /^(data:image\/|https:\/\/|\/)/.test(value) ? esc(value) : '';
};

const mediaAvatar = (avatarUrl, fallbackName) => {
  const src = safeImageUrl(avatarUrl);
  return src ? `<img src="${src}" alt="">` : `<span>${esc(initials(fallbackName))}</span>`;
};

/**
 * Profilbild einer Person in einer bestimmten Gruppe, sonst null (dann
 * zeichnet mediaAvatar die Initialen).
 *
 * Das eigene Bild kommt aus dem eigenen Profil statt aus der Gruppe: der
 * Server lässt es in `memberAvatars` bewusst weg, damit dasselbe Bild nicht
 * in jeder Gruppe erneut mitgeschickt wird (siehe loadData in db.js).
 * Platzhalter ohne Konto haben nie eines – dort bleiben es die Initialen.
 */
const personAvatar = (group, name) =>
  (name === me() ? state.user?.avatar : group?.memberAvatars?.[name]) || null;

/** Kleines rundes Bild mit Namen daneben – Baustein für die Ausgleichszeilen. */
const personChip = (group, name, label, extraClass) => `
  <span class="settle-person">
    <span class="avatar avatar-xs">${mediaAvatar(personAvatar(group, name), name)}</span>
    <span class="${extraClass}">${esc(label)}</span>
  </span>`;

const categoryOf = (key) => CATEGORIES[key] || CATEGORIES[DEFAULT_CATEGORY];

const today = () => new Date().toISOString().slice(0, 10);

/* ------------------------------- Abfragen -------------------------------- */

const groupById = (id) => state.data.groups.find((g) => g.id === id);
const eventById = (id) => state.data.events.find((e) => e.id === id);

const eventsOf = (groupId) => state.data.events.filter((e) => e.groupId === groupId);

/**
 * Ein Geschenk ist für den Beschenkten unsichtbar – sonst wäre die
 * Überraschung hin, sobald er den Preis in einer Liste oder Summe sieht.
 * Deshalb läuft ALLES, was angezeigt oder gerechnet wird, über diesen Filter;
 * nur Löschen und Speichern greifen direkt auf state.data.expenses zu.
 */
const isVisible = (expense) => !expense.giftFor || expense.giftFor !== me();

const visibleExpenses = () => state.data.expenses.filter(isVisible);

const expensesOf = (eventId) => visibleExpenses().filter((e) => e.eventId === eventId);

/** Ausgaben einer ganzen Gruppe – über alle ihre Anlässe hinweg. */
function expensesOfGroup(groupId) {
  const ids = new Set(eventsOf(groupId).map((e) => e.id));
  return visibleExpenses().filter((e) => ids.has(e.eventId));
}

const sumOf = (items) => items.reduce((total, i) => total + i.amount, 0);

const groupOfExpense = (expense) => {
  const event = eventById(expense.eventId);
  return event ? groupById(event.groupId) : null;
};

/**
 * Wer trägt diese Ausgabe mit? Fehlt die Angabe (ältere Einträge), gilt sie
 * für alle Mitglieder. Bei einem Geschenk fällt der Beschenkte immer heraus –
 * auch dann, wenn er in einer alten Teilnehmerliste noch auftaucht.
 */
function participantsOf(expense) {
  const group = groupOfExpense(expense);
  const members = group ? group.members : [];
  const eligible = expense.giftFor ? members.filter((m) => m !== expense.giftFor) : members;

  const listed = Array.isArray(expense.participants)
    ? expense.participants.filter((p) => eligible.includes(p))
    : [];

  return listed.length ? listed : eligible;
}

/**
 * Anteil einer Person an einer Ausgabe.
 *
 *   equal  – gleichmäßig durch alle Teilnehmer (Standard)
 *   amount – feste Beträge je Person
 *   share  – Anteile, z. B. 3 Bier zu 1 Wasser
 *
 * Fehlt die Angabe (ältere Einträge), wird gleichmäßig geteilt.
 */
/**
 * Alle Anteile einer Ausgabe auf einmal – und zwar CENTGENAU: die Summe der
 * Anteile ergibt exakt den Ausgabenbetrag.
 *
 * Warum das wichtig ist: Vorher waren Anteile ungerundete Kommazahlen
 * (10 € auf drei Personen = 3,3333…), bezahlt wurden aber echte Cent (3,33).
 * Pro Ausgabe blieb so ein Rest von Bruchteilen eines Cents liegen, der sich
 * über mehrere Ausgaben aufsummierte – und ab einem halben Cent tauchte im
 * Ausgleich eine hartnäckige „0,01 €"-Zeile auf, obwohl gefühlt alles bezahlt
 * war. Genau das hatte Markus mehrfach.
 *
 * Der Restcent geht an die Teilnehmer mit dem größten abgeschnittenen Anteil
 * („größter Rest"). Bei Gleichstand entscheidet die Reihenfolge der
 * Teilnehmerliste – wichtig, damit immer dasselbe herauskommt und die Salden
 * nicht bei jedem Neuberechnen um einen Cent wandern.
 */
function sharesOf(expense) {
  const participants = participantsOf(expense);
  const result = {};
  if (participants.length === 0) return result;

  const split = expense.split;
  const values = split?.values || {};

  // Feste Beträge sind bewusst eingetippt – die werden nicht umverteilt,
  // nur sauber auf Cent gebracht.
  if (split?.mode === 'amount') {
    participants.forEach((p) => {
      result[p] = Math.round((Number(values[p]) || 0) * 100) / 100;
    });
    return result;
  }

  const weights = participants.map((p) => (split?.mode === 'share' ? (Number(values[p]) || 0) : 1));
  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  const gleichmaessig = !(weightSum > 0);

  const totalCents = Math.round(expense.amount * 100);
  const roh = participants.map((p, i) => (gleichmaessig
    ? totalCents / participants.length
    : totalCents * weights[i] / weightSum));

  const cents = roh.map((v) => Math.floor(v));
  let rest = totalCents - cents.reduce((sum, v) => sum + v, 0);

  const reihenfolge = roh
    .map((v, i) => ({ i, bruch: v - Math.floor(v) }))
    .sort((a, b) => b.bruch - a.bruch || a.i - b.i);

  for (let k = 0; k < reihenfolge.length && rest > 0; k++) {
    cents[reihenfolge[k].i] += 1;
    rest--;
  }

  participants.forEach((p, i) => { result[p] = cents[i] / 100; });
  return result;
}

function shareOf(expense, name) {
  return sharesOf(expense)[name] || 0;
}

/** Teilt sich diese Ausgabe gleichmäßig auf? Steuert nur die Beschriftung. */
const isEqualSplit = (expense) => !expense.split || expense.split.mode === 'equal';

/* --------------------------- Zahlungen & Zustand -------------------------
   Eine Rückzahlung ist erst dann bare Münze, wenn der EMPFÄNGER sie bestätigt
   hat. Deshalb zwei Zustände:

   'confirmed' – bestätigt, zählt zum Saldo. Entsteht, wenn der Empfänger
                 selbst "Zahlung erhalten" bucht (er weiß es ja am besten).
   'pending'   – vom Zahler gemeldet, wartet auf Bestätigung. Zählt bewusst
                 NICHT zum Saldo, sonst könnte jeder seine Schulden einseitig
                 für beglichen erklären.

   Daraus folgt eine Regel, die überall gilt, wo Zahlungen entstehen: Wer
   eine Zahlung einträgt, bei der er selbst der Zahlende ist, kann sie nur
   melden – nie sofort verbuchen.
   ------------------------------------------------------------------------ */

// Bewusst NICHT "isPending": den Namen gibt es weiter unten schon für die
// Löschbestätigung. Gleiche Namen für zwei Dinge sind hier eine echte Falle,
// weil beide Module dieselbe globale Umgebung teilen.
const isUnconfirmedPayment = (payment) => payment.status === 'pending';
const confirmedPayments = () => state.data.payments.filter((p) => !isUnconfirmedPayment(p));

/** Zustand einer neu entstehenden Zahlung – siehe Regel oben. */
const statusForNewPayment = (fromName) => (fromName === me() ? 'pending' : 'confirmed');

/** Gemeldete Zahlungen, die mich betreffen – zum Bestätigen bzw. Abwarten. */
function pendingPayments() {
  const meNow = me();
  return state.data.payments
    .filter(isUnconfirmedPayment)
    .filter((p) => p.from === meNow || p.to === meNow)
    .map((p) => ({ ...p, groupName: groupById(p.groupId)?.name || '' }))
    .filter((p) => p.groupName);
}

/**
 * Kontostand jedes Mitglieds einer Gruppe.
 * paid  = ausgelegt (inklusive geleisteter Rückzahlungen)
 * share = eigener Anteil an allen Ausgaben
 * balance = paid − share; positiv heißt „bekommt Geld".
 */
function memberBalances(groupId) {
  const group = groupById(groupId);
  if (!group) return [];

  const acc = {};
  group.members.forEach((m) => { acc[m] = { name: m, paid: 0, share: 0, sent: 0, received: 0 }; });

  expensesOfGroup(groupId).forEach((expense) => {
    if (acc[expense.payer]) acc[expense.payer].paid += expense.amount;

    // Einmal pro Ausgabe rechnen statt einmal pro Teilnehmer – sharesOf()
    // ermittelt ohnehin immer alle Anteile gemeinsam (nur so lässt sich der
    // Restcent verteilen), und so bleibt die Saldenberechnung schnell.
    const anteile = sharesOf(expense);
    Object.entries(anteile).forEach(([p, betrag]) => {
      if (acc[p]) acc[p].share += betrag;
    });
  });

  // Rückzahlungen bewusst getrennt führen: „ausgelegt" soll heißen, was
  // jemand für die Gruppe eingekauft hat – sonst stünde da irgendwann
  // „-30.000 € ausgelegt", nur weil jemand eine Schuld beglichen hat.
  //
  // Nur BESTÄTIGTE Zahlungen zählen. Eine vom Zahler gemeldete, aber noch
  // nicht bestätigte Zahlung darf den Saldo nicht verändern – sonst könnte
  // jeder seine Schulden einseitig für beglichen erklären.
  confirmedPayments().filter((p) => p.groupId === groupId).forEach((payment) => {
    if (acc[payment.from]) acc[payment.from].sent += payment.amount;
    if (acc[payment.to])   acc[payment.to].received += payment.amount;
  });

  // Auf Cent festnageln: die Anteile sind zwar centgenau, aber das Aufsummieren
  // vieler Kommazahlen erzeugt trotzdem Reste wie 0,30000000000000004. Ohne
  // dieses Runden schleicht sich der alte Fehler durch die Hintertür wieder ein.
  const aufCent = (n) => Math.round(n * 100) / 100;

  return group.members.map((m) => ({
    ...acc[m],
    paid: aufCent(acc[m].paid),
    share: aufCent(acc[m].share),
    balance: aufCent(acc[m].paid - acc[m].share + acc[m].sent - acc[m].received)
  }));
}

/**
 * Vorschlag, wie sich die Gruppe mit möglichst wenigen Überweisungen
 * ausgleicht: größter Schuldner zahlt an größten Gläubiger, bis alles glatt ist.
 */
function settlement(groupId) {
  const debtors = [];
  const creditors = [];

  memberBalances(groupId).forEach((b) => {
    if (b.balance < -0.005) debtors.push({ name: b.name, open: -b.balance });
    else if (b.balance > 0.005) creditors.push({ name: b.name, open: b.balance });
  });

  debtors.sort((a, b) => b.open - a.open);
  creditors.sort((a, b) => b.open - a.open);

  const transfers = [];
  let i = 0;
  let j = 0;

  while (i < debtors.length && j < creditors.length) {
    // Auf Cent runden: was hier steht, wird genau so überwiesen. Eine
    // Überweisung über 3,3333 € kann niemand tätigen – und der ungerundete
    // Rest wäre wieder der Anfang einer 0,01-€-Geisterzeile.
    const amount = Math.round(Math.min(debtors[i].open, creditors[j].open) * 100) / 100;
    if (amount > 0.005) transfers.push({ from: debtors[i].name, to: creditors[j].name, amount });

    debtors[i].open -= amount;
    creditors[j].open -= amount;
    if (debtors[i].open <= 0.005) i++;
    if (creditors[j].open <= 0.005) j++;
  }

  return transfers;
}

/** Wer hat wie viel ausgelegt – absteigend. */
function paidByMember(groupId) {
  const total = sumOf(expensesOfGroup(groupId));

  return memberBalances(groupId)
    .map((b) => ({ name: b.name, paid: b.paid, share: total > 0 ? b.paid / total : 0 }))
    .filter((m) => m.paid > 0.005)
    .sort((a, b) => b.paid - a.paid);
}

/** Ausgaben je Monat, chronologisch – zeigt teure und ruhige Phasen. */
function spendingByMonth(groupId) {
  const expenses = expensesOfGroup(groupId);
  const total = sumOf(expenses);
  const buckets = new Map();

  expenses.forEach((expense) => {
    const key = expense.date.slice(0, 7);            // YYYY-MM
    buckets.set(key, (buckets.get(key) || 0) + expense.amount);
  });

  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, sum]) => ({
      key,
      label: new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' })
        .format(new Date(key + '-01')),
      sum,
      share: total > 0 ? sum / total : 0
    }));
}

/** Einzelne Kennzahlen für die Statistik-Kacheln. */
function groupFacts(groupId) {
  const expenses = expensesOfGroup(groupId);
  if (expenses.length === 0) return null;

  const total = sumOf(expenses);
  const biggest = expenses.reduce((max, e) => (e.amount > max.amount ? e : max), expenses[0]);

  const perEvent = eventsOf(groupId)
    .map((event) => ({ name: event.name, sum: sumOf(expensesOf(event.id)) }))
    .sort((a, b) => b.sum - a.sum);

  const group = groupById(groupId);

  return {
    total,
    count: expenses.length,
    average: total / expenses.length,
    perPerson: group && group.members.length ? total / group.members.length : 0,
    biggest,
    topEvent: perEvent[0] || null
  };
}

/** Summe je Kategorie, absteigend – Grundlage der Übersichts-Balken. */
function categoryStats(expenses) {
  const total = sumOf(expenses);

  return Object.entries(CATEGORIES)
    .map(([key, category]) => {
      const items = expenses.filter((e) => e.category === key);
      const sum = sumOf(items);
      return { key, label: category.label, icon: category.icon, sum, count: items.length,
               share: total > 0 ? sum / total : 0 };
    })
    .filter((c) => c.count > 0)
    .sort((a, b) => b.sum - a.sum);
}

/**
 * Eigener Saldo in einer Gruppe.
 * Positiv = die Gruppe schuldet mir, negativ = ich schulde der Gruppe.
 */
function balanceOf(groupId) {
  const own = memberBalances(groupId).find((b) => b.name === me());
  return own ? own.balance : 0;
}

/** Ausgaben und Zahlungen als eine gemeinsame, datierte Aktivitätsliste. */
function activityFeed(groupId = null) {
  const expenses = (groupId ? expensesOfGroup(groupId) : visibleExpenses())
    .map((e) => ({ ...e, kind: 'expense' }));

  const payments = (groupId ? state.data.payments.filter((p) => p.groupId === groupId) : state.data.payments)
    .map((p) => ({ ...p, kind: 'payment' }));

  return [...expenses, ...payments].sort((a, b) => b.date.localeCompare(a.date));
}

/* ------------------------------- Persistenz ------------------------------ */

let saveFailed = false;

async function persist() {
  // Die Profilbilder der anderen kommen vom Server und werden hier nie
  // geändert – sie bei jedem Speichern wieder hochzuladen wäre reine
  // Verschwendung (gleiche Überlegung wie bei den Belegfotos, siehe
  // store.js). Der Server ignoriert das Feld ohnehin.
  const nutzlast = {
    ...state.data,
    groups: state.data.groups.map(({ memberAvatars, ...rest }) => rest)
  };

  const result = await Store.saveData(nutzlast);
  if (!result && !saveFailed) {
    saveFailed = true;
    console.warn('Daten konnten nicht gespeichert werden – Browser-Speicher nicht verfügbar.');
    return;
  }
  // Ab jetzt gilt der frische Server-Zeitstempel als Wissensstand – schützt
  // künftige Speichervorgänge zuverlässiger vor Zeilen, die andere seither
  // angelegt haben (siehe db.js saveData). Serverzeit statt eigener Uhr,
  // damit eine falsch gehende Client-Uhr den Schutz nicht unterläuft.
  if (result?.asOf) state.data.asOf = result.asOf;
}

/**
 * Beispieldaten für ein frisch angelegtes Konto, damit die App nicht leer
 * startet. Der eigene Name wird als Mitglied eingesetzt.
 *
 * Wichtig: Die IDs müssen pro Aufruf neu erzeugt werden (nextId()), dürfen
 * NICHT fest verdrahtet sein. Die Datenbank hat einen serverweiten Primary
 * Key auf groups.id/events.id/…, nicht pro Konto – zwei Konten mit demselben
 * festen 'g1' hätten sich beim Speichern gegenseitig blockiert (409/500 beim
 * zweiten registrierten Konto).
 */
function demoData(name) {
  const g1 = nextId('g'), g2 = nextId('g'), g3 = nextId('g');
  const ev1 = nextId('ev'), ev2 = nextId('ev'), ev3 = nextId('ev'), ev4 = nextId('ev');

  return {
    groups: [
      { id: g1, name: 'Reisecrew',      members: [name, 'Anna', 'Ben', 'Clara'] },
      { id: g2, name: 'WG Hauptstraße', members: [name, 'Jonas', 'Mira'] },
      { id: g3, name: 'Grillabende',    members: [name, 'Ben', 'Mira', 'Tom', 'Lea'] }
    ],
    events: [
      { id: ev1, groupId: g1, name: 'Urlaub China' },
      { id: ev2, groupId: g1, name: 'Skiwochenende' },
      { id: ev3, groupId: g2, name: 'Laufende Kosten' },
      { id: ev4, groupId: g3, name: 'Sommergrillen' }
    ],
    expenses: [
      { id: nextId('e'), eventId: ev1, category: 'stay',      title: 'Hotel Shanghai',      amount: 640.00, payer: 'Anna',  date: '2026-07-14' },
      { id: nextId('e'), eventId: ev1, category: 'food',      title: 'Streetfood Peking',   amount:  78.50, payer: name,    date: '2026-07-16' },
      { id: nextId('e'), eventId: ev1, category: 'transport', title: 'Bahn nach Xi\'an',    amount: 210.00, payer: 'Ben',   date: '2026-07-17' },
      { id: nextId('e'), eventId: ev1, category: 'activity',  title: 'Tickets Große Mauer', amount:  96.00, payer: name,    date: '2026-07-19' },
      { id: nextId('e'), eventId: ev1, category: 'food',      title: 'Abendessen Xi\'an',   amount: 132.40, payer: 'Clara', date: '2026-07-20' },
      { id: nextId('e'), eventId: ev2, category: 'stay',      title: 'Hütte',               amount: 380.00, payer: name,    date: '2026-07-04' },
      { id: nextId('e'), eventId: ev2, category: 'activity',  title: 'Skipässe',            amount: 480.00, payer: 'Anna',  date: '2026-07-05' },
      { id: nextId('e'), eventId: ev3, category: 'other',     title: 'Internet Juli',       amount:  45.00, payer: 'Jonas', date: '2026-07-24' },
      { id: nextId('e'), eventId: ev3, category: 'shopping',  title: 'Putzmittel',          amount:  23.15, payer: name,    date: '2026-07-18' },
      { id: nextId('e'), eventId: ev4, category: 'food',      title: 'Fleisch & Kohle',     amount:  86.90, payer: name,    date: '2026-07-21' }
    ],
    payments: [
      { id: nextId('p'), groupId: g2, from: 'Mira', to: name, amount: 15.00, date: '2026-07-23' }
    ],
    barcodes: {},
    contacts: {}
  };
}

/**
 * Mitglieder werden über ihren Namen referenziert. Benennt sich der
 * angemeldete Benutzer um, müssen alle Verweise mitgezogen werden.
 */
function renameMember(oldName, newName) {
  if (oldName === newName) return;

  state.data.groups.forEach((g) => {
    g.members = g.members.map((m) => (m === oldName ? newName : m));
  });
  state.data.expenses.forEach((e) => {
    if (e.payer === oldName) e.payer = newName;
    if (e.giftFor === oldName) e.giftFor = newName;

    // Ohne das fällt man nach dem Umbenennen aus allen Teilnehmerlisten und
    // die Aufteilung bestehender Ausgaben ändert sich stillschweigend.
    if (Array.isArray(e.participants)) {
      e.participants = e.participants.map((p) => (p === oldName ? newName : p));
    }
    if (e.split?.values && e.split.values[oldName] !== undefined) {
      e.split.values[newName] = e.split.values[oldName];
      delete e.split.values[oldName];
    }
  });
  state.data.payments.forEach((p) => {
    if (p.from === oldName) p.from = newName;
    if (p.to === oldName) p.to = newName;
  });

  // Auch das Adressbuch hängt am Namen.
  if (state.data.contacts[oldName]) {
    state.data.contacts[newName] = state.data.contacts[oldName];
    delete state.data.contacts[oldName];
  }
}

/* ------------------------------- Bausteine ------------------------------- */

const balanceClass = (n) => (n > 0.005 ? 'is-pos' : n < -0.005 ? 'is-neg' : '');

function balanceCard(amount, label) {
  const hint = amount > 0.005  ? 'Du bekommst Geld zurück'
             : amount < -0.005 ? 'Du schuldest Geld'
             :                   'Alles ausgeglichen';

  return `
    <section class="balance">
      <span class="balance-label">${esc(label)}</span>
      <strong class="balance-value ${balanceClass(amount)}">${euro(amount)}</strong>
      <span class="balance-hint">${hint}</span>
    </section>`;
}

/**
 * Eingeklappte Sammelzeile für Archiviertes – eine ruhige `<details>`-Zeile
 * statt eines eigenen Bildschirms oder eines weiteren sichtbaren Knopfes.
 * Braucht kein JavaScript zum Auf-/Zuklappen, der Browser kann das selbst.
 * Gibt es nichts Archiviertes, erscheint hier auch nichts – die Zeile soll
 * nicht als leerer Hinweis herumstehen.
 */
function archivedSection(items, rowFn, label, labelMany) {
  // Absichtlich das ARRAY entgegennehmen und die Zeilen erst hier selbst
  // bauen (nicht die fertige HTML-Zeichenkette): items.length ist die
  // Anzahl der Einträge, string.length wäre die Zeichenlänge des HTML –
  // genau das war der erste Anlauf dieser Funktion, gefunden beim Testen
  // ("381 archivierte Gruppen" bei EINER archivierten Gruppe).
  if (items.length === 0) return '';
  return `
    <details class="archived-summary">
      <summary>${plural(items.length, label, labelMany)}</summary>
      <ul class="list">${items.map(rowFn).join('')}</ul>
    </details>`;
}

function block(title, count, body, emptyText) {
  // Leerer emptyText (bewusst leer übergeben, z. B. weil eine eingeklappte
  // Archiv-Zeile direkt darunter schon genug sagt) unterdrückt den
  // Hinweistext ganz, statt einen leeren <p class="empty"></p> zu zeigen.
  const leer = emptyText ? `<p class="empty">${esc(emptyText)}</p>` : '';
  return `
    <section class="block">
      <div class="block-head">
        <h2>${esc(title)}</h2>
        <span class="count">${count}</span>
      </div>
      ${count > 0 ? `<ul class="list">${body}</ul>` : leer}
    </section>`;
}

/**
 * Kategorie-Balken. Eine einzige Messgröße (Euro), deshalb bewusst ein
 * Farbton für alle Balken statt bunter Kategoriefarben – die Kategorie steht
 * ja als Text daneben. Jeder Balken ist direkt beschriftet, ein Tooltip wäre
 * auf dem Handy ohnehin nicht bedienbar.
 */
function barList(rows) {
  const body = rows.map((row) => `
    <div class="bar-row">
      <span class="bar-head">
        ${row.icon ? `<span class="bar-icon">${icon(row.icon)}</span>` : ''}
        <span class="bar-label">${esc(row.label)}</span>
        <span class="bar-value">${euro(row.value)}</span>
      </span>
      <span class="bar-track" role="img"
            aria-label="${esc(row.label)}: ${euro(row.value)}, ${Math.round(row.share * 100)} Prozent">
        <span class="bar-fill" style="width:${(row.share * 100).toFixed(1)}%"></span>
      </span>
      ${row.note ? `<span class="bar-note">${esc(row.note)}</span>` : ''}
    </div>`).join('');

  return `<div class="card bars">${body}</div>`;
}

function categoryBars(expenses, title = 'Wofür das Geld ging') {
  const stats = categoryStats(expenses);
  if (stats.length === 0) return '';

  return `
    <section class="block">
      <div class="block-head"><h2>${esc(title)}</h2></div>
      ${barList(stats.map((c) => ({
        label: c.label,
        value: c.sum,
        share: c.share,
        icon: c.icon,
        note: `${Math.round(c.share * 100)} % · ${plural(c.count, 'Ausgabe', 'Ausgaben')}`
      })))}
    </section>`;
}

/**
 * Eigener Abschnitt für Geschenke. Steht getrennt von den übrigen Ausgaben,
 * weil hier immer jemand außen vor bleibt – das soll man auf einen Blick sehen.
 */
function giftSection(groupId) {
  const gifts = expensesOfGroup(groupId)
    .filter((e) => e.giftFor)
    .sort((a, b) => b.date.localeCompare(a.date));

  if (gifts.length === 0) return '';

  const rows = gifts.map((gift) => {
    const participants = participantsOf(gift);
    return `
      <li><button class="row" type="button" data-edit-expense="${gift.id}">
        <span class="avatar avatar-icon">${icon(CATEGORIES.gift.icon)}</span>
        <span class="row-body">
          <span class="row-title">${esc(gift.title)}</span>
          <span class="row-sub">
            Für ${esc(gift.giftFor)} · ${plural(participants.length, 'Person zahlt', 'Personen zahlen')} mit
          </span>
        </span>
        <span class="row-meta">
          <span class="row-amount">${euro(gift.amount)}</span>
          <span class="row-note">je ${euro(gift.amount / participants.length)}</span>
        </span>
      </button></li>`;
  }).join('');

  const hidden = [...new Set(gifts.map((g) => g.giftFor))];

  return `
    <section class="block">
      <div class="block-head">
        <span class="cat-icon">${icon(CATEGORIES.gift.icon)}</span>
        <h2>Geschenke</h2>
        <span class="count">${euro(sumOf(gifts))}</span>
      </div>
      <p class="secret-note">
        ${icon('M3 3l18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.4 5.4A9.5 9.5 0 0 1 12 5c5 0 9 4.5 9 7a12 12 0 0 1-2.2 3.1M6.6 6.7C4.4 8.1 3 10.4 3 12c0 2.5 4 7 9 7a9.6 9.6 0 0 0 3.6-.7')}
        Unsichtbar für ${esc(hidden.join(', '))} – dort taucht weder der Eintrag
        noch der Betrag auf, auch nicht in Summen und Salden.
      </p>
      <ul class="list">${rows}</ul>
    </section>`;
}

/** Kontostand aller Mitglieder plus Vorschlag zum Ausgleichen. */
/**
 * Eine Zeile im „So wird ausgeglichen"-Stil – Von → Zu, Betrag rechts.
 * Gemeinsamer Baustein für die Gruppenansicht (alle Transfers der Gruppe)
 * und die Übersicht (nur die eigenen, gruppenübergreifend), damit beide
 * exakt gleich aussehen. Auf der Übersicht kommt der Gruppenname als zweite
 * Zeile dazu und die Zeile lässt sich antippen, um die Bankverbindung zu öffnen.
 */
function settleRow(transfer, { groupName = null, openIndex = null, groupId = null } = {}) {
  const iPay     = transfer.from === me();
  const iReceive = transfer.to === me();
  const from = iPay     ? 'Du'   : transfer.from;
  const to   = iReceive ? 'dich' : transfer.to;
  const clickable = openIndex !== null;

  // Für die Profilbilder: aus der Gruppenansicht kommt die Gruppe als Option,
  // auf der Übersicht hängt sie an der Zeile selbst (siehe openPayments()).
  // Als Rückfallname für die Initialen dient immer der ECHTE Name, nicht das
  // Etikett – „Du" hätte sonst ein D im Kreis stehen.
  const group = groupById(groupId || transfer.groupId);

  // Betrifft mich, wird also farblich markiert wie überall sonst im Saldo:
  // Grün = ich bekomme, Rost = ich muss zahlen. Zeilen zwischen zwei anderen
  // Leuten (nur in der Gruppenansicht möglich) bleiben neutral.
  const amountClass = iReceive ? 'is-pos' : iPay ? 'is-neg' : '';

  return `
    <${clickable ? 'button' : 'div'} class="settle-row${clickable ? ' settle-row-clickable' : ''}"
      ${clickable ? `type="button" data-open-payment="${openIndex}"` : ''}>
      <span class="settle-line">
        ${personChip(group, transfer.from, from, 'settle-from')}
        <span class="settle-arrow">${icon('M4 12h15M13 6l6 6-6 6')}</span>
        ${personChip(group, transfer.to, to, 'settle-to')}
        <span class="settle-amount ${amountClass}">${euro(transfer.amount)}</span>
      </span>
      ${transfer.reported ? '<span class="settle-tag">gemeldet, wartet auf Bestätigung</span>' : ''}
      ${groupName ? `<span class="settle-sub">${esc(groupName)}</span>` : ''}
    </${clickable ? 'button' : 'div'}>`;
}

const settleDone = (text) => `<p class="settle-done">${icon('M5 13l4 4L19 7')} ${esc(text)}</p>`;

/** „Aktueller Kontostand" – Kontostand-Reiter: wer hat wie viel ausgelegt/erhalten. */
function memberBalanceSection(groupId) {
  const balances = memberBalances(groupId);

  const rows = balances.map((b) => {
    const details = [`${euro(b.paid)} ausgegeben`, `${euro(b.share)} Anteil`];
    if (b.sent > 0.005) details.push(`${euro(b.sent)} gezahlt`);
    if (b.received > 0.005) details.push(`${euro(b.received)} erhalten`);

    return `
    <li><div class="row">
      <span class="avatar">${esc(initials(b.name))}</span>
      <span class="row-body">
        <span class="row-title">${esc(b.name === me() ? `${b.name} (du)` : b.name)}</span>
        <span class="row-sub">${details.join(' · ')}</span>
      </span>
      <span class="row-meta">
        <span class="row-amount ${balanceClass(b.balance)}">${euro(b.balance)}</span>
        <span class="row-note">${b.balance > 0.005 ? 'bekommt' : b.balance < -0.005 ? 'schuldet' : 'ausgeglichen'}</span>
      </span>
    </div></li>`;
  }).join('');

  return `
    <section class="block">
      <div class="block-head"><h2>Aktueller Kontostand</h2></div>
      <ul class="list">${rows}</ul>
    </section>`;
}

/**
 * „So wird ausgeglichen" – alle Überweisungen, die die Gruppe ausgleichen
 * würden (nicht nur die eigenen, siehe openPaymentsSection() dafür). Steht
 * jetzt direkt auf der Übersicht, damit man es sieht, ohne erst in den
 * Kontostand-Reiter wechseln zu müssen.
 *
 * Zeilen, die einen selbst betreffen, sind antippbar und öffnen dasselbe
 * Bestätigen-Sheet wie außerhalb der Gruppe (openPaySheet() aus payments.js,
 * indiziert über dessen globale openPayments()-Liste über alle Gruppen).
 * Zeilen zwischen zwei anderen Personen bleiben reine Anzeige – da gibt es
 * für einen selbst nichts zu bestätigen.
 */
function groupSettleSection(groupId) {
  const transfers = settlement(groupId);
  const globalPayments = transfers.some((t) => t.from === me() || t.to === me()) ? openPayments() : [];

  const involvesMe = (t) => t.from === me() || t.to === me();

  // Was mich betrifft, steht oben und ist anklickbar; der Rest ist nur
  // Information darüber, wie sich die Gruppe untereinander ausgleicht.
  const mine   = transfers.filter(involvesMe);
  const others = transfers.filter((t) => !involvesMe(t));

  const rowFor = (t) => {
    const openIndex = globalPayments.findIndex(
      (p) => p.groupId === groupId && p.from === t.from && p.to === t.to
    );
    return settleRow(t, { groupId, openIndex: openIndex >= 0 ? openIndex : null });
  };

  const settleList = transfers.length === 0
    ? settleDone('Alles ausgeglichen – niemand schuldet jemandem etwas.')
    : mine.map(rowFor).join('')
      + (others.length
          ? `<p class="settle-divider">${mine.length ? 'Zwischen den anderen' : 'Betrifft dich nicht'}</p>`
            + others.map((t) => settleRow(t, { groupId })).join('')
          : '');

  return `
    <section class="block">
      <div class="block-head"><h2>So wird ausgeglichen</h2></div>
      <div class="card settle">
        ${settleList}
        ${transfers.length > 1
          ? `<p class="settle-note">${plural(transfers.length, 'Überweisung', 'Überweisungen')} genügen, um alle Schulden zu tilgen.</p>`
          : ''}
      </div>
    </section>`;
}

/* --------------------------------- Löschen -------------------------------- */

/** Was gerade zum Löschen bestätigt werden soll: { type, id } oder null. */
let pendingDelete = null;

const isPending = (type, id) =>
  pendingDelete !== null && pendingDelete.type === type && pendingDelete.id === id;

/**
 * Löschbereich am Ende einer Gruppen- bzw. Anlassansicht. Erst der zweite
 * Klick löscht wirklich, und vorher steht da, was dabei mit verschwindet.
 */
function deleteSection(type, id) {
  const isGroup = type === 'group';
  const label = isGroup ? 'Gruppe' : 'Anlass';

  // Nur aufzählen, was es tatsächlich gibt – „0 Ausgaben" liest sich albern.
  let loses;
  if (isGroup) {
    loses = [
      [eventsOf(id).length, 'Anlass', 'Anlässe'],
      [expensesOfGroup(id).length, 'Ausgabe', 'Ausgaben'],
      [state.data.payments.filter((p) => p.groupId === id).length, 'Rückzahlung', 'Rückzahlungen']
    ].filter(([n]) => n > 0).map(([n, one, many]) => plural(n, one, many)).join(', ');
  } else {
    const expenses = expensesOf(id);
    loses = expenses.length
      ? `${plural(expenses.length, 'Ausgabe', 'Ausgaben')} über ${euro(sumOf(expenses))}`
      : '';
  }

  const body = isPending(type, id)
    ? `<p class="danger-note">
         ${loses ? `Dabei verschwinden auch: ${loses}. ` : ''}Das lässt sich nicht rückgängig machen.
       </p>
       <div class="sheet-actions">
         <button class="btn btn-ghost" type="button" data-delete-cancel>Abbrechen</button>
         <button class="btn btn-danger" type="button" data-delete-confirm="${type}:${id}">Endgültig löschen</button>
       </div>`
    : `<button class="btn btn-danger btn-block" type="button" data-delete-ask="${type}:${id}">
         ${label} löschen
       </button>`;

  return `
    <section class="block">
      <div class="block-head"><h2>${label} verwalten</h2></div>
      <div class="card">${body}</div>
    </section>`;
}

/**
 * Ob das eigene Konto diese Gruppe verwalten darf (Name/Bild/Mitglieder/Löschen).
 * Jede Gruppe, die überhaupt im eigenen Datenstand auftaucht, kam bereits
 * mitgliedschaftsgefiltert vom Server (loadData) – man ist also praktisch
 * immer Mitglied. Die Prüfung bleibt trotzdem explizit, statt einfach true
 * zurückzugeben, als Absicherung gegen künftige Änderungen an dieser Stelle.
 */
function canManageGroup(group) {
  return group.members.includes(me());
}

/**
 * Admin dieser Gruppe? Seit 2026-08-07 können es mehrere sein, deshalb eine
 * Namensliste statt eines einzelnen Erstellers. `admins` kommt vom Server;
 * fehlt sie (alter Datenstand im Speicher), gilt ersatzweise der Ersteller –
 * so verhält sich die Ansicht auch beim ersten Laden nach dem Update richtig.
 */
function isGroupAdmin(group, name = me()) {
  if (!group) return false;
  return Array.isArray(group.admins) && group.admins.length
    ? group.admins.includes(name)
    : group.createdBy === name;
}

/** Setzt oder entzieht Admin-Rechte und lädt den Stand danach neu. */
async function setGroupAdmin(groupId, name, isAdmin) {
  try {
    await Store.setGroupAdmin(groupId, name, isAdmin);
    // Neu laden statt lokal zu raten: die admins-Liste dieser Gruppe kommt
    // vom Server, ein lokales Umbiegen von state.data wäre nur eine Kopie
    // der Serverlogik, die bei der nächsten Änderung leicht auseinanderläuft.
    //
    // Fehler gefunden (2026-08-09) beim Testen von Nr. 2: hier stand
    // "await refreshAndRender()" – eine Funktion, die es global gar nicht
    // gibt. Es existiert nur eine GLEICHNAMIGE, aber PRIVATE Funktion
    // innerhalb der Invite-Kapselung in invite.js, für app.js unsichtbar.
    // Der Klick auf "Zum Admin machen" endete deshalb seit Nr. 35 lautlos
    // in einer ReferenceError – nie aufgefallen, weil der damalige Test
    // ausschließlich den Server direkt ansprach, nie den echten Knopf.
    state.data = normalizeData(await Store.loadData());
    memberAdminNotice = { type: 'ok',
      text: isAdmin ? `${name} ist jetzt Admin.` : `${name} ist nicht mehr Admin.` };
  } catch (error) {
    memberAdminNotice = { type: 'error', text: error.message };
  }
  render();                  // Liste dahinter: Admin-Kennzeichen aktualisieren
  fillMemberAdminBlock();    // und das offene Formular gleich mit
}

/** Benennt eine Gruppe um. Der Name ist frei wählbar, keine Verweise darauf. */
function renameGroup(groupId, name) {
  const group = groupById(groupId);
  if (group) group.name = name;
}

/**
 * Entfernt ein Mitglied aus einer Gruppe. Vergangene Ausgaben, Zahlungen und
 * Geschenke, die den Namen referenzieren, bleiben unverändert – die Historie
 * wird nicht rückwirkend umgeschrieben. Der Name taucht nur in künftigen
 * Auswahllisten (Zahler, Teilnehmer, …) nicht mehr auf.
 */
/**
 * Entfernt ein Mitglied – und räumt dabei seinen Saldo auf.
 *
 * Warum das nötig ist: Ausgaben behalten den Namen des Bezahlers und seiner
 * Teilnehmer auch dann, wenn die Person kein Mitglied mehr ist.
 * `memberBalances()` legt aber nur für aktuelle Mitglieder einen Eintrag an
 * und überspringt alle anderen. Wer jemanden mit offener Schuld einfach aus
 * der Liste strich, ließ dessen Betrag lautlos verschwinden: Die Anteile
 * ergaben nicht mehr die Rechnungssumme, und die Salden der Übrigen
 * verschoben sich, ohne dass irgendwo etwas davon stand.
 *
 * Deshalb wird der offene Betrag beim Entfernen als Ausgleichszahlung
 * verbucht. Die Bücher gehen weiter auf, und in der Aktivitätsliste ist
 * nachvollziehbar, was passiert ist – statt einer stillen Verschiebung.
 */
/**
 * Verbucht den offenen Saldo einer Person in einer Gruppe als ausgeglichen,
 * OHNE sie aus der Mitgliederliste zu entfernen. Herausgelöst aus
 * removeMember() (2026-08-09), weil dieselbe Notwendigkeit auch beim
 * Löschen des eigenen Kontos besteht: Man verlässt dabei jede Gruppe, in
 * der man Mitglied ist – ohne diesen Ausgleich würde ein offener Saldo
 * genau wie damals bei removeMember() lautlos verschwinden.
 *
 * Bewusst OHNE das Mitglied zu entfernen: anders als beim Entfernen durch
 * einen Admin (removeMember – die Person verlässt die Gruppe endgültig,
 * der Name bleibt nur für die Historie stehen) bleibt man beim Verlassen
 * bzw. Löschen des eigenen Kontos ohnehin als namentlicher Platzhalter in
 * der Mitgliederliste stehen (siehe leaveGroup/deleteUser in db.js,
 * "Historie bleibt lesbar") – das Entfernen aus members[] ist hier also
 * nicht die richtige Aktion.
 */
function settleMemberBalance(groupId, name) {
  const saldo = memberBalances(groupId).find((b) => b.name === name)?.balance || 0;
  if (Math.abs(saldo) <= 0.005) return;

  // Schuldner: er "zahlt" an die Gläubiger. Gläubiger: die Schuldner
  // "zahlen" an ihn. In beide Richtungen bleibt die Summe aller Salden 0.
  const gegenseite = memberBalances(groupId)
    .filter((b) => b.name !== name && Math.sign(b.balance) === -Math.sign(saldo))
    .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));

  let offen = Math.abs(saldo);
  gegenseite.forEach((partner) => {
    if (offen <= 0.005) return;
    const betrag = Math.round(Math.min(offen, Math.abs(partner.balance)) * 100) / 100;
    if (betrag <= 0.005) return;
    offen = Math.round((offen - betrag) * 100) / 100;

    state.data.payments.unshift({
      id: nextId('p'),
      groupId,
      from: saldo < 0 ? name : partner.name,
      to:   saldo < 0 ? partner.name : name,
      amount: betrag,
      date: today(),
      // Bewusst sofort gültig: der Ausgleich ist Teil des Entfernens/
      // Verlassens und kann nicht mehr bestätigt werden – die Person ist
      // ja gleich weg bzw. das Konto gelöscht.
      status: 'confirmed'
    });
  });
}

function removeMember(groupId, name) {
  const group = groupById(groupId);
  if (!group) return;

  settleMemberBalance(groupId, name);
  group.members = group.members.filter((m) => m !== name);
}

/** Offener Saldo eines Mitglieds – Grundlage für die Rückfrage beim Entfernen. */
function memberBalanceOf(groupId, name) {
  return memberBalances(groupId).find((b) => b.name === name)?.balance || 0;
}

/** Entfernt eine Gruppe samt Anlässen, Ausgaben und Rückzahlungen. */
function deleteGroup(groupId) {
  const eventIds = new Set(eventsOf(groupId).map((e) => e.id));

  state.data.expenses = state.data.expenses.filter((e) => !eventIds.has(e.eventId));
  state.data.events   = state.data.events.filter((e) => e.groupId !== groupId);
  state.data.payments = state.data.payments.filter((p) => p.groupId !== groupId);
  state.data.groups   = state.data.groups.filter((g) => g.id !== groupId);
}

/** Entfernt einen Anlass samt seiner Ausgaben. */
function deleteEvent(eventId) {
  state.data.expenses = state.data.expenses.filter((e) => e.eventId !== eventId);
  state.data.events   = state.data.events.filter((e) => e.id !== eventId);
}

/** Eine Zeile der Aktivitätsliste – Ausgabe oder Rückzahlung. */
/** Kleines Kennzeichen an Ausgaben, an denen ein gescannter Beleg hängt. */
const receiptTag = () => '<span class="receipt-tag" title="Beleg vorhanden">Beleg</span>';

function activityRow(item, { showEvent = true } = {}) {
  if (item.kind === 'payment') {
    // Noch nicht bestätigte Zahlungen dürfen hier nicht wie erledigt
    // aussehen – sie zählen ja auch nicht zum Saldo.
    const offen = isUnconfirmedPayment(item);
    return `
      <li><button class="row${offen ? ' row-unconfirmed' : ''}" type="button" data-edit-payment="${item.id}">
        <span class="avatar">${esc(initials(item.from))}</span>
        <span class="row-body">
          <span class="row-title">${esc(item.from === me() ? 'Du' : item.from)} → ${esc(item.to === me() ? 'dir' : item.to)}</span>
          <span class="row-sub">${offen ? 'Rückzahlung · noch nicht bestätigt' : 'Rückzahlung'}</span>
        </span>
        <span class="row-meta">
          <span class="row-amount">${euro(item.amount)}</span>
          <span class="row-note">${formatDate(item.date)}</span>
        </span>
        <span class="row-chevron">${icon('M9 5l7 7-7 7')}</span>
      </button></li>`;
  }

  const event = eventById(item.eventId);
  const category = categoryOf(item.category);
  const what = item.giftFor ? `Geschenk für ${esc(item.giftFor)}` : category.label;
  const sub = showEvent && event ? `${esc(event.name)} · ${what}` : what;

  return `
    <li><button class="row" type="button" data-edit-expense="${item.id}">
      <span class="avatar avatar-icon">${icon(category.icon)}</span>
      <span class="row-body">
        <span class="row-title">${esc(item.title)}${item.receiptId ? receiptTag() : ''}</span>
        <span class="row-sub">${sub} · ${esc(item.payer === me() ? 'Du hast' : item.payer + ' hat')} bezahlt</span>
      </span>
      <span class="row-meta">
        <span class="row-amount">${euro(item.amount)}</span>
        <span class="row-note">${formatDate(item.date)}</span>
      </span>
    </button></li>`;
}

/* -------------------------------- Ansichten ------------------------------ */

const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * „Wie" die nächste Ansicht wechseln soll: 'forward' rutscht wie ein
 * Reinzoomen von rechts (go), 'back' spiegelverkehrt (goBack). Reiterwechsel
 * und sonstige Neuzeichnungen setzen das nicht, dort reicht ein Crossfade.
 * Wird von render() sofort wieder auf 'none' zurückgesetzt, betrifft also
 * immer nur den einen nächsten Aufruf.
 */
let pendingNavDirection = 'none';

/**
 * Blendet zwischen zwei Ansichten sanft über, per View-Transition-API dort,
 * wo verfügbar (Chrome/Edge, auch mobil) – ohne die Funktion, einfacher
 * Sprung wie bisher. Kein Fehler, keine Extra-Arbeit für ältere Browser.
 */
function render() {
  const direction = pendingNavDirection;
  pendingNavDirection = 'none';

  if (prefersReducedMotion() || !document.startViewTransition) {
    renderNow();
    return;
  }

  document.documentElement.dataset.navDir = direction;

  // Folgen zwei Renders dicht aufeinander (z. B. Serverantwort direkt nach
  // einem Klick), bricht der Browser den laufenden Übergang ab und lehnt
  // dessen Zusagen ab. Gezeichnet wird trotzdem sauber, nur die Animation
  // entfällt – ohne die beiden .catch stünde dafür jedes Mal ein
  // unbehandelter Fehler in der Konsole und würde echte Fehler zudecken.
  // Beide braucht es: beim Abbruch lehnt `ready` ab, `finished` folgt.
  const uebergang = document.startViewTransition(() => renderNow());
  uebergang.ready.catch(() => {});
  uebergang.finished.catch(() => {});
}

// Merkt sich, welche Ansicht zuletzt gezeichnet wurde – nur wenn sie sich
// wirklich ändert (echte Navigation), soll nach oben gescrollt werden.
// Ohne das riss z. B. das Bestätigen einer Zahlung mitten in einer langen
// Liste den Nutzer zurück an den Seitenanfang, obwohl er in derselben
// Ansicht blieb: render() läuft nach praktisch jeder Änderung.
let lastRenderedViewKey = null;

function renderNow() {
  const current = view();

  // Verweist die Ansicht auf Gelöschtes, zurück auf die Übersicht.
  if ((current.name === 'group' && !groupById(current.id)) ||
      (current.name === 'manage' && !groupById(current.id)) ||
      (current.name === 'event' && !eventById(current.id))) {
    state.stack = [{ name: 'groups' }];
  }

  const now = view();
  const viewKey = `${now.name}:${now.id || ''}:${now.tab || ''}`;
  const isNavigation = viewKey !== lastRenderedViewKey;
  lastRenderedViewKey = viewKey;

  const html =
    now.name === 'group'   ? renderGroupView(groupById(now.id)) :
    now.name === 'manage'  ? renderManageView(groupById(now.id)) :
    now.name === 'event'   ? renderEventView(eventById(now.id)) :
    now.name === 'profile' ? renderProfileView() :
                             renderGroupsView();

  $('#view').innerHTML = html;
  $('#backBtn').hidden = state.stack.length < 2;
  $('#dial').hidden = now.name === 'profile' || now.name === 'manage';
  $('#manageGroupBtn').hidden = now.name !== 'group' || !canManageGroup(groupById(now.id));

  renderAvatarButton();
  renderDial();
  attachPasswordToggles();
  if (isNavigation) window.scrollTo(0, 0);
}

/* --------------------------- Passwort ein-/ausblenden --------------------- */

const EYE_SHOW = 'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z';
const EYE_HIDE = 'M4 4l16 16M10.6 6.2A9.8 9.8 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.4 4M6.5 8.1A17 17 0 0 0 2 12s3.6 6.5 10 6.5c1.4 0 2.6-.3 3.7-.8';
const EYE_PUPIL = 'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z';

/**
 * Hängt an jedes Passwortfeld ein Auge zum Anschauen. Bewusst generisch
 * statt sechsmal ins Markup geschrieben – so bekommen auch die erst beim
 * Rendern entstehenden Felder in der Profilansicht den Knopf.
 */
function attachPasswordToggles(root = document) {
  root.querySelectorAll('input[type="password"]').forEach((input) => {
    const field = input.closest('.field');
    if (!field || field.querySelector('.pw-toggle')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle';
    btn.setAttribute('aria-label', 'Passwort anzeigen');
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${EYE_SHOW}"/><path d="${EYE_PUPIL}"/></svg>`;
    field.appendChild(btn);
  });
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.pw-toggle');
  if (!btn) return;

  const input = btn.closest('.field')?.querySelector('input');
  if (!input) return;

  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.setAttribute('aria-pressed', String(show));
  btn.setAttribute('aria-label', show ? 'Passwort verbergen' : 'Passwort anzeigen');
  btn.innerHTML = show
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${EYE_HIDE}"/></svg>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${EYE_SHOW}"/><path d="${EYE_PUPIL}"/></svg>`;

  // Cursor ans Ende, sonst springt er beim Umschalten an den Anfang.
  const end = input.value.length;
  input.focus();
  input.setSelectionRange?.(end, end);
});

/* --- Ebene 1: alle Gruppen ---------------------------------------------- */

/**
 * Ein Gesamtsaldo über alle Gruppen hinweg klingt sinnvoll, ist es aber
 * praktisch kaum: Er addiert Schulden aus völlig unabhängigen Freundeskreisen
 * zu einer Zahl, die für sich genommen nichts Umsetzbares aussagt. Interessant
 * wird der Saldo erst innerhalb einer Gruppe (siehe balanceCard dort). Vorne
 * stehen deshalb nur die Gruppen selbst und was einen persönlich betrifft.
 */
function renderGroupsView() {
  $('#appbarTitle').textContent = 'FreundeTracker';

  /* ===== Gruppenliste (überarbeitet 2026-08-07) ==========================
     Drei Dinge machten die Liste unruhiger als nötig:

     1. Ausgeglichene Gruppen zeigten „0,00 € – bekommst du". Das ist weder
        eine Information noch stimmt es sprachlich; bei mehreren Gruppen war
        die halbe Liste voll grüner Nullen.
     2. Schulden standen doppelt da: „-12,00 €" UND „schuldest du". Das
        Minuszeichen ist überflüssig, sobald daneben steht, in welche
        Richtung es geht.
     3. Die Reihenfolge sagte nichts. Wer die App öffnet, sucht die Gruppe,
        in der noch etwas offen ist – nicht die, die zufällig zuerst
        angelegt wurde.

     Innerhalb „offen" und „ausgeglichen" bleibt die gewohnte Reihenfolge
     erhalten: Gruppen sollen nicht bei jeder Zahlung quer durch die Liste
     springen, sonst greift man ständig daneben.

     Rückgängig machen: Sicherungskopien liegen unter .rueckgaengig/.
     ====================================================================== */
  const AUSGEGLICHEN = 0.005;

  // Archivierte Gruppen fließen nicht in die normale Liste – dafür gibt es
  // die eingeklappte Zeile ganz unten (siehe archivedSection()).
  const aktiveGruppen = state.data.groups.filter((g) => !g.archived);
  const archivGruppen = state.data.groups.filter((g) => g.archived);

  const nachDringlichkeit = aktiveGruppen
    .map((group, position) => ({ group, position, balance: balanceOf(group.id) }))
    .sort((a, b) => {
      const aOffen = Math.abs(a.balance) > AUSGEGLICHEN;
      const bOffen = Math.abs(b.balance) > AUSGEGLICHEN;
      if (aOffen !== bOffen) return aOffen ? -1 : 1;
      return a.position - b.position;
    });

  const groups = nachDringlichkeit.map(({ group, balance }) => {
    const offen = Math.abs(balance) > AUSGEGLICHEN;
    return `
      <li><button class="row" type="button" data-goto-group="${group.id}">
        <span class="avatar">${mediaAvatar(group.avatar, group.name)}</span>
        <span class="row-body">
          <span class="row-title">${esc(group.name)}</span>
          <span class="row-sub">${plural(group.members.length, 'Person', 'Personen')} · ${plural(eventsOf(group.id).length, 'Anlass', 'Anlässe')}</span>
        </span>
        <span class="row-meta">
          ${offen ? `
            <span class="row-amount ${balanceClass(balance)}">${euro(Math.abs(balance))}</span>
            <span class="row-note">${balance > 0 ? 'bekommst du' : 'schuldest du'}</span>`
          : '<span class="row-settled">ausgeglichen</span>'}
        </span>
      </button></li>`;
  }).join('');

  const archivGruppenRow = (group) => `
    <li><button class="row" type="button" data-goto-group="${group.id}">
      <span class="avatar">${mediaAvatar(group.avatar, group.name)}</span>
      <span class="row-body">
        <span class="row-title">${esc(group.name)}</span>
        <span class="row-sub">${plural(group.members.length, 'Person', 'Personen')}</span>
      </span>
      <span class="row-chevron">${icon('M9 5l7 7-7 7')}</span>
    </button></li>`;

  const feed = activityFeed().slice(0, 5);

  // Leerer Hinweistext nur, wenn es WIRKLICH keine Gruppe gibt – ist alles
  // archiviert, steht die eingeklappte Zeile ja schon da und sagt genug.
  const gruppenBlock = `
    <section class="block">
      <div class="block-head"><h2>Deine Gruppen</h2><span class="count">${aktiveGruppen.length}</span></div>
      ${aktiveGruppen.length > 0
        ? `<ul class="list">${groups}</ul>`
        : (archivGruppen.length ? '' : '<p class="empty">Noch keine Gruppen. Leg mit „+“ deine erste an.</p>')}
      ${archivedSection(archivGruppen, archivGruppenRow, 'archivierte Gruppe', 'archivierte Gruppen')}
    </section>`;

  // Gemeldete Zahlungen ganz nach oben: das ist das Einzige auf dieser Seite,
  // wo jemand anderes auf eine Reaktion von mir wartet. Alles andere kann man
  // ansehen, wann man will.
  return pendingSection()
    + gruppenBlock
    + openPaymentsSection()
    + block('Letzte Aktivität', feed.length, feed.map((i) => activityRow(i)).join(''), 'Noch nichts erfasst.');
}

/* --- Ebene 2: eine Gruppe mit ihren Anlässen ----------------------------- */

function renderGroupView(group) {
  $('#appbarTitle').textContent = group.name;

  // Steht bewusst am ENDE der Übersicht: Wer die Gruppe öffnet, will Saldo,
  // offene Rückzahlungen und Aktivität sehen – die Namensliste ändert sich
  // fast nie und drängte sich oben nur dazwischen.
  const members = `
    <section class="block members-block">
      <div class="block-head"><h2>Mitglieder</h2><span class="count">${group.members.length}</span></div>
      <div class="members">
        ${group.members.map((m) => `<span class="chip">${esc(m)}</span>`).join('')}
      </div>
    </section>`;

  // Archivierte Anlässe (abgeschlossene Reiseabschnitte o. Ä.) landen nicht
  // in der normalen Liste – gleiche eingeklappte Zeile wie bei den Gruppen.
  const aktiveEvents = eventsOf(group.id).filter((e) => !e.archived);
  const archivEvents = eventsOf(group.id).filter((e) => e.archived);

  const eventRow = (event) => {
    const expenses = expensesOf(event.id);
    return `
      <li><button class="row" type="button" data-goto-event="${event.id}">
        <span class="row-body">
          <span class="row-title">${esc(event.name)}</span>
          <span class="row-sub">${plural(expenses.length, 'Ausgabe', 'Ausgaben')}</span>
        </span>
        <span class="row-meta">
          <span class="row-amount">${euro(sumOf(expenses))}</span>
          <span class="row-note">gesamt</span>
        </span>
        <span class="row-chevron">${icon('M9 5l7 7-7 7')}</span>
      </button></li>`;
  };
  const events = aktiveEvents.map(eventRow).join('');

  const feed = activityFeed(group.id).slice(0, 6);
  const expenses = expensesOfGroup(group.id);
  const tab = view().tab || 'overview';

  // Statt sieben Abschnitten untereinander: vier Reiter mit je einem Thema.
  const content =
    tab === 'events'  ? block('Anlässe', aktiveEvents.length, events,
                          archivEvents.length ? '' : 'Noch keine Anlässe – z. B. „Urlaub China“.')
                        + archivedSection(archivEvents, eventRow, 'archivierter Anlass', 'archivierte Anlässe')
                        + giftSection(group.id)
  : tab === 'balance' ? (expenses.length
                          ? memberBalanceSection(group.id)
                          : `<p class="empty">Noch keine Ausgaben – es gibt nichts auszugleichen.</p>`)
  : tab === 'stats'   ? statsSection(group)
  :                     (expenses.length ? groupSettleSection(group.id) : '')
                        + block('Letzte Aktivität', feed.length, feed.map((i) => activityRow(i)).join(''), 'Noch nichts erfasst.')
                        + members;

  return balanceCard(balanceOf(group.id), `Dein Saldo in „${group.name}“`)
    + tabBar(tab)
    + content;
}

const GROUP_TABS = [
  { key: 'overview', label: 'Übersicht' },
  { key: 'events',   label: 'Anlässe' },
  { key: 'balance',  label: 'Kontostand' },
  { key: 'stats',    label: 'Statistik' }
];

function tabBar(active) {
  return `
    <div class="tabs" role="tablist">
      ${GROUP_TABS.map((t) => `
        <button class="tab" type="button" role="tab" data-tab="${t.key}"
                aria-selected="${t.key === active}">${t.label}</button>`).join('')}
    </div>`;
}

/* --- Gruppe verwalten: Bild, Name, Mitglieder, Löschen ------------------- */

/** Rückmeldung über der Verwalten-Ansicht, wird nach dem Rendern geleert. */
let manageNotice = null;

/** Einladungslink, solange man in der Verwaltung dieser einen Gruppe ist. */
let activeInvite = null;

/** Erzeugt (oder erneuert) den Einladungslink dieser Gruppe. */
async function createGroupInvite(groupId) {
  try {
    const { token } = await Store.createInvite(groupId);
    activeInvite = { groupId, link: `${location.origin}/?join=${token}` };
  } catch (error) {
    manageNotice = { text: error.message, type: 'error' };
  }
  render();
}

/** Passwort-Reset-Link, solange das Mitglied-Formular offen ist. */
let activeResetLink = null;

/** Rückmeldung im Rechte-Abschnitt des Mitglied-Formulars. */
let memberAdminNotice = null;

/**
 * Erzeugt einen Passwort-Reset-Link für ein Mitglied mit eigenem Konto.
 * Kein Mailserver im Projekt – deshalb derselbe Weg wie eine Einladung:
 * der Admin schickt den Link demjenigen persönlich (siehe reset.js).
 */
async function createMemberResetLink(groupId, name) {
  try {
    const { token } = await Store.createResetLink(groupId, name);
    activeResetLink = { groupId, name, link: `${location.origin}/?resetToken=${token}` };
    memberAdminNotice = null;
  } catch (error) {
    memberAdminNotice = { text: error.message, type: 'error' };
  }
  fillMemberAdminBlock();
}

/**
 * Rechte-Abschnitt im Mitglied-Formular: Admin geben/nehmen und
 * Passwort-Link.
 *
 * Sitzt bewusst HIER beim einzelnen Mitglied und nicht mehr als Knopfreihe
 * unter der Zeile in der Mitgliederliste: dort standen bei mehreren
 * Mitgliedern gleich aussehende Knöpfe untereinander, und welcher wen meint,
 * war nur an der Einrückung zu erraten. Im Formular steht der Name oben – die
 * Zuordnung ist damit eindeutig, und die Liste bleibt eine ruhige Liste.
 */
function memberAdminBlockHtml(group, name) {
  if (!group || !isGroupAdmin(group) || name === me()) return '';

  // `group.linked` kommt vom Server (group_members.user_id IS NOT NULL).
  // NICHT über `linkedContacts` prüfen – das listet nur Mitglieder, die
  // zusätzlich eine IBAN/PayPal hinterlegt haben (Fehler von 2026-08-09).
  if (!group.linked?.includes(name)) {
    return `<p class="hint">${esc(name)} hat noch kein eigenes Konto.
            Mit einem Einladungslink kann ${esc(name)} eines anlegen – danach
            sind hier Adminrechte und Passwort-Link möglich.</p>`;
  }

  const istAdmin = isGroupAdmin(group, name);

  const notice = memberAdminNotice
    ? `<p class="${memberAdminNotice.type === 'error' ? 'error' : 'hint'}">${esc(memberAdminNotice.text)}</p>`
    : '';

  const link = activeResetLink && activeResetLink.name === name && activeResetLink.groupId === group.id
    ? `<div class="member-reset-link">
         <p class="hint">Persönlich schicken – gilt eine Stunde, einmalig:</p>
         <div class="pay-line">
           <span class="pay-line-value">${esc(activeResetLink.link)}</span>
           <button class="btn btn-ghost pay-copy" type="button" data-copy="${esc(activeResetLink.link)}">Kopieren</button>
         </div>
       </div>`
    : '';

  return `
    <h3 class="member-admin-title">Rechte &amp; Zugang</h3>
    ${notice}
    <div class="member-admin-actions">
      <button class="member-role" type="button"
              data-set-admin="${esc(name)}" data-admin-value="${istAdmin ? '0' : '1'}">
        ${istAdmin ? 'Admin entziehen' : 'Zum Admin machen'}
      </button>
      <button class="member-role" type="button" data-create-reset-link="${esc(name)}">
        Passwort-Link
      </button>
    </div>
    <p class="hint">${istAdmin
      ? `${esc(name)} kann Mitglieder verwalten, einladen und den Änderungsverlauf sehen.`
      : 'Der Passwort-Link hilft, wenn sich jemand nicht mehr anmelden kann.'}</p>
    ${link}`;
}

/** Schreibt den Rechte-Abschnitt in das offene Mitglied-Formular. */
function fillMemberAdminBlock() {
  const box = $('#memberAdminBlock');
  if (!box) return;

  const html = editing?.type === 'member'
    ? memberAdminBlockHtml(groupById(editing.groupId), editing.name)
    : '';

  box.innerHTML = html;
  box.hidden = !html;
}

/** Änderungsverlauf, solange man in der Verwaltung dieser einen Gruppe ist. */
let activeAuditLog = null;

/** Lädt den Änderungsverlauf einer Gruppe (nur Admins, siehe db.js getAuditLog). */
async function loadAuditLog(groupId) {
  try {
    const entries = await Store.getAuditLog(groupId);
    activeAuditLog = { groupId, entries };
  } catch (error) {
    manageNotice = { text: error.message, type: 'error' };
  }
  render();
}

/**
 * Verlässt eine Gruppe freiwillig – anders als Löschen bleibt die Gruppe für
 * alle anderen Mitglieder samt Historie erhalten (siehe db.js leaveGroup).
 */
async function leaveCurrentGroup(groupId) {
  let result;
  try {
    result = await Store.leaveGroup(groupId);
  } catch (error) {
    manageNotice = { text: error.message, type: 'error' };
    return render();
  }
  const gruppenname = groupById(groupId)?.name || 'der Gruppe';
  deleteGroup(groupId);   // nur lokal: aus dem eigenen Datenstand entfernen
  go({ name: 'groups' });

  // Erst NACH go(): die Übersicht muss stehen, sonst verblasst die Meldung
  // mit dem Ansichtswechsel-Effekt gleich wieder mit.
  if (result?.neuerAdmin) {
    showToast(`Du warst der letzte Admin von „${gruppenname}" – die Rechte gehen an ${result.neuerAdmin}.`);
  }
}

function renderManageView(group) {
  $('#appbarTitle').textContent = 'Gruppe verwalten';

  if (!canManageGroup(group)) {
    return `<p class="empty">Nur Mitglieder dieser Gruppe können sie verwalten.</p>`;
  }

  const notice = manageNotice
    ? `<p class="notice ${manageNotice.type === 'error' ? 'is-error' : 'is-ok'}">${esc(manageNotice.text)}</p>`
    : '';
  manageNotice = null;

  const isCreator = isGroupAdmin(group);

  const balances = memberBalances(group.id);
  const memberRows = group.members.map((name) => {
    const balance = balances.find((b) => b.name === name)?.balance || 0;
    const isGroupCreator = isGroupAdmin(group, name);
    const note = Math.abs(balance) > 0.005
      ? (balance > 0 ? `bekommt ${euro(balance)}` : `schuldet ${euro(-balance)}`)
      : 'ausgeglichen';

    // Ohne Admin-Rechte ist die Zeile reine Anzeige: ein Knopf, der beim
    // Speichern ohnehin verworfen würde, wäre nur eine Einladung zum Ärger.
    const kennzeichen = isGroupCreator ? ' <span class="member-tag">Admin</span>' : '';

    // Adminrechte und Passwort-Link stehen bewusst NICHT mehr hier, sondern
    // im Formular hinter der Zeile (memberAdminBlockHtml): mehrere identisch
    // beschriftete Knöpfe untereinander ließen nicht erkennen, wen sie meinen.
    return isCreator
      ? `<li class="member-item">
          <button class="row" type="button" data-edit-member="${esc(name)}">
            <span class="avatar">${mediaAvatar(null, name)}</span>
            <span class="row-body">
              <span class="row-title">${esc(name)}${kennzeichen}</span>
              <span class="row-sub">${note}</span>
            </span>
            <span class="row-chevron">${icon('M9 5l7 7-7 7')}</span>
          </button>
        </li>`
      : `<li><div class="row row-static">
          <span class="avatar">${mediaAvatar(null, name)}</span>
          <span class="row-body">
            <span class="row-title">${esc(name)}${kennzeichen}</span>
            <span class="row-sub">${note}</span>
          </span>
        </div></li>`;
  }).join('');

  const invite = activeInvite && activeInvite.groupId === group.id
    ? `<p class="hint">Diesen Link teilen – wer ihn öffnet, kann nach Anmeldung beitreten:</p>
       <div class="pay-line">
         <span class="pay-line-value">${esc(activeInvite.link)}</span>
         <button class="btn btn-ghost pay-copy" type="button" data-copy="${esc(activeInvite.link)}">Kopieren</button>
       </div>`
    : '';

  // Änderungsverlauf: bewusst erst auf Klick geladen (nicht bei jedem
  // Rendern der Verwalten-Ansicht) – ein Admin, der nur mal schnell den
  // Namen ändern will, braucht diese Liste selten und sie soll die Ansicht
  // nicht mit vorab geladenen Einträgen überladen.
  const auditFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const audit = activeAuditLog && activeAuditLog.groupId === group.id
    ? (activeAuditLog.entries.length
        ? `<ul class="list audit-list">${activeAuditLog.entries.map((e) => `
             <li class="audit-item">
               <span class="audit-when">${auditFmt.format(new Date(e.createdAt))}</span>
               <span class="audit-what"><strong>${esc(e.actorName)}</strong> – ${esc(e.action)}</span>
             </li>`).join('')}</ul>`
        : `<p class="hint">Noch keine Einträge.</p>`)
    : '';

  return `
    ${notice}

    <section class="profile-head">
      <div class="profile-avatar">${mediaAvatar(group.avatar, group.name)}</div>
      <div class="profile-identity">
        <strong>${esc(group.name)}</strong>
        <span>${plural(group.members.length, 'Mitglied', 'Mitglieder')}</span>
      </div>
    </section>

    <div class="profile-avatar-actions">
      <button class="btn btn-ghost" type="button" data-group-avatar="pick">
        ${group.avatar ? 'Bild ändern' : 'Bild auswählen'}
      </button>
      ${group.avatar ? `<button class="btn btn-ghost" type="button" data-group-avatar="remove">Entfernen</button>` : ''}
    </div>

    <section class="block">
      <div class="block-head"><h2>Name</h2></div>
      <form id="groupNameForm" class="card">
        <label class="field">
          <span>Gruppenname</span>
          <input type="text" name="name" value="${esc(group.name)}" autocomplete="off">
        </label>
        <button class="btn btn-primary btn-block" type="submit">Namen speichern</button>
      </form>
    </section>

    <section class="block">
      <button class="btn btn-ghost btn-block" type="button" data-toggle-group-archive="${group.id}">
        ${group.archived ? 'Aus dem Archiv holen' : 'Gruppe archivieren'}
      </button>
      <p class="hint">
        ${group.archived
          ? 'Diese Gruppe ist archiviert – sie erscheint nicht in deiner Übersicht, aber alles bleibt erhalten.'
          : 'Verschwindet danach aus der Übersicht, bleibt aber vollständig erhalten – jederzeit rückgängig zu machen.'}
      </p>
    </section>

    <section class="block">
      <div class="block-head">
        <h2>Mitglieder</h2>
        <span class="count">${group.members.length}</span>
      </div>
      <ul class="list">${memberRows}</ul>
      ${isCreator
        ? '<button class="btn btn-ghost btn-block" type="button" data-add-member>Mitglied hinzufügen</button>'
        : `<p class="hint">Mitglieder verwaltet ${esc(group.createdBy || 'der Admin')}.</p>`}
    </section>

    ${isCreator ? `
      <section class="block">
        <div class="block-head"><h2>Einladen</h2></div>
        <div class="card">
          <button class="btn btn-ghost btn-block" type="button" data-share-invite="${group.id}">
            Einladungslink erzeugen
          </button>
          ${invite}
        </div>
      </section>` : ''}

    ${isCreator ? `
      <section class="block">
        <div class="block-head"><h2>Änderungsverlauf</h2></div>
        <div class="card">
          <button class="btn btn-ghost btn-block" type="button" data-show-audit="${group.id}">
            Verlauf anzeigen
          </button>
          ${audit}
        </div>
      </section>` : ''}

    ${isCreator
      ? deleteSection('group', group.id)
      : `<button class="btn btn-danger btn-block" type="button" data-leave-group="${group.id}">
           Gruppe verlassen
         </button>`}`;
}

/* --- Reiter „Statistik" -------------------------------------------------- */

function statsSection(group) {
  const facts = groupFacts(group.id);
  if (!facts) {
    return `<p class="empty">Noch keine Ausgaben – sobald etwas erfasst ist, gibt es hier Zahlen.</p>`;
  }

  const tiles = [
    ['Gesamt ausgegeben', euro(facts.total)],
    ['Pro Person',        euro(facts.perPerson)],
    ['Ausgaben',          String(facts.count)],
    ['Ø je Ausgabe',      euro(facts.average)]
  ].map(([label, value]) => `
    <div class="tile">
      <span class="tile-label">${label}</span>
      <strong class="tile-value">${value}</strong>
    </div>`).join('');

  const paid = paidByMember(group.id);
  const months = spendingByMonth(group.id);

  const highlights = [
    ['Größte Einzelausgabe', `${esc(facts.biggest.title)} · ${euro(facts.biggest.amount)}`],
    facts.topEvent ? ['Teuerster Anlass', `${esc(facts.topEvent.name)} · ${euro(facts.topEvent.sum)}`] : null,
    paid.length ? ['Meiste Ausgaben', `${esc(paid[0].name)} · ${euro(paid[0].paid)}`] : null
  ].filter(Boolean).map(([label, value]) => `
    <div class="fact">
      <span class="fact-label">${label}</span>
      <span class="fact-value">${value}</span>
    </div>`).join('');

  return `
    <section class="tiles">${tiles}</section>

    <section class="block">
      <div class="block-head"><h2>Wer hat ausgegeben</h2></div>
      ${barList(paid.map((m) => ({
        label: m.name === me() ? `${m.name} (du)` : m.name,
        value: m.paid,
        share: m.share,
        note: `${Math.round(m.share * 100)} % aller Ausgaben`
      })))}
    </section>

    ${categoryBars(expensesOfGroup(group.id), 'Wofür das Geld ging')}

    <section class="block">
      <div class="block-head"><h2>Nach Monat</h2></div>
      ${barList(months.map((m) => ({
        label: m.label,
        value: m.sum,
        share: m.share,
        note: `${Math.round(m.share * 100)} % der Gesamtsumme`
      })))}
    </section>

    <section class="block">
      <div class="block-head"><h2>Spitzenreiter</h2></div>
      <div class="card facts">${highlights}</div>
    </section>`;
}

/* --- Ebene 3: ein Anlass, nach Kategorien gegliedert --------------------- */

function renderEventView(event) {
  const group = groupById(event.groupId);
  $('#appbarTitle').textContent = event.name;

  const expenses = expensesOf(event.id);
  const total = sumOf(expenses);
  const myShare = expenses.reduce((sum, e) => sum + shareOf(e, me()), 0);

  const dateRange = eventDateRange(event);

  // Der Anlass-Name ist die eigentliche Frage („was ist das hier überhaupt“) –
  // deshalb steht er groß als Titel, nicht klein als Beschriftung über der Summe.
  // Der Stift ist klein und ruhig gehalten: nur wer wirklich etwas ändern
  // will (Name, Zeitraum), stolpert überhaupt darüber.
  const head = `
    <section class="event-hero">
      <span class="event-hero-group">${esc(group ? group.name : 'Ohne Gruppe')}</span>
      <div class="event-hero-title-row">
        <h2 class="event-hero-title">${esc(event.name)}</h2>
        <button class="icon-btn event-edit-btn" type="button" data-edit-event="${event.id}" aria-label="Anlass bearbeiten">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
      </div>
      ${dateRange ? `<span class="event-hero-dates">${esc(dateRange)}</span>` : ''}
    </section>

    <section>
      <div class="tiles">
        <div class="tile">
          <span class="tile-label">Gesamt</span>
          <strong class="tile-value">${euro(total)}</strong>
        </div>
        <div class="tile">
          <span class="tile-label">Dein Anteil</span>
          <strong class="tile-value">${euro(myShare)}</strong>
        </div>
      </div>
      <p class="event-hero-note">${plural(expenses.length, 'Ausgabe', 'Ausgaben')}</p>
    </section>`;

  // Gleiche Idee wie bei Gruppen: ein ruhiger Ghost-Knopf statt eines
  // weiteren Menüpunkts, direkt über der Löschen-Zeile, wo man ohnehin
  // hinschaut, wenn ein Anlass fertig ist.
  const archiveToggle = `
    <button class="btn btn-ghost btn-block" type="button" data-toggle-event-archive="${event.id}">
      ${event.archived ? 'Aus dem Archiv holen' : 'Anlass archivieren'}
    </button>`;

  if (expenses.length === 0) {
    return head
      + `<p class="empty">Noch keine Ausgaben für diesen Anlass.</p>`
      + archiveToggle
      + deleteSection('event', event.id);
  }

  return head
    + searchField()
    + `<div id="expenseResults">${expenseResults(expenses)}</div>`
    + archiveToggle
    + deleteSection('event', event.id);
}

/**
 * Der beim Suchen austauschbare Teil: Trefferzeile, Balken, Ausgabenliste.
 *
 * Bewusst getrennt vom Suchfeld: Würde bei jedem Tastendruck die ganze
 * Ansicht neu gebaut, entstünde das Eingabefeld jedes Mal neu. Fokus und
 * Cursor ließen sich zwar zurücksetzen, aber Umlaute über Tot-Tasten und die
 * Wortvorschläge der Android-Tastatur brechen dabei ab – man kann dann nicht
 * mehr flüssig tippen. Bleibt das Feld unangetastet und wird nur dieser
 * Block ersetzt, gibt es das Problem gar nicht erst.
 */
function expenseResults(expenses) {
  const gefiltert = filterExpenses(expenses, expenseFilter);

  const treffer = expenseFilter
    ? `<p class="search-count">${gefiltert.length === 0
        ? 'Nichts gefunden'
        : `${gefiltert.length} von ${expenses.length} · zusammen ${euro(sumOf(gefiltert))}`}</p>`
    : '';

  // Nur Kategorien anzeigen, in denen tatsächlich etwas gebucht wurde.
  const sections = Object.keys(CATEGORIES).map((key) => {
    const items = gefiltert.filter((e) => e.category === key)
      .sort((a, b) => b.date.localeCompare(a.date));
    if (items.length === 0) return '';

    const category = CATEGORIES[key];
    return `
      <section class="block">
        <div class="block-head">
          <span class="cat-icon">${icon(category.icon)}</span>
          <h2>${category.label}</h2>
          <span class="count">${euro(sumOf(items))}</span>
        </div>
        <ul class="list">
          ${items.map((e) => {
            const participants = participantsOf(e);
            const group = groupOfExpense(e);
            const split = group && participants.length === group.members.length
              ? 'alle'
              : participants.map((p) => (p === me() ? 'du' : p)).join(', ');

            return `
            <li><button class="row" type="button" data-edit-expense="${e.id}">
              <span class="row-body">
                <span class="row-title">${esc(e.title)}${e.receiptId ? receiptTag() : ''}</span>
                <span class="row-sub">${e.giftFor ? `Für ${esc(e.giftFor)} · ` : ''}${esc(e.payer === me() ? 'Du hast' : e.payer + ' hat')} bezahlt · geteilt durch ${esc(split)}</span>
              </span>
              <span class="row-meta">
                <span class="row-amount">${euro(e.amount)}</span>
                <span class="row-note">${isEqualSplit(e)
                  ? `je ${euro(e.amount / participants.length)}`
                  : `dein Anteil ${euro(shareOf(e, me()))}`}</span>
              </span>
              <span class="row-chevron">${icon('M9 5l7 7-7 7')}</span>
            </button></li>`;
          }).join('')}
        </ul>
      </section>`;
  }).join('');

  // Beim Suchen zeigen die Balken, was gerade gefunden wurde – sonst stünde
  // eine Auswertung über Ausgaben da, die man gar nicht sieht.
  return treffer + categoryBars(gefiltert) + sections;
}

/* ------------------------------ Suche ------------------------------------
   Bewusst ein einziges Feld statt Suchfeld + mehrere Auswahlmenüs: Wer etwas
   sucht, tippt „Anna" oder „Taxi" oder „12,50" – und meint damit jeweils
   etwas anderes. Ein Feld, das über Titel, Person, Kategorie und Betrag
   gleichzeitig sucht, trifft das besser als drei Bedienelemente, die man
   erst richtig kombinieren muss. Mehrere Wörter werden UND-verknüpft, damit
   sich „anna taxi" sinnvoll einengen lässt.
   ------------------------------------------------------------------------ */

let expenseFilter = '';

function searchField() {
  return `
    <div class="search-wrap">
      <span class="search-icon">${icon('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4')}</span>
      <input class="search-input" type="search" id="expenseSearch"
             value="${esc(expenseFilter)}" placeholder="Suchen: Bezeichnung, Person, Betrag …"
             autocomplete="off" spellcheck="false" enterkeyhint="search">
      <button class="search-clear" type="button" id="expenseSearchClear"
              aria-label="Suche leeren" ${expenseFilter ? '' : 'hidden'}>×</button>
    </div>`;
}

/** Passt die Ausgabe zu ALLEN eingegebenen Wörtern? */
function filterExpenses(expenses, suchtext) {
  const woerter = String(suchtext || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (woerter.length === 0) return expenses;

  return expenses.filter((e) => {
    // Betrag in beiden Schreibweisen durchsuchbar machen: getippt wird mal
    // "12,50" und mal "12.50", gespeichert ist es eine Zahl.
    const betrag = Number(e.amount).toFixed(2);
    // Teilnehmer bewusst NICHT durchsuchen: Im Normalfall sind alle an allem
    // beteiligt – ein Name würde dann schlicht jede Ausgabe finden und die
    // Personensuche wäre wertlos. Wer nach „Anna" sucht, meint „was hat Anna
    // bezahlt", und genau das liefert der Zahler.
    const heuhaufen = [
      e.title,
      e.payer,
      e.giftFor || '',
      categoryOf(e.category).label,
      betrag,
      betrag.replace('.', ',')
    ].join(' ').toLowerCase();

    return woerter.every((w) => heuhaufen.includes(w));
  });
}

/* ------------------------------- Navigation ------------------------------ */

function go(next) {
  // Zur Wurzel zurück heißt: Verlauf zurücksetzen. Fühlt sich wie „zurück" an,
  // auch wenn es technisch ein go() ist (z. B. nach dem Löschen einer Gruppe).
  pendingNavDirection = next.name === 'groups' ? 'back' : 'forward';

  if (next.name === 'groups') state.stack = [{ name: 'groups' }];
  else state.stack.push(next);

  pendingDelete = null;
  // Eine Suche gilt nur für den Anlass, in dem sie eingetippt wurde. Bliebe
  // sie stehen, wirkte der nächste Anlass grundlos halbleer.
  expenseFilter = '';
  closeDial();
  render();
}

function goBack() {
  pendingNavDirection = 'back';
  if (state.stack.length > 1) state.stack.pop();
  pendingDelete = null;
  // Eine Suche gilt nur für den Anlass, in dem sie eingetippt wurde. Bliebe
  // sie stehen, wirkte der nächste Anlass grundlos halbleer.
  expenseFilter = '';
  closeDial();
  render();
}

/** Die Gruppe, in deren Kontext gerade gearbeitet wird (null in der Übersicht). */
function currentGroup() {
  const now = view();
  if (now.name === 'group' || now.name === 'manage') return groupById(now.id);
  if (now.name === 'event') {
    const event = eventById(now.id);
    return event ? groupById(event.groupId) : null;
  }
  return null;
}

/* -------------------------------- Speed-Dial ----------------------------- */

/** Angebotene Aktionen hängen davon ab, wo man gerade ist. */
const DIAL_ACTIONS = {
  expense: { title: 'Neue Ausgabe', sub: 'Jemand hat etwas eingekauft',     icon: CATEGORIES.shopping.icon },
  gift:    { title: 'Neues Geschenk', sub: 'Der Beschenkte zahlt nicht mit', icon: CATEGORIES.gift.icon },
  event:   { title: 'Neuer Anlass', sub: 'Reise, Wochenende, Monat …',      icon: 'M8 3v4M16 3v4M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z' },
  payment: { title: 'Neue Zahlung', sub: 'Jemand hat Geld erhalten',        icon: 'M4 12h15M13 6l6 6-6 6' },
  person:  { title: 'Neue Person',  sub: 'Jemand, der sich beteiligt',      icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 20a7 7 0 0 1 14 0' },
  group:   { title: 'Neue Gruppe',  sub: 'Freunde, die zusammen abrechnen', icon: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 19a6 6 0 0 1 12 0M17 8.5a2.5 2.5 0 1 0 0-5M19 19a5 5 0 0 0-3-4.6' }
};

const DIAL_BY_VIEW = {
  groups:  ['group'],
  group:   ['expense', 'gift', 'event', 'payment', 'person'],
  event:   ['expense', 'gift'],
  profile: [],
  manage:  []
};

function renderDial() {
  $('#dialItems').innerHTML = (DIAL_BY_VIEW[view().name] || []).map((key) => {
    const action = DIAL_ACTIONS[key];
    return `
      <li class="dial-item">
        <span class="dial-label">
          <span class="dial-label-title">${action.title}</span>
          <span class="dial-label-sub">${action.sub}</span>
        </span>
        <button class="dial-btn" type="button" data-action="${key}" aria-label="${action.title}">
          ${icon(action.icon)}
        </button>
      </li>`;
  }).join('');
}

let dialOpen = false;

function toggleDial() {
  dialOpen ? closeDial() : openDial();
}

/**
 * Blendet ein Element sanft aus (per CSS-Klasse + @keyframes), bevor es erst
 * danach „hidden" bekommt – sonst verschwindet es beim Schließen hart, obwohl
 * das Öffnen animiert war. Ohne Bewegungspräferenz oder ohne Animation auf dem
 * Element (z. B. bei reduced-motion) läuft „fertig" sofort durch.
 */
function animateOut(el, closingClass, done) {
  if (prefersReducedMotion()) { done(); return; }

  el.classList.add(closingClass);

  // finished-Flag, damit done() garantiert nur einmal läuft – egal ob
  // animationend zuerst feuert oder das Sicherheitsnetz (setTimeout) zuerst
  // greift (z. B. wenn die Animation aus irgendeinem Grund nie endet).
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    el.classList.remove(closingClass);
    done();
  };

  el.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 300);
}

/**
 * Kurze, von selbst verschwindende Meldung. Gedacht für Fälle, in denen die
 * Ansicht direkt danach wechselt (z. B. Gruppe verlassen → zurück zur
 * Übersicht) – ein normaler manageNotice/profileNotice-Hinweis wäre dort
 * schon weg, bevor man ihn lesen könnte, weil die Ansicht, in der er stünde,
 * gar nicht mehr da ist.
 */
let toastTimer = null;
function showToast(text) {
  const el = $('#toast');
  if (!el) return;

  clearTimeout(toastTimer);
  el.textContent = text;
  el.hidden = false;
  // Reflow erzwingen, bevor die Klasse gesetzt wird – sonst überspringt der
  // Browser den Übergang, weil "hidden -> sichtbar + Klasse" in einem
  // einzigen Zug passiert und nichts zum Überblenden bleibt.
  void el.offsetWidth;
  el.classList.add('is-visible');

  toastTimer = setTimeout(() => {
    el.classList.remove('is-visible');
    setTimeout(() => { el.hidden = true; }, prefersReducedMotion() ? 0 : 250);
  }, 4000);
}

/**
 * Kurzes Aufblitzen beim Antippen – die übliche native Tap-Rückmeldung.
 * Bewusst als EIN einziger, delegierter Klick-Listener auf `document`
 * (siehe unten) statt an jedem Knopf einzeln verdrahtet: greift dadurch
 * automatisch auch bei Knöpfen, die dynamisch entstehen (Payment-/Invite-/
 * Rechnungs-Sheet, Profilansicht, …), ohne dass jede Stelle im Code davon
 * wissen muss. `:active` allein reicht dafür nicht – bei einem kurzen Tipp
 * (statt Gedrückthalten) ist der Zustand oft schon wieder vorbei, bevor man
 * ihn bewusst wahrnimmt.
 */
function flashTap(el) {
  if (prefersReducedMotion() || !el || el.classList.contains('tap-flash')) return;
  el.classList.add('tap-flash');
  const clear = () => el.classList.remove('tap-flash');
  el.addEventListener('animationend', clear, { once: true });
  setTimeout(clear, 500);   // Sicherheitsnetz, falls animationend ausbleibt
}

document.addEventListener('click', (e) => {
  flashTap(e.target.closest('button'));
});

function openDial() {
  dialOpen = true;
  $('#dialItems').hidden = false;
  $('#dialScrim').hidden = false;
  $('#fab').setAttribute('aria-expanded', 'true');
  $('#fab').setAttribute('aria-label', 'Menü schließen');
}

function closeDial() {
  if (!dialOpen) return;
  dialOpen = false;
  $('#fab').setAttribute('aria-expanded', 'false');
  $('#fab').setAttribute('aria-label', 'Neuen Eintrag hinzufügen');

  animateOut($('#dialItems'), 'is-closing', () => { $('#dialItems').hidden = true; });
  animateOut($('#dialScrim'), 'is-closing', () => { $('#dialScrim').hidden = true; });
}

/* ------------------------------ Modal / Sheet ---------------------------- */

const sheet    = $('#sheet');
const backdrop = $('#backdrop');
const form     = $('#entryForm');

let entryType = 'expense';

/** Wird gerade ein bestehender Eintrag bearbeitet? Dann { type, id }. */
let editing = null;
let deleteArmed = false;      // zweiter Klick auf „Löschen" führt aus

const editedExpense = () =>
  editing?.type === 'expense' ? state.data.expenses.find((e) => e.id === editing.id) : null;

const editedPayment = () =>
  editing?.type === 'payment' ? state.data.payments.find((p) => p.id === editing.id) : null;

const SHEET_TITLES = {
  expense: 'Neue Ausgabe',
  gift:    'Neues Geschenk',
  payment: 'Neue Zahlung',
  event:   'Neuer Anlass',
  group:   'Neue Gruppe',
  person:  'Neue Person'
};

function openSheet(type) {
  editing = null;
  resetSheet();
  setEntryType(type);
  fillSelects();
  showSheet();
}

/** Öffnet dasselbe Formular, gefüllt mit einer bestehenden Ausgabe. */
function openExpenseEditor(expenseId) {
  const expense = state.data.expenses.find((e) => e.id === expenseId);
  if (!expense) return;

  const group = groupOfExpense(expense);
  const isGift = Boolean(expense.giftFor);
  editing = { type: 'expense', id: expenseId };

  resetSheet();
  setEntryType(isGift ? 'gift' : 'expense');
  // Die Gruppe kommt aus der Ausgabe selbst – so lässt sie sich auch aus der
  // Übersicht heraus bearbeiten, wo keine Gruppe „aktiv" ist.
  fillSelects(group);

  form.elements.title.value    = expense.title;
  form.elements.amount.value   = expense.amount;
  form.elements.eventId.value  = expense.eventId;
  form.elements.payer.value    = expense.payer;
  if (!isGift) form.elements.category.value = expense.category;

  // Hängt ein gescannter Beleg an der Ausgabe, lässt er sich hier ansehen.
  if (expense.receiptId) {
    $('#receiptIdField').value = expense.receiptId;
    showReceiptChip(expense.receiptId);
  }

  // Erst den Beschenkten setzen – das baut Zahler- und Teilnehmerliste neu auf,
  // die Häkchen dürfen also erst danach gesetzt werden.
  if (isGift) {
    form.elements.giftFor.value = expense.giftFor;
    applyGiftRecipient(group);
    form.elements.payer.value = expense.payer;
  }

  const participants = participantsOf(expense);
  $$('#participantList [data-participant]').forEach((chip) =>
    chip.setAttribute('aria-pressed', String(participants.includes(chip.dataset.participant))));

  // Ungleiche Aufteilung wieder aufklappen, wenn die Ausgabe eine hat.
  if (!isEqualSplit(expense)) {
    splitMode = expense.split.mode;
    $$('[data-split-mode]').forEach((btn) =>
      btn.setAttribute('aria-selected', String(btn.dataset.splitMode === splitMode)));
    toggleUnequal(true, expense.split.values);
  }

  $('#sheetTitle').textContent = isGift ? 'Geschenk bearbeiten' : 'Ausgabe bearbeiten';
  $('#deleteEntryBtn').textContent = isGift ? 'Geschenk löschen' : 'Ausgabe löschen';
  $('#deleteEntryBtn').hidden = false;
  updateSplitHint();
  showSheet();
}

/** Öffnet dasselbe Formular, gefüllt mit einer bestehenden Rückzahlung. */
function openPaymentEditor(paymentId) {
  const payment = state.data.payments.find((p) => p.id === paymentId);
  if (!payment) return;

  editing = { type: 'payment', id: paymentId };

  resetSheet();
  setEntryType('payment');
  // Gruppe aus der Zahlung selbst – so geht es auch aus der Übersicht heraus.
  fillSelects(groupById(payment.groupId));

  form.elements.from.value = payment.from;
  form.elements.to.value = payment.to;
  form.elements.payAmount.value = payment.amount;

  $('#sheetTitle').textContent = 'Zahlung bearbeiten';
  $('#deleteEntryBtn').hidden = false;
  $('#deleteEntryBtn').textContent = 'Zahlung löschen';
  showSheet();
}

/** Öffnet dasselbe Formular, gefüllt mit einem bestehenden Anlass. */
function openEventEditor(eventId) {
  const event = eventById(eventId);
  if (!event) return;

  editing = { type: 'event', id: eventId };

  resetSheet();
  setEntryType('event');

  form.elements.eventName.value = event.name;
  if (event.startDate) form.elements.eventStart.value = event.startDate;
  if (event.endDate)   form.elements.eventEnd.value   = event.endDate;
  // Zeitraum gesetzt: gleich aufgeklappt zeigen statt hinter einem Klick zu
  // verstecken, was schon eingetragen ist.
  if (event.startDate || event.endDate) {
    $('[data-fields="event"] .advanced-fields').open = true;
  }

  // Löschen bleibt bewusst am bestehenden Ort (unten auf der Anlass-Seite,
  // per Zwei-Schritt-Bestätigung) – keine zweite, abweichende Löschmöglichkeit
  // hier im Formular.
  $('#sheetTitle').textContent = 'Anlass bearbeiten';
  showSheet();
}

/**
 * Öffnet dasselbe Formular, gefüllt mit einem bestehenden Gruppenmitglied –
 * zum Umbenennen oder Entfernen. Wer sich selbst gerade ansieht, kann sich
 * nicht selbst entfernen (es gäbe niemanden, der die Gruppe dann verwaltet).
 */
function openMemberEditor(groupId, name) {
  const group = groupById(groupId);
  if (!group) return;

  editing = { type: 'member', groupId, name };

  resetSheet();
  setEntryType('person');
  fillSelects(group);

  form.elements.personName.value = name;

  const balance = memberBalances(groupId).find((b) => b.name === name)?.balance || 0;
  const note = $('#memberBalanceNote');
  note.textContent = Math.abs(balance) > 0.005
    ? (balance > 0 ? `Bekommt aktuell ${euro(balance)} – das verschwindet beim Entfernen aus der Übersicht.`
                   : `Schuldet aktuell ${euro(-balance)} – das verschwindet beim Entfernen aus der Übersicht.`)
    : 'Aktuell ausgeglichen.';
  note.hidden = false;

  // Adminrechte/Passwort-Link dieser einen Person – erst hier, wo der Name
  // oben im Formular steht und die Zuordnung damit eindeutig ist.
  fillMemberAdminBlock();

  const isSelf = name === me();
  $('#sheetTitle').textContent = 'Mitglied bearbeiten';
  $('#deleteEntryBtn').textContent = 'Mitglied entfernen';
  $('#deleteEntryBtn').dataset.armedLabel = 'Wirklich entfernen?';
  $('#deleteEntryBtn').hidden = isSelf || group.members.length <= 1;

  // Ohne Tastatur öffnen: Wer auf eine Person tippt, will meist nachsehen
  // oder Rechte ändern – nicht sofort den Namen tippen. Die aufspringende
  // Tastatur verdeckte am Handy prompt den halben Dialog.
  showSheet({ fokussieren: false });
}

function resetSheet() {
  form.reset();
  $('#formError').hidden = true;
  $('#scanResult').hidden = true;
  $('#receiptIdField').value = '';
  $('#viewReceiptBtn').hidden = true;
  $('#receiptThumb').hidden = true;
  $('#receiptThumb').removeAttribute('src');
  $('#memberBalanceNote').hidden = true;
  // Optionale Zugriffe: Hängt bei jemandem noch ein altes index.html im
  // Cache, während app.js schon neu ist, fehlt dieses Element. Ohne das `?.`
  // würde hier eine Ausnahme fliegen und die ganze App stünde – ein zu hoher
  // Preis für einen Abschnitt, der nur beim Bearbeiten eines Mitglieds zählt.
  const rechteBlock = $('#memberAdminBlock');
  if (rechteBlock) { rechteBlock.hidden = true; rechteBlock.innerHTML = ''; }
  // form.reset() setzt Eingabewerte zurück, aber nicht den Auf/Zu-Zustand
  // von <details> – ohne das bliebe „Erweiterte Einstellungen" bei einem
  // neuen Anlass offen, nur weil der vorige einen Zeitraum hatte.
  const advanced = $('[data-fields="event"] .advanced-fields');
  if (advanced) advanced.open = false;
  $('#deleteEntryBtn').hidden = true;
  $('#deleteEntryBtn').textContent = 'Ausgabe löschen';
  delete $('#deleteEntryBtn').dataset.armedLabel;
  deleteArmed = false;
  // Der Saldo-Hinweis gehört zum scharfgestellten Zustand – beim Zurücksetzen
  // muss er weg, sonst steht er beim nächsten Formular noch da.
  const loeschHinweis = $('#deleteEntryHint');
  if (loeschHinweis) { loeschHinweis.hidden = true; loeschHinweis.textContent = ''; }

  splitMode = 'amount';
  $$('[data-split-mode]').forEach((btn) =>
    btn.setAttribute('aria-selected', String(btn.dataset.splitMode === 'amount')));
  toggleUnequal(false);
}

function showSheet({ fokussieren = true } = {}) {
  sheet.hidden = false;
  backdrop.hidden = false;
  document.body.style.overflow = 'hidden';
  if (fokussieren) {
    sheet.querySelector('[data-fields]:not([hidden]) input, [data-fields]:not([hidden]) select')?.focus();
  }
}

function closeSheet() {
  if (sheet.hidden) return;

  // Ein erzeugter Passwort-Link gehört zu genau diesem Formular – beim
  // nächsten Öffnen soll nicht der Link der vorigen Person dastehen.
  activeResetLink = null;
  memberAdminNotice = null;

  animateOut(sheet, 'is-closing', () => {
    sheet.hidden = true;
    sheet.style.transform = '';        // Rest von einem Wisch-Zug aufräumen
    document.body.style.overflow = '';
  });
  animateOut(backdrop, 'is-closing', () => { backdrop.hidden = true; });
  $('#fab').focus();
}

/**
 * Macht ein Bottom-Sheet mit Runterwischen schließbar – die Griffleiste
 * (.sheet-grip) deutet das ja schon optisch an, bisher tat sie aber nichts.
 * Gezogen werden darf ab der Griffleiste oder der Kopfzeile (nicht ab dem
 * Schließen-Kreuz, sonst könnte ein Tipp versehentlich als Wisch zählen),
 * das Formular darunter bleibt normal scrollbar.
 */
function makeSheetDraggable(sheetEl, closeFn) {
  let startY = 0;
  let dy = 0;
  let dragging = false;
  let startedAt = 0;

  const isHandle = (target) =>
    !!target.closest('.sheet-grip') ||
    (!!target.closest('.sheet-head') && !target.closest('.icon-btn'));

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!isHandle(e.target)) return;

    dragging = true;
    startY = e.clientY;
    dy = 0;
    startedAt = Date.now();
    sheetEl.style.transition = 'none';
    sheetEl.setPointerCapture(e.pointerId);
  }

  function onMove(e) {
    if (!dragging) return;
    dy = Math.max(0, e.clientY - startY);   // nur nach unten ziehen lässt sich was
    sheetEl.style.transform = `translateY(${dy}px)`;
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    sheetEl.style.transition = '';

    const wischZuegig = dy > 40 && Date.now() - startedAt < 250;
    const weitGenugGezogen = dy > sheetEl.offsetHeight * 0.28;

    if (wischZuegig || weitGenugGezogen) {
      // is-closing übernimmt nahtlos ab der aktuellen Wisch-Position.
      closeFn();
    } else {
      sheetEl.style.transition = 'transform .2s cubic-bezier(.2, .9, .3, 1)';
      sheetEl.style.transform = '';
      setTimeout(() => { sheetEl.style.transition = ''; }, 220);
    }
  }

  sheetEl.addEventListener('pointerdown', onDown);
  sheetEl.addEventListener('pointermove', onMove);
  sheetEl.addEventListener('pointerup', onUp);
  sheetEl.addEventListener('pointercancel', onUp);
}

makeSheetDraggable(sheet, closeSheet);

function setEntryType(type) {
  entryType = type;

  // Ein Geschenk nutzt die Ausgabenfelder plus das Feld „Für wen".
  const shown = type === 'gift' ? 'expense' : type;
  $$('[data-fields]').forEach((box) => { box.hidden = box.dataset.fields !== shown; });

  const isGift = type === 'gift';
  $('#giftBlock').hidden = !isGift;
  $('#categoryBlock').hidden = isGift;     // Kategorie ist bei Geschenken gesetzt

  $('#sheetTitle').textContent = SHEET_TITLES[type];
  $('#formError').hidden = true;
}

/** Füllt alle Auswahlfelder passend zur übergebenen bzw. aktuellen Gruppe. */
function fillSelects(forGroup = null) {
  const group = forGroup || currentGroup();
  const members = group ? group.members : [me()];

  $('#categorySelect').innerHTML = SELECTABLE_CATEGORIES
    .map((key) => `<option value="${key}">${CATEGORIES[key].label}</option>`).join('');

  // Sich selbst kann man nicht beschenken – der Eintrag wäre sofort unsichtbar.
  $('#giftForSelect').innerHTML = members
    .filter((m) => m !== me())
    .map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');

  $('#eventSelect').innerHTML = group
    ? eventsOf(group.id).map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('')
    : '';

  // Aus einem Anlass heraus ist der Anlass bereits gesetzt.
  if (view().name === 'event') $('#eventSelect').value = view().id;

  const options = members.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  $('#payerSelect').innerHTML = options;
  $('#fromSelect').innerHTML  = options;
  $('#toSelect').innerHTML    = options;

  // Meistens legt man seine eigene Auslage bzw. eigene Rückzahlung an –
  // beides also standardmäßig auf sich selbst stellen.
  if (members.includes(me())) {
    $('#payerSelect').value = me();
    $('#fromSelect').value  = me();
  }
  const firstOther = members.find((m) => m !== me());
  if (firstOther) $('#toSelect').value = firstOther;

  fillParticipants(members);
  if (entryType === 'gift') applyGiftRecipient();
}

/**
 * Nimmt den Beschenkten aus Zahler- und Teilnehmerliste heraus – er soll
 * weder sein eigenes Geschenk bezahlen noch sich daran beteiligen.
 */
function applyGiftRecipient(forGroup = null) {
  const group = forGroup || currentGroup() || groupOfExpense({ eventId: form.elements.eventId.value });
  const members = group ? group.members : [];
  const recipient = $('#giftForSelect').value;
  const others = members.filter((m) => m !== recipient);

  const previousPayer = form.elements.payer.value;
  $('#payerSelect').innerHTML = others
    .map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  if (others.includes(previousPayer)) form.elements.payer.value = previousPayer;

  fillParticipants(others);
}

/** „Teilen durch": alle Mitglieder als an-/abwählbare Chips, anfangs alle an. */
function fillParticipants(members) {
  $('#participantList').innerHTML = members.map((m) => `
    <button class="chip chip-toggle" type="button" data-participant="${esc(m)}" aria-pressed="true">
      ${esc(m === me() ? `${m} (du)` : m)}
    </button>`).join('');

  updateSplitHint();
}

const selectedParticipants = () =>
  $$('#participantList [aria-pressed="true"]').map((btn) => btn.dataset.participant);

/* ---------------------------- Ungleich aufteilen ------------------------- */

let splitMode = 'amount';                 // 'amount' | 'share'

const unequalOn = () => $('#unequalToggle').checked;

const enteredAmount = () =>
  parseFloat(String(form.elements.amount?.value || '').replace(',', '.')) || 0;

/** Eine Zeile je Teilnehmer; beim Öffnen sinnvoll vorbelegt. */
function renderSplitRows(preset = null) {
  const chosen = selectedParticipants();
  const amount = enteredAmount();
  const gleich = chosen.length ? amount / chosen.length : 0;

  $('#splitRows').innerHTML = chosen.map((name) => {
    const vorgabe = preset && preset[name] !== undefined
      ? preset[name]
      : (splitMode === 'amount' ? (gleich ? gleich.toFixed(2) : '') : 1);

    return `
      <div class="split-row">
        <span class="split-name">${esc(name === me() ? `${name} (du)` : name)}</span>
        <input class="split-input" type="number" inputmode="decimal"
               step="${splitMode === 'amount' ? '0.01' : '1'}" min="0"
               data-split-for="${esc(name)}" value="${vorgabe}">
        <span class="split-unit">${splitMode === 'amount' ? '€' : 'Anteile'}</span>
        <span class="split-calc"></span>
      </div>`;
  }).join('');

  updateSplitHint();
}

const splitValues = () => {
  const values = {};
  $$('#splitRows [data-split-for]').forEach((input) => {
    values[input.dataset.splitFor] = parseFloat(String(input.value).replace(',', '.')) || 0;
  });
  return values;
};

/** Zeigt live, wie viel pro Kopf anfällt – und ob die Summe aufgeht. */
function updateSplitHint() {
  const chosen = selectedParticipants();
  const amount = enteredAmount();
  const hint = $('#splitHint');

  if (chosen.length === 0) {
    hint.textContent = 'Mindestens eine Person auswählen.';
    return;
  }

  hint.textContent = unequalOn()
    ? `${plural(chosen.length, 'Person', 'Personen')} · ungleich aufgeteilt`
    : amount > 0
      ? `${plural(chosen.length, 'Person', 'Personen')} · je ${euro(amount / chosen.length)}`
      : `${plural(chosen.length, 'Person', 'Personen')} teilen sich diese Ausgabe.`;

  if (!unequalOn()) return;

  const values = splitValues();
  const summe = Object.values(values).reduce((s, v) => s + v, 0);
  const balance = $('#splitBalance');

  if (splitMode === 'amount') {
    const rest = amount - summe;
    balance.textContent = amount <= 0
      ? 'Bitte zuerst den Gesamtbetrag eintragen.'
      : Math.abs(rest) < 0.005
        ? 'Passt genau auf.'
        : rest > 0 ? `Noch ${euro(rest)} zu verteilen.` : `${euro(-rest)} zu viel verteilt.`;
    balance.className = 'split-balance' + (amount > 0 && Math.abs(rest) < 0.005 ? ' is-ok' : ' is-warn');

    $$('#splitRows .split-calc').forEach((el) => { el.textContent = ''; });
  } else {
    balance.textContent = summe > 0
      ? `${summe} Anteile insgesamt.`
      : 'Bitte mindestens einen Anteil vergeben.';
    balance.className = 'split-balance' + (summe > 0 ? ' is-ok' : ' is-warn');

    // Bei Anteilen ist der Eurobetrag nicht offensichtlich – also anzeigen.
    $$('#splitRows .split-row').forEach((row) => {
      const name = row.querySelector('[data-split-for]').dataset.splitFor;
      const anteil = summe > 0 ? amount * (values[name] || 0) / summe : 0;
      row.querySelector('.split-calc').textContent = amount > 0 ? euro(anteil) : '';
    });
  }
}

function setSplitMode(mode, preset = null) {
  splitMode = mode;
  $$('[data-split-mode]').forEach((btn) =>
    btn.setAttribute('aria-selected', String(btn.dataset.splitMode === mode)));
  renderSplitRows(preset);
}

function toggleUnequal(open, preset = null) {
  $('#unequalToggle').checked = open;
  $('#splitEditor').hidden = !open;
  if (open) renderSplitRows(preset);
  else updateSplitHint();
}

function showError(message) {
  const el = $('#formError');
  el.textContent = message;
  el.hidden = false;
}

/* --------------------------------- Speichern ----------------------------- */

/** Gibt bei Erfolg true zurück, bei Fehleingabe false (Sheet bleibt offen). */
function saveEntry() {
  const data = new FormData(form);
  const edited = editedExpense();
  const editedPay = editedPayment();
  const editedMember = editing?.type === 'member' ? editing : null;

  // Beim Bearbeiten zählt die Gruppe des Eintrags, nicht die offene Ansicht.
  const group = edited ? groupOfExpense(edited)
              : editedPay ? groupById(editedPay.groupId)
              : editedMember ? groupById(editedMember.groupId)
              : currentGroup();
  const text = (key) => (data.get(key) || '').trim();
  const number = (key) => parseFloat(String(data.get(key)).replace(',', '.'));

  if (entryType === 'group') {
    const name = text('name');
    if (!name) return showError('Bitte einen Gruppennamen eingeben.'), false;

    const members = text('members').split(',').map((m) => m.trim()).filter(Boolean);
    state.data.groups.unshift({
      id: nextId('g'),
      name,
      members: [me(), ...members.filter((m) => m !== me())]
    });
    return true;
  }

  if (!group) return showError('Bitte zuerst eine Gruppe anlegen.'), false;

  if (entryType === 'event') {
    const name = text('eventName');
    if (!name) return showError('Bitte einen Namen für den Anlass eingeben.'), false;

    const startDate = text('eventStart') || null;
    const endDate = text('eventEnd') || null;
    if (startDate && endDate && endDate < startDate) {
      return showError('„Bis" darf nicht vor „Von" liegen.'), false;
    }

    const editedEvent = editing?.type === 'event' ? eventById(editing.id) : null;
    if (editedEvent) {
      Object.assign(editedEvent, { name, startDate, endDate });
      return true;
    }

    // unshift() statt push(): neue Anlässe sollen wie Ausgaben/Zahlungen/
    // Gruppen oben in der Liste erscheinen, nicht unten angehängt werden.
    state.data.events.unshift({ id: nextId('ev'), groupId: group.id, name, startDate, endDate });
    return true;
  }

  if (entryType === 'person') {
    const name = text('personName');
    if (!name) return showError('Bitte einen Namen eingeben.'), false;

    if (editedMember) {
      if (name !== editedMember.name && group.members.includes(name)) {
        return showError(`${name} ist schon in dieser Gruppe.`), false;
      }
      renameMember(editedMember.name, name);   // benennt in allen Gruppen um, siehe dort
      return true;
    }

    if (group.members.includes(name)) return showError(`${name} ist schon in dieser Gruppe.`), false;

    group.members.push(name);
    return true;
  }

  if (entryType === 'payment') {
    const amount = number('payAmount');
    const from = data.get('from');
    const to   = data.get('to');

    if (!(amount > 0)) return showError('Bitte einen Betrag größer als 0 eingeben.'), false;
    if (from === to) return showError('Sender und Empfänger müssen verschieden sein.'), false;

    if (editedPay) {
      // Datum behalten – bearbeiten heißt nicht neu erfassen.
      Object.assign(editedPay, { from, to, amount });
    } else {
      state.data.payments.unshift({
        id: nextId('p'), groupId: group.id, from, to, amount, date: today(),
        // Trägt jemand seine EIGENE Zahlung ein, ist das eine Meldung, die
        // der Empfänger noch bestätigen muss – gleiche Regel wie im
        // Zahlungs-Sheet, damit es keinen Weg drumherum gibt.
        status: statusForNewPayment(from)
      });
    }
    return true;
  }

  // entryType === 'expense' oder 'gift'
  const isGift  = entryType === 'gift';
  const title   = text('title');
  const amount  = number('amount');
  const eventId = data.get('eventId');
  const participants = selectedParticipants();
  const giftFor = isGift ? data.get('giftFor') : null;
  const category = isGift ? 'gift' : (data.get('category') || DEFAULT_CATEGORY);

  if (!title) return showError(isGift ? 'Bitte angeben, was verschenkt wird.' : 'Bitte angeben, wofür das Geld ausgegeben wurde.'), false;
  if (!(amount > 0)) return showError('Bitte einen Betrag größer als 0 eingeben.'), false;
  if (!eventId) return showError('Bitte zuerst einen Anlass anlegen.'), false;
  if (isGift && !giftFor) {
    return showError('Für ein Geschenk braucht es mindestens eine weitere Person in der Gruppe.'), false;
  }
  if (isGift && participants.length === 0) {
    return showError(`Außer ${giftFor} ist niemand in der Gruppe, der das Geschenk mittragen könnte.`), false;
  }
  if (participants.length === 0) return showError('Bitte mindestens eine Person auswählen, die mitträgt.'), false;

  // Ungleiche Aufteilung prüfen und in eine saubere Form bringen.
  let split = { mode: 'equal', values: {} };

  if (unequalOn()) {
    const values = {};
    participants.forEach((p) => { values[p] = splitValues()[p] || 0; });
    const summe = Object.values(values).reduce((s, v) => s + v, 0);

    if (splitMode === 'amount') {
      if (Math.abs(summe - amount) > 0.005) {
        const rest = amount - summe;
        return showError(rest > 0
          ? `Es fehlen noch ${euro(rest)} – die Beträge müssen den Gesamtbetrag ergeben.`
          : `${euro(-rest)} zu viel verteilt – die Beträge müssen den Gesamtbetrag ergeben.`), false;
      }
    } else if (summe <= 0) {
      return showError('Bitte mindestens einen Anteil größer als 0 vergeben.'), false;
    }

    split = { mode: splitMode, values };
  }

  const receiptId = text('receiptId') || null;

  if (edited) {
    // Datum bewusst behalten – bearbeiten heißt nicht neu erfassen.
    Object.assign(edited, { eventId, category, title, amount, payer: data.get('payer') || me(), participants, giftFor, split });
    // Einen schon vorhandenen Beleg nie durch „kein Beleg" ersetzen.
    if (receiptId) edited.receiptId = receiptId;
  } else {
    state.data.expenses.unshift({
      id: nextId('e'),
      eventId,
      category,
      title,
      amount,
      payer: data.get('payer') || me(),
      participants,
      giftFor,
      split,
      date: today(),
      receiptId
    });
  }

  return true;
}

/* ------------------------------ Rechnung scannen -------------------------- */

/**
 * Zeigt die Beleg-Vorschau im Formular. Das Foto kommt direkt vom Scan mit
 * (dann ist es sofort da); beim Bearbeiten einer alten Ausgabe wird es
 * nachgeladen – schlägt das fehl, bleibt der Knopf trotzdem nutzbar.
 */
function showReceiptChip(receiptId, itemCount = null, photo = null) {
  const chip = $('#viewReceiptBtn');
  const thumb = $('#receiptThumb');
  const sub = $('#receiptChipSub');

  chip.hidden = false;
  sub.textContent = itemCount ? `${itemCount} ${itemCount === 1 ? 'Posten' : 'Posten'} · Foto` : 'Foto und Posten';

  if (photo) {
    thumb.src = photo;
    thumb.hidden = false;
    return;
  }

  thumb.hidden = true;
  Store.getReceipt(receiptId).then((receipt) => {
    // Zwischenzeitlich könnte eine andere Ausgabe offen sein.
    if ($('#receiptIdField').value !== receiptId) return;
    if (receipt.photo) {
      thumb.src = receipt.photo;
      thumb.hidden = false;
    }
    if (receipt.items?.length) {
      sub.textContent = `${receipt.items.length} ${receipt.items.length === 1 ? 'Posten' : 'Posten'} · Foto`;
    }
  }).catch(() => { /* Vorschau ist Beiwerk – der Knopf funktioniert weiterhin */ });
}

$('#scanBtn').addEventListener('click', () => {
  Receipt.open(({ total, items, receiptId, shop, savedPhoto, photo }) => {
    form.elements.amount.value = total ?? '';

    // Leere Felder freundlich vorbelegen, aber nie etwas überschreiben,
    // das schon dasteht – sonst ärgert der Scan mehr, als er hilft.
    if (!form.elements.title.value.trim() && shop) form.elements.title.value = shop;

    if (receiptId) {
      $('#receiptIdField').value = receiptId;
      showReceiptChip(receiptId, items.length, photo);
    }

    const result = $('#scanResult');
    const parts = [euro(total ?? 0)];
    if (items.length) parts.push(`${items.length} ${items.length === 1 ? 'Posten' : 'Posten'}`);
    parts.push(savedPhoto ? 'Beleg gespeichert' : 'Beleg nicht gespeichert');
    result.textContent = `Übernommen: ${parts.join(' · ')}`;
    result.className = savedPhoto ? 'scan-result is-ok' : 'scan-result';
    result.hidden = false;

    updateSplitHint();
  });
});

$('#viewReceiptBtn').addEventListener('click', () => {
  const id = $('#receiptIdField').value;
  if (id) Receipt.view(id);
});

/* ----------------------------------- Theme ------------------------------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('meta[name="theme-color"]').content = theme === 'dark' ? '#1c1917' : '#f3eee6';
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* Storage blockiert */ }
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* Storage blockiert */ }

  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
}

/* ----------------------------------- Events ------------------------------ */

$('#fab').addEventListener('click', toggleDial);
$('#dialScrim').addEventListener('click', closeDial);
$('#backBtn').addEventListener('click', goBack);

// Dial-Einträge werden neu gerendert – daher delegiert.
$('#dialItems').addEventListener('click', (e) => {
  const btn = e.target.closest('.dial-btn');
  if (!btn) return;
  closeDial();
  openSheet(btn.dataset.action);
});

// Zeilen der Ansicht ebenfalls delegiert.
$('#view').addEventListener('click', async (e) => {
  const toGroup = e.target.closest('[data-goto-group]');
  if (toGroup) return go({ name: 'group', id: toGroup.dataset.gotoGroup });

  const toEvent = e.target.closest('[data-goto-event]');
  if (toEvent) return go({ name: 'event', id: toEvent.dataset.gotoEvent });

  // Reiterwechsel ist kein neuer Schritt im Verlauf – der Zurück-Pfeil soll
  // aus der Gruppe herausführen, nicht durch die Reiter zurückblättern.
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    view().tab = tab.dataset.tab;
    pendingDelete = null;
    return render();
  }

  const toExpense = e.target.closest('[data-edit-expense]');
  if (toExpense) return openExpenseEditor(toExpense.dataset.editExpense);

  const toPayment = e.target.closest('[data-edit-payment]');
  if (toPayment) return openPaymentEditor(toPayment.dataset.editPayment);

  const toEditEvent = e.target.closest('[data-edit-event]');
  if (toEditEvent) return openEventEditor(toEditEvent.dataset.editEvent);

  // Diese drei Aktionen gibt es nur innerhalb von „Gruppe verwalten".
  const toMember = e.target.closest('[data-edit-member]');
  if (toMember) return openMemberEditor(view().id, toMember.dataset.editMember);

  if (e.target.closest('[data-add-member]')) return openSheet('person');

  const avatarAction = e.target.closest('[data-group-avatar]');
  if (avatarAction) {
    if (avatarAction.dataset.groupAvatar === 'pick') {
      $('#groupAvatarInput').click();
    } else {
      setGroupAvatar(view().id, null);
      render();
      await persist();
    }
    return;
  }

  // Vor der Mitgliederzeile prüfen: der Rollen-Knopf liegt in derselben
  // Zeile, sonst würde stattdessen das Bearbeiten-Formular aufgehen.
  //
  // Fehler gefunden (2026-08-09) beim Testen von Nr. 2: hier stand "now",
  // eine Variable, die es in diesem Handler gar nicht gibt (überall sonst
  // heißt es "view()") – jeder Klick auf "Zum Admin machen" endete seit
  // Nr. 35 lautlos in einer ReferenceError, ohne dass es auffiel, weil der
  // damalige Test den Server direkt ansprach und diesen Knopf nie
  // tatsächlich anklickte.
  const showAudit = e.target.closest('[data-show-audit]');
  if (showAudit) {
    return loadAuditLog(showAudit.dataset.showAudit);
  }

  const archiveGroup = e.target.closest('[data-toggle-group-archive]');
  if (archiveGroup) {
    toggleGroupArchive(archiveGroup.dataset.toggleGroupArchive);
    render();
    await persist();
    return;
  }

  const archiveEvent = e.target.closest('[data-toggle-event-archive]');
  if (archiveEvent) {
    toggleEventArchive(archiveEvent.dataset.toggleEventArchive);
    render();
    await persist();
    return;
  }

  if (e.target.closest('#expenseSearchClear')) {
    expenseFilter = '';
    const feld = $('#expenseSearch');
    if (feld) { feld.value = ''; feld.focus(); }
    aktualisiereSuchergebnis();
    return;
  }

  const shareInvite = e.target.closest('[data-share-invite]');
  if (shareInvite) return createGroupInvite(shareInvite.dataset.shareInvite);

  const copyInvite = e.target.closest('[data-copy]');
  if (copyInvite) return copyToClipboard(copyInvite.dataset.copy, copyInvite);

  const leaveGroupBtn = e.target.closest('[data-leave-group]');
  if (leaveGroupBtn) return leaveCurrentGroup(leaveGroupBtn.dataset.leaveGroup);

  const ask = e.target.closest('[data-delete-ask]');
  if (ask) {
    const [type, id] = ask.dataset.deleteAsk.split(':');
    pendingDelete = { type, id };
    return render();
  }

  if (e.target.closest('[data-delete-cancel]')) {
    pendingDelete = null;
    return render();
  }

  const confirm = e.target.closest('[data-delete-confirm]');
  if (confirm) {
    const [type, id] = confirm.dataset.deleteConfirm.split(':');

    if (type === 'group') {
      // Eigener, expliziter Endpunkt statt normalem Speichern: Eine Gruppe
      // mit mehr als einem verlinkten Konto lässt sich absichtlich nicht
      // mehr durchs bloße Weglassen aus einem Speichervorgang löschen (siehe
      // db.js saveData) – das könnte sonst ein veralteter lokaler Stand
      // eines anderen Mitglieds versehentlich auslösen.
      try {
        await Store.deleteGroupExplicit(id);
      } catch (error) {
        pendingDelete = null;
        manageNotice = { text: error.message, type: 'error' };
        return render();
      }
      deleteGroup(id);                 // lokal spiegeln
      go({ name: 'groups' });          // Verlauf zurücksetzen, die Gruppe gibt es nicht mehr
    } else {
      deleteEvent(id);
      goBack();                        // eine Ebene hoch, zurück in die Gruppe
      await persist();
    }
  }
});

/* Suche: bei jedem Tastendruck nur die Ergebnisse austauschen, nie die ganze
   Ansicht. Das Suchfeld selbst wird dadurch NICHT angefasst – Fokus, Cursor,
   Umlaut-Eingaben und die Wortvorschläge der Handytastatur bleiben heil.
   (Siehe Begründung bei expenseResults.) */
$('#view').addEventListener('input', (e) => {
  if (e.target.id !== 'expenseSearch') return;

  expenseFilter = e.target.value;
  aktualisiereSuchergebnis();
});

function aktualisiereSuchergebnis() {
  const behaelter = $('#expenseResults');
  const aktuell = view();
  if (!behaelter || aktuell.name !== 'event') return;

  const event = eventById(aktuell.id);
  if (event) behaelter.innerHTML = expenseResults(expensesOf(event.id));

  // Das Kreuz zum Leeren gehört zum Feld, nicht zu den Ergebnissen – es
  // erscheint bzw. verschwindet mit dem Inhalt.
  const kreuz = $('#expenseSearchClear');
  if (kreuz) kreuz.hidden = !expenseFilter;
}

// Formulare innerhalb von „Gruppe verwalten" – der Rest läuft über das Sheet.
$('#view').addEventListener('submit', async (e) => {
  if (e.target.id !== 'groupNameForm') return;
  e.preventDefault();

  const name = (new FormData(e.target).get('name') || '').trim();
  if (!name) {
    manageNotice = { text: 'Bitte einen Gruppennamen eingeben.', type: 'error' };
    return render();
  }

  renameGroup(view().id, name);
  manageNotice = { text: 'Name gespeichert.', type: 'ok' };
  render();
  await persist();
});

$('#manageGroupBtn').addEventListener('click', () => {
  if (view().name === 'group') go({ name: 'manage', id: view().id });
});

/** Setzt oder löscht das Gruppenbild; das Speichern übernimmt der Aufrufer. */
function setGroupAvatar(groupId, dataUrl) {
  const group = groupById(groupId);
  if (group) group.avatar = dataUrl;
  manageNotice = { text: dataUrl ? 'Gruppenbild aktualisiert.' : 'Gruppenbild entfernt.', type: 'ok' };
}

/**
 * Archiviert eine Gruppe oder holt sie zurück. Geteiltes Feld wie Name/Bild
 * (kein Admin-Vorbehalt): ist eine Reise für einen vorbei, ist sie es für
 * alle, und anders als bei Mitgliedern/Einladungen geht dabei nichts
 * kaputt, das sich nicht mit einem zweiten Klick zurückdrehen ließe.
 */
function toggleGroupArchive(groupId) {
  const group = groupById(groupId);
  if (!group) return;
  group.archived = !group.archived;
  manageNotice = { text: group.archived ? 'Gruppe archiviert.' : 'Aus dem Archiv geholt.', type: 'ok' };
}

/** Gleiches Prinzip wie bei Gruppen, nur für einen einzelnen Anlass. */
function toggleEventArchive(eventId) {
  const event = eventById(eventId);
  if (!event) return;
  event.archived = !event.archived;
}

$('#groupAvatarInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';          // damit dieselbe Datei erneut wählbar bleibt
  if (!file) return;

  try {
    setGroupAvatar(view().id, await fileToAvatar(file));
  } catch (error) {
    manageNotice = { text: error.message, type: 'error' };
  }
  render();
  await persist();
});

// Teilnehmer an-/abwählen und Betrag ändern aktualisieren die Aufteilung.
$('#participantList').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-participant]');
  if (!chip) return;
  chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
  unequalOn() ? renderSplitRows() : updateSplitHint();
});

form.elements.amount.addEventListener('input', () => {
  // Bei festen Beträgen die Vorbelegung mitziehen, solange noch nichts
  // von Hand geändert wurde – sonst stünde da die alte Aufteilung.
  updateSplitHint();
});

$('#unequalToggle').addEventListener('change', (e) => toggleUnequal(e.target.checked));

$$('[data-split-mode]').forEach((btn) =>
  btn.addEventListener('click', () => setSplitMode(btn.dataset.splitMode)));

$('#splitRows').addEventListener('input', updateSplitHint);

// Anderer Beschenkter → Zahler- und Teilnehmerliste neu aufbauen.
// Bewusst gekapselt: direkt übergeben würde das Event als Gruppe ankommen.
$('#giftForSelect').addEventListener('change', () => applyGiftRecipient());

// Rechte-Abschnitt im Mitglied-Formular. Eigener Zuhörer, weil der Block im
// Formular sitzt und nicht in #view – der dortige Zuhörer greift hier nicht.
$('#memberAdminBlock')?.addEventListener('click', (e) => {
  if (!editing || editing.type !== 'member') return;

  const setAdmin = e.target.closest('[data-set-admin]');
  if (setAdmin) {
    return setGroupAdmin(editing.groupId, setAdmin.dataset.setAdmin, setAdmin.dataset.adminValue === '1');
  }

  const resetLink = e.target.closest('[data-create-reset-link]');
  if (resetLink) return createMemberResetLink(editing.groupId, resetLink.dataset.createResetLink);

  const copy = e.target.closest('[data-copy]');
  if (copy) return copyToClipboard(copy.dataset.copy, copy);
});

$('#sheetClose').addEventListener('click', closeSheet);
$('#sheetCancel').addEventListener('click', closeSheet);
backdrop.addEventListener('click', closeSheet);

// Löschen im Bearbeiten-Formular: erst scharfstellen, dann ausführen.
$('#deleteEntryBtn').addEventListener('click', async () => {
  const button = $('#deleteEntryBtn');

  if (!deleteArmed) {
    deleteArmed = true;

    // Bei einem Mitglied mit offenem Saldo reicht „Wirklich löschen?" nicht:
    // Es muss dabeistehen, was mit dem Geld passiert. Sonst entfernt jemand
    // eine Person und wundert sich später, warum die Salden anders sind.
    if (editing?.type === 'member') {
      const saldo = memberBalanceOf(editing.groupId, editing.name);
      if (Math.abs(saldo) > 0.005) {
        button.textContent = saldo < 0
          ? `Schuldet ${euro(-saldo)} – trotzdem entfernen?`
          : `Bekommt ${euro(saldo)} – trotzdem entfernen?`;
        const hinweis = $('#deleteEntryHint');
        if (hinweis) {
          hinweis.textContent = saldo < 0
            ? `${editing.name} schuldet der Gruppe noch ${euro(-saldo)}. Beim Entfernen wird der Betrag als ausgeglichen verbucht – die offene Forderung ist damit weg.`
            : `Der Gruppe steht ${editing.name} noch ${euro(saldo)} zu. Beim Entfernen wird der Betrag als ausgeglichen verbucht.`;
          hinweis.hidden = false;
        }
        return;
      }
    }

    button.textContent = button.dataset.armedLabel || 'Wirklich löschen?';
    return;
  }

  if (editing?.type === 'payment') {
    state.data.payments = state.data.payments.filter((p) => p.id !== editing.id);
  } else if (editing?.type === 'expense') {
    state.data.expenses = state.data.expenses.filter((e) => e.id !== editing.id);
  } else if (editing?.type === 'member') {
    removeMember(editing.groupId, editing.name);
  }
  editing = null;

  closeSheet();
  render();
  await persist();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Der Rechnungs-Scanner liegt über dem Formular und schließt sich selbst.
  if (!document.getElementById('receiptOverlay')?.hidden) return;
  if (!sheet.hidden) closeSheet();
  else if (dialOpen) closeDial();
});

// Schutz gegen Doppel-Eintrag: Da das Sheet jetzt animiert schließt (statt
// sofort zu verschwinden), bleibt der Speichern-Knopf kurz sichtbar – ein
// zweiter, hastiger Tipp würde sonst denselben Eintrag ein zweites Mal anlegen.
let submitting = false;

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submitting) return;
  if (saveEntry() !== true) return;

  submitting = true;
  try {
    closeSheet();
    render();
    await persist();
  } finally {
    submitting = false;
  }
});

$('#themeToggle').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

$('#appbarTitle').addEventListener('click', () => go({ name: 'groups' }));
