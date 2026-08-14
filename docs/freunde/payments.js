/* ==========================================================================
   FreundeTracker – Offene Zahlungen
   --------------------------------------------------------------------------
   Zeigt in der Übersicht, welche Beträge zwischen mir und anderen noch offen
   sind, und blendet beim Antippen die Bankverbindung zum Kopieren ein.

   Gruppenmitglieder sind im Datenmodell nur Namen – sie haben kein eigenes
   Konto und damit auch keine IBAN. Deshalb gibt es hier ein kleines
   Kontaktbuch (state.data.contacts), in das man die Bankverbindung der
   anderen direkt aus der offenen Zahlung heraus einträgt. Für den eigenen
   Namen kommen die Daten aus dem Profil.
   ========================================================================== */

/**
 * Bankverbindung einer Person – für mich aus dem Profil. Für andere zuerst
 * `linkedContacts` (echtes, verlinktes Konto – kommt direkt aus dessen
 * Profil, siehe db.js loadData), erst wenn das nichts hergibt, das manuell
 * eingetragene Kontaktbuch (Platzhalter-Mitglieder ohne eigenes Konto).
 */
function contactOf(name) {
  if (name === me()) {
    return { iban: state.user?.iban || '', paypal: state.user?.paypal || '', own: true };
  }
  const linked = state.data.linkedContacts?.[name];
  if (linked && (linked.iban || linked.paypal)) {
    return { iban: linked.iban || '', paypal: linked.paypal || '', own: false };
  }
  const stored = state.data.contacts[name] || {};
  return { iban: stored.iban || '', paypal: stored.paypal || '', own: false };
}

/** Alle offenen Ausgleichszahlungen über alle Gruppen, die mich betreffen. */
function openPayments() {
  const rows = [];
  const gemeldet = pendingPayments();

  state.data.groups.forEach((group) => {
    settlement(group.id).forEach((transfer) => {
      if (transfer.from !== me() && transfer.to !== me()) return;
      // Liegt zu dieser Richtung schon eine unbestätigte Meldung vor? Ohne
      // diesen Hinweis sieht die Zeile aus wie unangetastet und man meldet
      // ein zweites Mal.
      const meldung = gemeldet.find((p) =>
        p.groupId === group.id && p.from === transfer.from && p.to === transfer.to);
      rows.push({ ...transfer, groupId: group.id, groupName: group.name, reported: Boolean(meldung) });
    });
  });

  return rows.sort((a, b) => b.amount - a.amount);
}

/**
 * Abschnitt für die Übersichtsseite. Nutzt denselben settleRow()-Baustein
 * wie die „So wird ausgeglichen"-Karte in der Gruppe – nur eben gefiltert auf
 * das, was einen selbst betrifft, und gruppenübergreifend gemischt. Deshalb
 * bekommt jede Zeile zusätzlich den Gruppennamen und ist antippbar.
 */
function openPaymentsSection() {
  const rows = openPayments();

  const owed = rows.filter((r) => r.to === me()).reduce((s, r) => s + r.amount, 0);
  const owing = rows.filter((r) => r.from === me()).reduce((s, r) => s + r.amount, 0);

  const body = rows.length
    ? rows.map((r, index) => settleRow(r, { groupName: r.groupName, openIndex: index })).join('')
    : settleDone('Nichts offen – alle Gruppen sind ausgeglichen.');

  const summary = rows.length
    ? `<p class="pay-summary">
         ${owing > 0.005 ? `Du schuldest <strong class="is-neg">${euro(owing)}</strong>` : ''}
         ${owing > 0.005 && owed > 0.005 ? ' · ' : ''}
         ${owed > 0.005 ? `Du bekommst <strong class="is-pos">${euro(owed)}</strong>` : ''}
       </p>`
    : '';

  return `
    <section class="block">
      <div class="block-head">
        <h2>So wird ausgeglichen</h2>
        <span class="count">${rows.length}</span>
      </div>
      ${summary}
      <div class="card settle">${body}</div>
    </section>`;
}

/**
 * Gemeldete Zahlungen ganz oben auf der Übersicht – das ist die einzige
 * Stelle in der App, an der jemand anderes auf eine Reaktion von mir wartet.
 * Deshalb steht sie vor allem anderen und ist direkt hier erledigbar, statt
 * sie in der Gruppe suchen zu müssen.
 */
