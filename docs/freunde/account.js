/* ==========================================================================
   FreundeTracker – Benutzerkonto
   Anmelden, Registrieren, Profil bearbeiten, Profilbild, Abmelden, Löschen.
   Setzt auf app.js auf (state, render, esc, …) und spricht nur über Store.
   Diese Datei startet die App auch (ganz unten).
   ========================================================================== */

/* ------------------------------- Profilbild ------------------------------ */

const AVATAR_SIZE = 256;          // Kantenlänge des gespeicherten Bilds
const AVATAR_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Skaliert das gewählte Bild auf ein quadratisches Format herunter und gibt
 * es als data-URL zurück. Ohne das Verkleinern wäre der Browser-Speicher nach
 * wenigen Fotos voll.
 */
async function fileToAvatar(file) {
  if (!file.type.startsWith('image/')) throw new Error('Bitte eine Bilddatei auswählen.');
  if (file.size > AVATAR_MAX_BYTES)    throw new Error('Das Bild ist zu groß (höchstens 10 MB).');

  const source = await loadImage(file);
  const side = Math.min(source.width, source.height);

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = AVATAR_SIZE;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(
    source,
    (source.width - side) / 2, (source.height - side) / 2, side, side,   // mittiger Ausschnitt
    0, 0, AVATAR_SIZE, AVATAR_SIZE
  );

  return canvas.toDataURL('image/jpeg', 0.85);
}

function loadImage(file) {
  if (globalThis.createImageBitmap) return createImageBitmap(file);

  // Fallback für Browser ohne createImageBitmap
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild konnte nicht gelesen werden.')); };
    img.src = url;
  });
}

/** Bild oder Initialen – überall dort, wo der Benutzer dargestellt wird. */
const avatarContent = (user) => mediaAvatar(user?.avatar, user?.name || '?');

/* ---------------------- Push-Benachrichtigungen --------------------------
   Warum das überhaupt sein muss: Seit Zahlungen vom Empfänger bestätigt
   werden, wartet regelmäßig jemand auf eine Reaktion – und merkt davon
   nichts, solange er die App nicht zufällig öffnet.

   Zwei Dinge, die hier Ärger machen und deshalb ausdrücklich behandelt sind:
   - Auf dem iPhone gibt es Push NUR, wenn die App vorher über „Teilen →
     Zum Home-Bildschirm" installiert wurde. Im normalen Safari-Tab fehlt
     die Möglichkeit komplett. Ohne Erklärung sucht man sich dumm.
   - Ein gültiges Zertifikat ist Voraussetzung (secure context). Über die
     LAN-Adresse mit selbst erstelltem Zertifikat gibt es keinen Service
     Worker und damit auch kein Push.
   ------------------------------------------------------------------------ */

let pushStatus = { unterstuetzt: false, aktiv: false, grund: '', meldung: null };

const istInstallierteApp = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;

const istApple = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

async function pushStatusLaden() {
  pushStatus.meldung = null;

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    pushStatus.unterstuetzt = false;
    pushStatus.grund = istApple() && !istInstallierteApp()
      ? 'Auf dem iPhone gibt es Benachrichtigungen erst, wenn die App über „Teilen → Zum Home-Bildschirm" hinzugefügt wurde.'
      : 'Dieser Browser unterstützt keine Benachrichtigungen. Möglich ist auch, dass die Verbindung kein gültiges Zertifikat hat.';
    return;
  }

  pushStatus.unterstuetzt = true;
  try {
    const registrierung = await navigator.serviceWorker.ready;
    pushStatus.aktiv = Boolean(await registrierung.pushManager.getSubscription());
  } catch {
    pushStatus.aktiv = false;
  }
}

