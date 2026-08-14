/* ==========================================================================
   FreundeTracker – Passwort-Reset per Admin-Link
   --------------------------------------------------------------------------
   Kein Mailserver im Projekt (kein npm, keine externe Abhängigkeit) – also
   auch kein klassischer "Link per E-Mail"-Reset. Stattdessen erzeugt ein
   Gruppen-Admin einen Einmal-Link (siehe app.js, "Gruppe verwalten") und
   schickt ihn demjenigen persönlich, genau wie einen Einladungslink.

   Bewusst ein EIGENER Bildschirm statt eines Sheets über der Anmeldung
   (anders als invite.js): der Grund für diesen Aufruf ist ja gerade, dass
   keine Sitzung besteht – Invite.checkPending() läuft erst NACH enterApp(),
   das würde hier nicht funktionieren.
   ========================================================================== */

const Reset = (() => {
  const view  = document.getElementById('resetView');
  const form  = document.getElementById('resetForm');
  const claim = document.getElementById('resetClaim');
  const error = document.getElementById('resetError');

  function tokenFromUrl() {
    return new URLSearchParams(location.search).get('resetToken');
  }

  function cleanUrl() {
    const url = new URL(location.href);
    url.searchParams.delete('resetToken');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }

  /**
   * Läuft ganz am Anfang von boot(), noch vor der Sitzungsprüfung.
   * @returns {Promise<boolean>} true, wenn der Reset-Bildschirm übernommen
   *          hat – dann darf boot() nicht zusätzlich showAuth()/enterApp()
   *          aufrufen. false, wenn kein (gültiger) Link vorliegt – dann
   *          läuft der normale Start unverändert weiter.
   */
  async function tryShow() {
    const token = tokenFromUrl();
    if (!token) return false;

    let info;
    try {
      info = await Store.getResetInfo(token);
    } catch {
      // Abgelaufen oder schon benutzt – kein Grund, den Start zu blockieren,
      // einfach zur normalen Anmeldung durchfallen lassen.
      cleanUrl();
      return false;
    }

    claim.textContent = `Für ${info.name} – danach bist du auf diesem Gerät angemeldet.`;
    error.hidden = true;
    form.reset();

    $('#splash').hidden = true;
    $('#auth').hidden = true;
    $('#app').hidden = true;
    view.hidden = false;
    attachPasswordToggles(view);

    form.onsubmit = async (e) => {
      e.preventDefault();
      const password  = form.elements.password.value;
      const password2 = form.elements.password2.value;

      if (password.length < 8) return showError('Das Passwort braucht mindestens 8 Zeichen.');
      if (password !== password2) return showError('Die Passwörter stimmen nicht überein.');

      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        const user = await Store.redeemReset(token, password);
        cleanUrl();
        view.hidden = true;
        await enterApp(user);
      } catch (err) {
        showError(err.message);
        button.disabled = false;
      }
    };

    return true;
  }

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
  }

  return { tryShow };
})();