function pendingSection() {
  const rows = pendingPayments();
  if (rows.length === 0) return '';

  const zuBestaetigen = rows.filter((p) => p.to === me());
  const abwartend = rows.filter((p) => p.from === me());

  const bestaetigen = zuBestaetigen.map((p) => `
    <div class="confirm-row">
      <span class="confirm-text">
        <strong>${esc(p.from)}</strong> hat dir <strong class="is-pos">${euro(p.amount)}</strong> überwiesen
        <span class="confirm-sub">${esc(p.groupName)}</span>
      </span>
      <span class="confirm-actions">
        <button class="btn btn-ghost" type="button" data-reject-payment="${esc(p.id)}">Nein</button>
        <button class="btn btn-primary" type="button" data-confirm-payment="${esc(p.id)}">Erhalten</button>
      </span>
    </div>`).join('');

  const warten = abwartend.map((p) => `
    <div class="confirm-row is-waiting">
      <span class="confirm-text">
        Du hast <strong>${euro(p.amount)}</strong> an <strong>${esc(p.to)}</strong> gemeldet
        <span class="confirm-sub">${esc(p.groupName)} · wartet auf Bestätigung</span>
      </span>
    </div>`).join('');

  return `
    <section class="block">
      <div class="block-head">
        <h2>${zuBestaetigen.length ? 'Bitte bestätigen' : 'Wartet auf Bestätigung'}</h2>
        ${zuBestaetigen.length ? `<span class="count is-alert">${zuBestaetigen.length}</span>` : ''}
      </div>
      <div class="card confirm-card">${bestaetigen}${warten}</div>
    </section>`;
}

/* ------------------------------ Detail-Ansicht --------------------------- */

const paySheet = document.getElementById('paySheet');
let activePayment = null;