function pushCardHtml() {
  if (!pushStatus.unterstuetzt) {
    return `<p class="hint">${esc(pushStatus.grund)}</p>`;
  }

  const meldung = pushStatus.meldung
    ? `<p class="${pushStatus.meldung.type === 'error' ? 'error' : 'hint'}">${esc(pushStatus.meldung.text)}</p>`
    : '';

  return pushStatus.aktiv
    ? `${meldung}
       <p class="hint">
         Du wirst benachrichtigt: wenn jemand eine Zahlung an dich meldet, wenn
         deine eigene Zahlung bestätigt wird, wenn jemand einer deiner Gruppen
         beitritt und wenn eine neue Ausgabe dich betrifft.
       </p>
       <div class="pay-pending-actions">
         <button class="btn btn-ghost" type="button" data-push="test">Testnachricht</button>
         <button class="btn btn-ghost" type="button" data-push="off">Ausschalten</button>
       </div>`
    : `${meldung}
       <p class="hint">
         Lass dich benachrichtigen, wenn dir jemand Geld überwiesen hat und du
         es nur noch bestätigen musst.
       </p>
       <button class="btn btn-primary btn-block" type="button" data-push="on">Benachrichtigungen einschalten</button>`;
}

/** Der öffentliche Serverschlüssel kommt als base64url und muss als Bytes rein. */
function schluesselAlsBytes(base64url) {
  const gefuellt = base64url.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - base64url.length % 4) % 4);
  const roh = atob(gefuellt);
  return Uint8Array.from(roh, (z) => z.charCodeAt(0));
}

async function pushEinschalten() {
  try {
    const erlaubnis = await Notification.requestPermission();
    if (erlaubnis !== 'granted') {
      pushStatus.meldung = { type: 'error', text: erlaubnis === 'denied'
        ? 'Benachrichtigungen sind für diese Seite blockiert. Das lässt sich nur in den Browser-Einstellungen wieder erlauben.'
        : 'Ohne Erlaubnis geht es leider nicht.' };
      return pushKarteAktualisieren();
    }

    const { key } = await Store.pushKey();
    const registrierung = await navigator.serviceWorker.ready;
    const abo = await registrierung.pushManager.subscribe({
      userVisibleOnly: true,               // Pflicht: jede Nachricht wird sichtbar
      applicationServerKey: schluesselAlsBytes(key)
    });

    await Store.pushSubscribe(abo.toJSON());
    pushStatus.aktiv = true;
    pushStatus.meldung = { type: 'ok', text: 'Eingeschaltet. Probier gleich die Testnachricht.' };
  } catch (error) {
    pushStatus.meldung = { type: 'error', text: error.message || 'Hat nicht geklappt.' };
  }
  pushKarteAktualisieren();
}

async function pushAusschalten() {
  try {
    const registrierung = await navigator.serviceWorker.ready;
    const abo = await registrierung.pushManager.getSubscription();
    if (abo) {
      // Erst beim Server abmelden, dann lokal – andersherum kennt der Server
      // den Endpunkt nicht mehr und versucht ewig, an ein totes Abo zu senden.
      await Store.pushUnsubscribe(abo.endpoint).catch(() => {});
      await abo.unsubscribe();
    }
    pushStatus.aktiv = false;
    pushStatus.meldung = null;
  } catch (error) {
    pushStatus.meldung = { type: 'error', text: error.message || 'Hat nicht geklappt.' };
  }
  pushKarteAktualisieren();
}

async function pushTesten() {
  try {
    await Store.pushTest();
    pushStatus.meldung = { type: 'ok', text: 'Unterwegs – sie sollte gleich ankommen.' };
  } catch (error) {
    pushStatus.meldung = { type: 'error', text: error.message };
  }
  pushKarteAktualisieren();
}

/** Nur die Karte neu zeichnen – ein voller Render würde die Ansicht zurücksetzen. */
function pushKarteAktualisieren() {
  const karte = document.getElementById('pushCard');
  if (karte) karte.innerHTML = pushCardHtml();
}

function renderAvatarButton() {
  $('#profileBtn').innerHTML = avatarContent(state.user);
}

