/* ==========================================================================
   FreundeTracker – Gruppen-Einladung
   --------------------------------------------------------------------------
   Ein Freund öffnet einen Link wie https://…/?join=<token>, meldet sich an
   oder registriert sich, und bekommt danach dieses Sheet: Vorschau der
   Gruppe, Wahl zwischen "einen bestehenden Platzhalter übernehmen" und
   "neu beitreten". Folgt bewusst dem gleichen Baustein-Muster wie
   payments.js (#paySheet): eigene Sheet-Hülle, dynamisches innerHTML,
   eigene open/close-Funktionen, eigener Event-Block – statt des starren,
   entitätsspezifischen #entryForm, weil dieser Bildschirm keine der
   bestehenden Entitäten (Gruppe/Anlass/Ausgabe/Zahlung) ist.
   ========================================================================== */

const Invite = (() => {
  const sheet = document.getElementById('inviteSheet');
  const body  = document.getElementById('inviteSheetBody');

  let token = null;
  let info  = null;
  let error = null;
  let joined = null;   // nach erfolgreichem Beitritt: { groupName }

  function tokenFromUrl() {
    return new URLSearchParams(location.search).get('join');
  }

  function cleanUrl() {
    const url = new URL(location.href);
    url.searchParams.delete('join');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }

  function open() {
    renderSheet();
    sheet.hidden = false;
    document.getElementById('backdrop').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function close() {
    if (sheet.hidden) return;
    animateOut(sheet, 'is-closing', () => {
      sheet.hidden = true;
      sheet.style.transform = '';
      document.body.style.overflow = '';
    });
    animateOut(document.getElementById('backdrop'), 'is-closing', () => {
      document.getElementById('backdrop').hidden = true;
    });
  }

  makeSheetDraggable(sheet, () => finish());

  /** Nach Abschluss (beigetreten oder übersprungen): Sheet zu, Link bereinigt, App zeigt den aktuellen Stand. */
  async function finish() {
    close();
    cleanUrl();
    token = null; info = null; error = null; joined = null;
  }

  /**
   * Ob gerade ein Einladungslink in der Adresse steht – ohne Seiteneffekt.
   * Damit entscheidet die Registrierung, ob Demodaten sinnvoll sind: Wer
   * über einen Link kommt, will einer bestehenden Gruppe beitreten, nicht
   * mit Beispielgruppen starten.
   */
  function hasPendingToken() {
    return Boolean(tokenFromUrl());
  }

  /** Wird nach jedem enterApp() aufgerufen – tut nichts, wenn kein Einladungslink in der Adresse steht. */
  async function checkPending() {
    const found = tokenFromUrl();
    if (!found) return;
    token = found;

    try {
      info = await Store.getInviteInfo(token);
    } catch (err) {
      // Ungültiger/abgelaufener Link – kein Grund, den Start zu blockieren.
      cleanUrl();
      token = null;
      return;
    }

    open();
  }

  async function claim(name) {
    error = null;
    try {
      await Store.joinInvite(token, name);
      joined = { groupName: info.groupName };
      await refreshAndRender();
    } catch (err) {
      error = err.message;
      renderSheet();
    }
  }

  /**
   * Lädt den Datenstand neu (die frisch beigetretene Gruppe ist ja noch
   * nicht lokal geladen) und aktualisiert sowohl das Sheet (Erfolgsmeldung)
   * als auch die App dahinter (app.js render() – sonst sieht man die neue
   * Gruppe erst nach einem manuellen Neuladen der Seite).
   */
  async function refreshAndRender() {
    const data = await Store.loadData();
    state.data = normalizeData(data);
    renderSheet();
    render();
  }

  function renderSheet() {
    if (joined) {
      body.innerHTML = `
        <div class="pay-hero">
          <span class="pay-hero-label">Beigetreten</span>
          <strong class="pay-hero-amount is-pos">${esc(joined.groupName)}</strong>
          <span class="pay-hero-note">Du siehst die Gruppe jetzt in deiner Übersicht.</span>
        </div>
        <button class="btn btn-primary btn-block" type="button" data-invite-done>Los geht's</button>`;
      return;
    }

    if (!info) {
      body.innerHTML = `<p class="empty">Diese Einladung konnte nicht geladen werden.</p>`;
      return;
    }

    const openRows = info.openMembers.map((name) => `
      <li><button class="row" type="button" data-claim-name="${esc(name)}">
        <span class="avatar">${mediaAvatar(null, name)}</span>
        <span class="row-body"><span class="row-title">${esc(name)}</span></span>
        <span class="row-chevron">${icon('M9 5l7 7-7 7')}</span>
      </button></li>`).join('');

    body.innerHTML = `
      <section class="profile-head">
        <div class="profile-avatar">${mediaAvatar(info.groupAvatar, info.groupName)}</div>
        <div class="profile-identity">
          <strong>${esc(info.groupName)}</strong>
          <span>Du wurdest zu dieser Gruppe eingeladen</span>
        </div>
      </section>

      ${error ? `<p class="notice is-error">${esc(error)}</p>` : ''}

      ${info.openMembers.length ? `
        <section class="block">
          <div class="block-head"><h2>Bist du einer davon?</h2></div>
          <ul class="list">${openRows}</ul>
        </section>` : ''}

      <button class="btn btn-ghost btn-block" type="button" data-join-new>
        Ich bin neu in dieser Gruppe
      </button>
      <button class="btn btn-ghost btn-block" type="button" data-invite-skip>
        Vielleicht später
      </button>`;
  }

  sheet.addEventListener('click', async (e) => {
    if (e.target.closest('[data-invite-done]')) return finish();
    if (e.target.closest('[data-invite-skip]')) return finish();

    const claimBtn = e.target.closest('[data-claim-name]');
    if (claimBtn) return claim(claimBtn.dataset.claimName);

    if (e.target.closest('[data-join-new]')) return claim(null);
  });

  document.getElementById('inviteSheetClose').addEventListener('click', finish);

  return { checkPending, hasPendingToken, pendingToken: tokenFromUrl };
})();