function openPaySheet(index) {
  activePayment = openPayments()[index];
  if (!activePayment) return;

  renderPaySheet();
  paySheet.hidden = false;
  document.getElementById('backdrop').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closePaySheet() {
  if (paySheet.hidden) return;
  activePayment = null;

  // animateOut()/makeSheetDraggable() kommen aus app.js – gleiches
  // Schliess- und Wisch-Verhalten wie beim Formular-Sheet.
  animateOut(paySheet, 'is-closing', () => {
    paySheet.hidden = true;
    paySheet.style.transform = '';
    document.body.style.overflow = '';
  });
  animateOut(document.getElementById('backdrop'), 'is-closing', () => {
    document.getElementById('backdrop').hidden = true;
  });
}

makeSheetDraggable(paySheet, closePaySheet);

function renderPaySheet() {
  const payment = activePayment;
  const iOwe = payment.from === me();
  const other = iOwe ? payment.to : payment.from;

  // Liegt zu genau dieser Richtung schon eine Meldung vor?
  // "gemeldet"      = der andere hat gemeldet, ICH muss bestätigen.
  // "meineMeldung"  = ich habe gemeldet und warte auf ihn.
  const offene = pendingPayments().filter((p) => p.groupId === payment.groupId);
  const gemeldet = offene.find((p) => p.to === me() && p.from === other) || null;
  const meineMeldung = offene.find((p) => p.from === me() && p.to === other) || null;

  // Ich zahle → ich brauche seine Daten. Er zahlt → er braucht meine.
  const contact = contactOf(iOwe ? other : me());

  const line = (label, value) => value
    ? `<div class="pay-line">
         <span class="pay-line-label">${label}</span>
         <span class="pay-line-value">${esc(value)}</span>
         <button class="btn btn-ghost pay-copy" type="button" data-copy="${esc(value)}">Kopieren</button>
       </div>`
    : '';

  const details = contact.iban || contact.paypal
    ? line('IBAN', contact.iban ? formatIban(contact.iban) : '') + line('PayPal', contact.paypal)
    : '';

  const missing = !contact.iban && !contact.paypal;

  const missingBlock = missing && !contact.own
    ? `<form id="contactForm" class="pay-missing">
         <p class="hint">Für ${esc(other)} ist noch keine Bankverbindung hinterlegt.</p>
         <label class="field">
           <span>IBAN von ${esc(other)}</span>
           <input type="text" name="iban" placeholder="AT00 0000 0000 0000 0000" autocomplete="off" spellcheck="false">
         </label>
         <p class="error" id="contactError" hidden></p>
         <button class="btn btn-primary btn-block" type="submit">Bankverbindung merken</button>
       </form>`
    : missing && contact.own
      ? `<p class="hint">
           Du hast selbst noch keine IBAN hinterlegt. Trag sie im Profil ein, dann
           kannst du sie hier direkt weitergeben.
         </p>`
      : '';

  document.getElementById('paySheetBody').innerHTML = `
    <div class="pay-hero">
      <span class="pay-hero-label">
        ${iOwe ? `Du schuldest ${esc(other)}` : `${esc(other)} schuldet dir`}
      </span>
      <strong class="pay-hero-amount ${iOwe ? 'is-neg' : 'is-pos'}">${euro(payment.amount)}</strong>
      <span class="pay-hero-note">aus „${esc(payment.groupName)}“</span>
    </div>

    ${details ? `
      <p class="pay-details-label">
        ${iOwe ? `Bankverbindung von ${esc(other)}` : 'Deine Daten – schick sie ' + esc(other)}
      </p>
      <div class="card pay-details">${details}</div>` : ''}

    ${missingBlock}

    ${gemeldet ? `
      <div class="pay-pending">
        <p class="pay-pending-text">
          ${esc(other)} hat <strong>${euro(gemeldet.amount)}</strong> als überwiesen gemeldet.
        </p>
        <div class="pay-pending-actions">
          <button class="btn btn-ghost" type="button" data-reject-payment="${esc(gemeldet.id)}">Stimmt nicht</button>
          <button class="btn btn-primary" type="button" data-confirm-payment="${esc(gemeldet.id)}">Erhalten – bestätigen</button>
        </div>
      </div>`

    : meineMeldung ? `
      <!-- Schon gemeldet: kein zweiter Knopf. Sonst entstünde bei jedem
           Nachschauen eine weitere Meldung, und der Empfänger müsste
           dieselbe Zahlung mehrfach wegklicken. -->
      <div class="pay-pending is-waiting">
        <p class="pay-pending-text">
          ${icon('M12 8v4l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z')}
          Du hast <strong>${euro(meineMeldung.amount)}</strong> als überwiesen gemeldet.
          ${esc(other)} muss das noch bestätigen.
        </p>
        <button class="btn btn-ghost btn-block" type="button" data-withdraw-payment="${esc(meineMeldung.id)}">
          Meldung zurücknehmen
        </button>
      </div>`

    : `
      <button class="btn btn-primary btn-block pay-done" type="button" data-mark-paid>
        ${iOwe ? 'Habe ich überwiesen' : 'Zahlung erhalten'}
      </button>
      <p class="hint">
        ${iOwe
          ? `${esc(other)} bekommt das zum Bestätigen angezeigt. Bis dahin bleibt der Betrag offen.`
          : 'Das verbucht die Rückzahlung sofort und gleicht den Betrag aus.'}
      </p>`}

`;
}

/* --------------------------------- Aktionen ------------------------------ */

/** Alter Weg über ein unsichtbares Textfeld – funktioniert auch ohne https. */
function legacyCopy(text) {
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(field);

  field.select();
  field.setSelectionRange(0, text.length);

  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }

  field.remove();
  return ok;
}

async function copyToClipboard(text, button) {
  const original = button.textContent;

  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Kopiert';
  } catch {
    // Fallback für ältere oder unsichere Kontexte (http statt https).
    button.textContent = legacyCopy(text) ? 'Kopiert' : 'Bitte lange antippen und kopieren';
  }

  setTimeout(() => { button.textContent = original; }, 1800);
}

/**
 * Bucht die offene Zahlung. Wer sie bucht, entscheidet über den Zustand:
 * Der Empfänger weiß, ob das Geld da ist – er verbucht sofort. Der Zahler
 * kann nur melden; bestätigen muss der Empfänger (siehe app.js,
 * statusForNewPayment).
 */