/* ----------------------------------- IBAN -------------------------------- */

const normalizeIban = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Anzeige in Vierergruppen, so wie sie auf Rechnungen steht. */
const formatIban = (value) => normalizeIban(value).replace(/(.{4})/g, '$1 ').trim();

/**
 * Prüfziffernverfahren nach ISO 13616: Die ersten vier Zeichen wandern ans
 * Ende, Buchstaben werden zu Zahlen (A=10 … Z=35), der Rest modulo 97 muss 1
 * ergeben. Fängt Tippfehler ab, sagt aber nichts darüber, ob es das Konto gibt.
 */
function isValidIban(value) {
  const iban = normalizeIban(value);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (c) => c.charCodeAt(0) - 55);

  let remainder = 0;
  for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}

/* --------------------------------- Profil -------------------------------- */

/** Rückmeldung über der Profilansicht, wird nach dem Rendern geleert. */
let profileNotice = null;
let confirmDelete = false;

function notify(text, type = 'ok') {
  profileNotice = { text, type };
}

/**
 * Offene Salden über alle Gruppen hinweg, in denen man Mitglied ist –
 * Grundlage für die Rückfrage vor dem Löschen des eigenen Kontos. Gleiches
 * Prinzip wie memberBalanceOf() beim Entfernen eines Mitglieds (app.js),
 * nur über die eigenen Gruppen statt nur eine.
 */
function openBalancesAcrossGroups() {
  const name = me();
  return state.data.groups
    .filter((g) => g.members.includes(name))
    .map((g) => ({ group: g, balance: memberBalanceOf(g.id, name) }))
    .filter((x) => Math.abs(x.balance) > 0.005);
}

function renderProfileView() {
  // Der Zustand des Abos lässt sich nur asynchron erfragen, gerendert wird
  // aber synchron. Deshalb hier anstoßen und die Karte nachziehen, sobald
  // die Antwort da ist – der Rest der Ansicht wartet nicht darauf.
  pushStatusLaden().then(pushKarteAktualisieren);
  $('#appbarTitle').textContent = 'Profil';

  const user = state.user;
  const notice = profileNotice
    ? `<p class="notice ${profileNotice.type === 'error' ? 'is-error' : 'is-ok'}">${esc(profileNotice.text)}</p>`
    : '';
  profileNotice = null;

  const since = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' })
    .format(new Date(user.createdAt));

  return `
    ${notice}

    <section class="profile-head">
      <div class="profile-avatar">${avatarContent(user)}</div>
      <div class="profile-identity">
        <strong>${esc(user.name)}</strong>
        <span>${esc(user.email)}</span>
        <span class="profile-since">Dabei seit ${since}</span>
      </div>
    </section>

    <div class="profile-avatar-actions">
      <button class="btn btn-ghost" type="button" data-profile="pick-avatar">
        ${user.avatar ? 'Bild ändern' : 'Bild auswählen'}
      </button>
      ${user.avatar ? `<button class="btn btn-ghost" type="button" data-profile="remove-avatar">Entfernen</button>` : ''}
      <!-- Schaufenster-Fassung: kein "Abmelden". Wer sich in der Demo
           abmeldet, sieht danach eine Anmeldemaske ohne Zugangsdaten – die
           Demo wäre für den nächsten Besucher unbrauchbar. Der Server
           lehnt das Abmelden zusätzlich ab (siehe api.js). -->
    </div>

    <section class="block">
      <div class="block-head"><h2>Deine Daten</h2></div>
      <form id="profileForm" class="card">
        <label class="field">
          <span>Name</span>
          <input type="text" name="name" value="${esc(user.name)}" autocomplete="name">
          <small>Unter diesem Namen tauchst du in allen Gruppen auf.</small>
        </label>
        <label class="field">
          <span>E-Mail</span>
          <input type="email" name="email" value="${esc(user.email)}" autocomplete="email">
        </label>
        <button class="btn btn-primary btn-block" type="submit">Änderungen speichern</button>
      </form>
    </section>

    <section class="block">
      <div class="block-head"><h2>Zahlungsinfos</h2></div>
      <form id="paymentForm" class="card">
        <label class="field">
          <span>IBAN</span>
          <input type="text" name="iban" value="${esc(formatIban(user.iban))}"
                 placeholder="AT00 0000 0000 0000 0000" autocomplete="off" spellcheck="false">
          <small>Damit Freunde beim Abrechnen wissen, wohin sie überweisen.</small>
        </label>
        <label class="field">
          <span>PayPal</span>
          <input type="text" name="paypal" value="${esc(user.paypal)}"
                 placeholder="paypal.me/deinname oder E-Mail" autocomplete="off">
        </label>
        <p class="hint">
          Diese Angaben liegen unverschlüsselt auf diesem Gerät. Trag hier nichts ein,
          was du auf einem fremden Rechner nicht hinterlassen willst.
        </p>
        <button class="btn btn-primary btn-block" type="submit">Zahlungsinfos speichern</button>
      </form>
    </section>

    <!-- Schaufenster-Fassung: Passwortwechsel ausgebaut. Er würde alle
         Sitzungen beenden (changePassword in db.js) und das Demo-Konto
         hinter einem Passwort verschließen, das niemand kennt. -->

    <!-- Browser-Fassung: Anmeldung, Passwort und Benachrichtigungen brauchen
         alle einen Server. Statt Knöpfe zu zeigen, die ins Leere greifen,
         steht hier offen, was fehlt und warum. -->
    <section class="block">
      <div class="block-head"><h2>Was diese Demo nicht kann</h2></div>
      <div class="card">
        <p class="auth-hint" style="margin-bottom:14px">
          Diese Fassung läuft <b>ganz ohne Server</b> — deine Eingaben bleiben
          in diesem Browser. Deshalb fehlen genau die Funktionen, die einen
          gemeinsamen Server voraussetzen:
        </p>
        <ul class="danger-list" style="margin:0 0 14px; padding-left:18px; line-height:1.6">
          <li><b>Freunde einladen</b> — bräuchte einen Server, den beide Seiten erreichen.</li>
          <li><b>Benachrichtigungen</b> — verschickt ein Server; ohne ihn kann dich nichts erreichen.</li>
          <li><b>Handy und Laptop gleich</b> — ohne Server gibt es nichts abzugleichen.</li>
          <li><b>Konto und Passwort</b> — es gibt hier nur dich, also auch keine Anmeldung.</li>
        </ul>
        <p class="auth-hint" style="margin-bottom:14px">
          Die vollständige Fassung mit Konten, geteilten Gruppen und
          Benachrichtigungen läuft bei mir zu Hause auf einem kleinen Server.
        </p>
        <button class="btn btn-danger btn-block" type="button" data-profile="demo-reset">
          Demo zurücksetzen
        </button>
      </div>
    </section>`;
}

/* ----------------------------- Profil-Aktionen --------------------------- */

async function saveProfile(formData) {
  const name  = (formData.get('name')  || '').trim();
  const email = (formData.get('email') || '').trim();

  if (!name)  return notify('Bitte einen Namen eingeben.', 'error');
  if (!isEmail(email)) return notify('Bitte eine gültige E-Mail-Adresse eingeben.', 'error');

  const previousName = state.user.name;

  try {
    state.user = await Store.updateProfile({ name, email });
  } catch (error) {
    return notify(error.message, 'error');
  }

  // Mitglieder werden über den Namen referenziert – Verweise mitziehen.
  if (previousName !== state.user.name) {
    renameMember(previousName, state.user.name);
    await persist();
  }

  notify('Profil gespeichert.');
}