async function markPaid() {
  const payment = activePayment;

  state.data.payments.unshift({
    id: nextId('p'),
    groupId: payment.groupId,
    from: payment.from,
    to: payment.to,
    // Auf Cent runden – Drittelbeträge lassen sich nicht überweisen.
    amount: Math.round(payment.amount * 100) / 100,
    date: today(),
    status: statusForNewPayment(payment.from)
  });

  closePaySheet();
  render();
  await persist();
}

/** Empfänger bestätigt eine gemeldete Zahlung – ab jetzt zählt sie zum Saldo. */
async function confirmPayment(paymentId) {
  const payment = state.data.payments.find((p) => p.id === paymentId);
  // Nur der Empfänger darf bestätigen. Die Prüfung steht hier nicht als
  // Schutz gegen Angreifer (die kämen am Client ohnehin vorbei), sondern
  // damit die Regel an genau einer Stelle festgeschrieben ist.
  if (!payment || payment.to !== me()) return;

  payment.status = 'confirmed';
  closePaySheet();
  render();
  await persist();
}

/** Empfänger widerspricht – die Meldung verschwindet, der Betrag bleibt offen. */
async function rejectPayment(paymentId) {
  const payment = state.data.payments.find((p) => p.id === paymentId);
  if (!payment || payment.to !== me()) return;

  state.data.payments = state.data.payments.filter((p) => p.id !== paymentId);
  closePaySheet();
  render();
  await persist();
}

/** Zahler nimmt seine eigene, noch unbestätigte Meldung zurück (Vertipper). */
async function withdrawPayment(paymentId) {
  const payment = state.data.payments.find((p) => p.id === paymentId);
  // Nur die eigene und nur solange sie noch nicht bestätigt ist – eine
  // bestätigte Zahlung einseitig zurückzuziehen wäre dasselbe Problem in
  // die andere Richtung.
  if (!payment || payment.from !== me() || !isUnconfirmedPayment(payment)) return;

  state.data.payments = state.data.payments.filter((p) => p.id !== paymentId);
  closePaySheet();
  render();
  await persist();
}

/* ----------------------------------- Events ------------------------------ */

document.getElementById('view').addEventListener('click', (e) => {
  // Bestätigen/Ablehnen direkt aus der Übersicht – zuerst prüfen, sonst
  // würde ein Klick auf den Knopf auch die Zahlungs-Detailansicht öffnen.
  const bestaetigen = e.target.closest('[data-confirm-payment]');
  if (bestaetigen) return confirmPayment(bestaetigen.dataset.confirmPayment);

  const ablehnen = e.target.closest('[data-reject-payment]');
  if (ablehnen) return rejectPayment(ablehnen.dataset.rejectPayment);

  const row = e.target.closest('[data-open-payment]');
  if (row) openPaySheet(Number(row.dataset.openPayment));
});

paySheet.addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) return copyToClipboard(copy.dataset.copy, copy);

  const bestaetigen = e.target.closest('[data-confirm-payment]');
  if (bestaetigen) return confirmPayment(bestaetigen.dataset.confirmPayment);

  const ablehnen = e.target.closest('[data-reject-payment]');
  if (ablehnen) return rejectPayment(ablehnen.dataset.rejectPayment);

  const zurueck = e.target.closest('[data-withdraw-payment]');
  if (zurueck) return withdrawPayment(zurueck.dataset.withdrawPayment);

  if (e.target.closest('[data-mark-paid]')) await markPaid();
});

paySheet.addEventListener('submit', async (e) => {
  if (e.target.id !== 'contactForm') return;
  e.preventDefault();

  const iban = (new FormData(e.target).get('iban') || '').trim();
  const error = document.getElementById('contactError');

  if (!isValidIban(iban)) {
    error.textContent = 'Diese IBAN stimmt nicht – bitte auf Tippfehler prüfen.';
    error.hidden = false;
    return;
  }

  const iOwe = activePayment.from === me();
  const other = iOwe ? activePayment.to : activePayment.from;

  state.data.contacts[other] = { ...(state.data.contacts[other] || {}), iban: normalizeIban(iban) };

  renderPaySheet();
  await persist();
});

document.getElementById('paySheetClose').addEventListener('click', closePaySheet);

document.getElementById('backdrop').addEventListener('click', () => {
  if (!paySheet.hidden) closePaySheet();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !paySheet.hidden) closePaySheet();
});