async function savePaymentInfo(formData) {
  const iban   = (formData.get('iban')   || '').trim();
  const paypal = (formData.get('paypal') || '').trim();

  // Leer lassen ist erlaubt – nur wer etwas einträgt, muss es richtig eintragen.
  if (iban && !isValidIban(iban)) {
    return notify('Diese IBAN stimmt nicht – bitte auf Tippfehler prüfen.', 'error');
  }

  try {
    state.user = await Store.updateProfile({ iban: normalizeIban(iban), paypal });
    notify('Zahlungsinfos gespeichert.');
  } catch (error) {
    notify(error.message, 'error');
  }
}

async function saveNewPassword(formData) {
  const current = formData.get('current') || '';
  const next    = formData.get('next')    || '';
  const next2   = formData.get('next2')   || '';

  if (!current) return notify('Bitte das aktuelle Passwort eingeben.', 'error');
  if (next.length < 8) return notify('Das neue Passwort braucht mindestens 8 Zeichen.', 'error');
  if (next !== next2)  return notify('Die beiden neuen Passwörter stimmen nicht überein.', 'error');

  try {
    await Store.changePassword(current, next);
    notify('Passwort geändert.');
  } catch (error) {
    notify(error.message, 'error');
  }
}

async function setAvatar(dataUrl) {
  try {
    state.user = await Store.updateProfile({ avatar: dataUrl });
    notify(dataUrl ? 'Profilbild aktualisiert.' : 'Profilbild entfernt.');
  } catch (error) {
    notify(error.message, 'error');
  }
}

/* ------------------------- Anmelden / Registrieren ----------------------- */

const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());

function showAuthError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.hidden = false;
}

function switchAuthTab(tab) {
  $$('[data-auth-tab]').forEach((btn) =>
    btn.setAttribute('aria-selected', String(btn.dataset.authTab === tab)));

  $('#loginForm').hidden    = tab !== 'login';
  $('#registerForm').hidden = tab !== 'register';
  $('#loginError').hidden = true;
  $('#registerError').hidden = true;

  // Ohne Einladungslink erklären, warum das Formular nicht weiterhilft –
  // besser als es kommentarlos am Server scheitern zu lassen. Das erste
  // Konto überhaupt darf der Server trotzdem durchlassen, deshalb wird das
  // Formular nur erklärt und nicht gesperrt.
  $('#inviteOnlyHint').hidden = Invite.hasPendingToken();
}

function showAuth() {
  state.user = null;
  state.data = { groups: [], events: [], expenses: [], payments: [], barcodes: {}, contacts: {}, linkedContacts: {}, asOf: null };

  $('#app').hidden = true;
  $('#auth').hidden = false;
  document.body.style.overflow = '';

  $('#loginForm').reset();
  $('#registerForm').reset();
  switchAuthTab('login');
  attachPasswordToggles($('#auth'));
}

/** Sorgt dafür, dass fehlende Felder aus alten Ständen nicht alles umwerfen. */
function normalizeData(data) {
  return {
    groups:   Array.isArray(data?.groups)   ? data.groups   : [],
    events:   Array.isArray(data?.events)   ? data.events   : [],
    expenses: Array.isArray(data?.expenses) ? data.expenses : [],
    payments: Array.isArray(data?.payments) ? data.payments : [],
    barcodes: data?.barcodes && typeof data.barcodes === 'object' ? data.barcodes : {},
    contacts: data?.contacts && typeof data.contacts === 'object' ? data.contacts : {},
    // Kommt vom Server (echte Bankverbindung verlinkter Mitkonten), wird nie
    // vom Client selbst geschrieben – siehe payments.js contactOf().
    linkedContacts: data?.linkedContacts && typeof data.linkedContacts === 'object' ? data.linkedContacts : {},
    // Zeitpunkt dieser Momentaufnahme (vom Server gesetzt, siehe db.js
    // loadData). Wird beim nächsten Speichern unverändert zurückgeschickt,
    // damit der Server erkennen kann, ob eine Zeile neuer ist als dieser
    // Stand – nur dann darf ihr Fehlen im Payload nicht als "löschen"
    // gelten (siehe db.js saveData).
    asOf: typeof data?.asOf === 'string' ? data.asOf : null
  };
}

/**
 * @param isNew  Nur direkt nach der Registrierung true. Beispieldaten dürfen
 *               ausschließlich dann entstehen – sonst kämen sie zurück,
 *               sobald jemand bewusst alle Gruppen gelöscht hat.
 */
async function enterApp(user, isNew = false) {
  state.user = user;

  let data = await Store.loadData();

  if (isNew) {
    data = demoData(user.name);
    await Store.saveData(data);
  }

  state.data = normalizeData(data);
  state.stack = [{ name: 'groups' }];
  confirmDelete = false;
  profileNotice = null;

  $('#auth').hidden = true;
  $('#app').hidden = false;
  render();

  // Steht in der Adresse ein Einladungslink (?join=…), jetzt behandeln – ab
  // hier ist eine Sitzung sicher vorhanden. Tut nichts, wenn keiner da ist.
  await Invite.checkPending();
}

/* ----------------------------------- Events ------------------------------ */

$$('[data-auth-tab]').forEach((btn) =>
  btn.addEventListener('click', () => switchAuthTab(btn.dataset.authTab)));

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = new FormData(e.target);
  const button = e.target.querySelector('button[type="submit"]');

  $('#loginError').hidden = true;
  button.disabled = true;
  try {
    const user = await Store.login(data.get('email'), data.get('password'));
    await enterApp(user);
  } catch (error) {
    showAuthError('#loginError', error.message);
  } finally {
    button.disabled = false;
  }
});

$('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = new FormData(e.target);
  const button = e.target.querySelector('button[type="submit"]');

  const name      = (data.get('name') || '').trim();
  const email     = (data.get('email') || '').trim();
  const password  = data.get('password') || '';
  const password2 = data.get('password2') || '';

  $('#registerError').hidden = true;

  if (!name)                 return showAuthError('#registerError', 'Bitte einen Namen eingeben.');
  if (!isEmail(email))       return showAuthError('#registerError', 'Bitte eine gültige E-Mail-Adresse eingeben.');
  if (password.length < 8)   return showAuthError('#registerError', 'Das Passwort braucht mindestens 8 Zeichen.');
  if (password !== password2) return showAuthError('#registerError', 'Die Passwörter stimmen nicht überein.');

  button.disabled = true;
  try {
    // Token mitschicken: Der Server lässt neue Konten nur mit gültiger
    // Einladung zu (Ausnahme: das allererste Konto überhaupt).
    const user = await Store.register({ name, email, password, inviteToken: Invite.pendingToken() });
    // Wer über einen Einladungslink registriert, will einer bestehenden
    // Gruppe beitreten – Beispielgruppen wären da nur verwirrend (siehe
    // Sarah-Fall: Demodaten sahen wie eine falsche Vermischung mit Markus'
    // Gruppen aus, waren aber nur die übliche Startbefüllung).
    await enterApp(user, !Invite.hasPendingToken());
  } catch (error) {
    showAuthError('#registerError', error.message);
  } finally {
    button.disabled = false;
  }
});

$('#profileBtn').addEventListener('click', () => {
  if (view().name !== 'profile') go({ name: 'profile' });
});

// Die Profilansicht wird komplett neu gerendert – daher alles delegiert.
$('#view').addEventListener('click', async (e) => {
  const pushKnopf = e.target.closest('[data-push]');
  if (pushKnopf) {
    if (pushKnopf.dataset.push === 'on')   return pushEinschalten();
    if (pushKnopf.dataset.push === 'off')  return pushAusschalten();
    if (pushKnopf.dataset.push === 'test') return pushTesten();
  }

  const button = e.target.closest('[data-profile]');
  if (!button) return;

  switch (button.dataset.profile) {
    case 'pick-avatar':
      $('#avatarInput').click();
      break;

    case 'remove-avatar':
      await setAvatar(null);
      render();
      break;

    // Browser-Fassung: ersetzt "Konto löschen". Wirft die im Browser
    // gespeicherten Daten weg und startet mit den Beispieldaten neu.
    case 'demo-reset':
      if (confirm('Alle Eingaben in dieser Demo verwerfen und mit den Beispieldaten neu beginnen?')) {
        Store.demoZuruecksetzen();
      }
      break;

    case 'ask-delete':
      confirmDelete = true;
      render();
      break;

    case 'cancel-delete':
      confirmDelete = false;
      render();
      break;

    case 'confirm-delete': {
      // Offene Salden erst ausgleichen (siehe settleMemberBalance) und
      // SPEICHERN, bevor das Konto verschwindet – sonst fehlt der Ausgleich
      // in der Datenbank, sobald das Konto weg ist. Erst danach löschen.
      const offen = openBalancesAcrossGroups();
      if (offen.length) {
        offen.forEach(({ group }) => settleMemberBalance(group.id, me()));
        try {
          await persist();
        } catch (error) {
          confirmDelete = false;
          notify('Die offenen Salden konnten nicht ausgeglichen werden: ' + error.message, 'error');
          return render();
        }
      }

      await Store.deleteAccount();
      confirmDelete = false;
      showAuth();
      break;
    }

  }
});

$('#view').addEventListener('submit', async (e) => {
  if (e.target.id === 'profileForm') {
    e.preventDefault();
    await saveProfile(new FormData(e.target));
    render();
  }

  if (e.target.id === 'paymentForm') {
    e.preventDefault();
    await savePaymentInfo(new FormData(e.target));
    render();
  }

  if (e.target.id === 'passwordForm') {
    e.preventDefault();
    await saveNewPassword(new FormData(e.target));
    render();
  }
});

$('#avatarInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';          // damit dieselbe Datei erneut wählbar bleibt
  if (!file) return;

  try {
    await setAvatar(await fileToAvatar(file));
  } catch (error) {
    notify(error.message, 'error');
  }
  render();
});

/* ------------------------------------ Start ------------------------------ */

(async function boot() {
  initTheme();

  try {
    // Steht ein Passwort-Reset-Link in der Adresse, übernimmt der komplett –
    // egal ob gerade eine Sitzung besteht oder nicht (genau dafür ist er ja
    // da: man kommt nicht mehr rein). Nur bei einem gültigen Link, sonst
    // läuft der normale Start unten unverändert weiter (kein früher return,
    // damit Splash-Ausblenden und Service-Worker-Registrierung unten in
    // jedem Fall noch laufen).
    if (!(await Reset.tryShow())) {
      // Schaufenster-Fassung (Portfolio-Demo): Besteht noch keine Sitzung,
      // wird still am Demo-Konto angemeldet, statt die Anmeldemaske zu
      // zeigen. Der Endpunkt legt das Konto beim ersten Mal mitsamt
      // Beispieldaten an (siehe ensureDemoUser in db.js).
      let user = await Store.session();
      if (!user) user = await Store.demoLogin();
      if (user) await enterApp(user);
      else showAuth();
    }
  } catch (error) {
    // Server nicht erreichbar: Anmeldemaske zeigen und den Grund nennen,
    // statt den Nutzer vor einem leeren Bildschirm sitzen zu lassen.
    showAuth();
    const warning = $('#storageWarning');
    warning.textContent = error.message;
    warning.hidden = false;
  }

  $('#splash').hidden = true;

  // Schaufenster-Fassung: KEIN Service Worker. In der echten App macht er
  // die Seite offlinefähig; in der Demo würde er nur alte Stände
  // zwischenspeichern und beim Herzeigen Verwirrung stiften. (Der Pfad
  // '/sw.js' zeigte hier ohnehin an der Wurzel des Portfolios vorbei.)
})();
