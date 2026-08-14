/* ==========================================================================
   FreundeTracker – Datenschicht (Browser)
   --------------------------------------------------------------------------
   Spricht mit dem Server unter /api/. Konten, Gruppen, Anlässe, Ausgaben und
   Zahlungen liegen in einer SQLite-Datenbank auf dem Server – dadurch sieht
   man auf Handy und Laptop denselben Stand.

   Die Methodennamen sind dieselben wie in der localStorage-Fassung davor,
   deshalb musste an der Oberfläche nichts angefasst werden:

       register()      →  POST   /api/register
       login()         →  POST   /api/login
       logout()        →  POST   /api/logout
       session()       →  GET    /api/me
       updateProfile() →  PATCH  /api/me
       changePassword()→  POST   /api/me/password
       deleteAccount() →  DELETE /api/me
       loadData()      →  GET    /api/data
       saveData()      →  PUT    /api/data

   Die Anmeldung hängt jetzt an einem httpOnly-Cookie, das der Server setzt.
   Das Passwort wird serverseitig mit scrypt geprüft; im Browser wird nichts
   mehr gehasht und nichts mehr dauerhaft gespeichert (außer der Designwahl).
   ========================================================================== */

const Store = (() => {

  /* Schaufenster-Fassung (Portfolio-Demo): Die App haengt beim Portfolio
     unter /freunde statt an der Wurzel. Alle Pfade unten sind weiterhin
     als /api/... geschrieben und bekommen den Prefix hier davor – so
     bleibt der Rest der Datei unveraendert gegenueber dem Original. */
  const API_BASE = '/freunde';

  /** Eine Anfrage an die API. Fehler kommen als lesbarer Text zurück. */
  async function api(method, path, body) {
    let response;

    try {
      response = await fetch(API_BASE + path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin'      // Sitzungs-Cookie mitschicken
      });
    } catch {
      throw new Error('Der Server ist nicht erreichbar. Läuft er noch?');
    }

    const text = await response.text();
    let payload = null;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error('Unerwartete Antwort vom Server.');
      }
    }

    if (!response.ok) {
      throw new Error(payload?.error || `Der Server meldet einen Fehler (${response.status}).`);
    }

    return payload;
  }

  return {
    register: (data)      => api('POST', '/api/register', data),
    login:    (email, password) => api('POST', '/api/login', { email, password }),
    logout:   ()          => api('POST', '/api/logout'),
    session:  ()          => api('GET', '/api/me'),
    // Schaufenster-Fassung: meldet still am Demo-Konto an (siehe boot() in
    // account.js). Legt das Konto beim ersten Aufruf mit Beispieldaten an.
    demoLogin: ()         => api('GET', '/api/demo-login'),

    updateProfile:  (patch) => api('PATCH', '/api/me', patch),
    changePassword: (currentPassword, newPassword) =>
                      api('POST', '/api/me/password', { currentPassword, newPassword }),
    deleteAccount:  ()      => api('DELETE', '/api/me'),

    loadData: ()     => api('GET', '/api/data'),
    // Liefert { ok, asOf } statt nur true – asOf ist der frische
    // Server-Zeitstempel nach dem Speichern, siehe app.js persist().
    saveData: (data) => api('PUT', '/api/data', data),

    // Belege haben eigene Endpunkte, damit die Fotos nicht bei jedem
    // saveData erneut durchs Netz gehen – die Ausgabe merkt sich nur die ID.
    saveReceipt: (receipt)  => api('POST', '/api/receipts', receipt),
    getReceipt:  (id)       => api('GET', `/api/receipts/${encodeURIComponent(id)}`),

    // Einladung/Beitritt: eine geteilte Gruppe hat mehrere echte Konten als
    // Mitglieder statt nur eins. deleteGroupExplicit ist der einzige Weg,
    // eine "echt geteilte" Gruppe zu löschen – normales Speichern schützt
    // solche Gruppen bewusst davor (siehe db.js saveData).
    createInvite:      (groupId)         => api('POST', `/api/groups/${encodeURIComponent(groupId)}/invite`),
    getInviteInfo:     (token)           => api('GET', `/api/invite/${encodeURIComponent(token)}`),
    joinInvite:        (token, claimName) => api('POST', `/api/invite/${encodeURIComponent(token)}/join`, { claimName: claimName || null }),
    leaveGroup:        (groupId)         => api('POST', `/api/groups/${encodeURIComponent(groupId)}/leave`),
    setGroupAdmin:     (groupId, name, isAdmin) =>
      api('POST', `/api/groups/${encodeURIComponent(groupId)}/admin`, { name, isAdmin }),
    getAuditLog:       (groupId)         => api('GET', `/api/groups/${encodeURIComponent(groupId)}/audit`),

    // Passwort-Reset per Admin-Link statt E-Mail (kein Mailserver im Projekt).
    // Getrennt von den Auth-Aufrufen oben, weil dieser Weg keine bestehende
    // Sitzung braucht (createResetLink schon, die anderen beiden nicht).
    createResetLink:   (groupId, name)     =>
      api('POST', `/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(name)}/reset-link`),
    getResetInfo:      (token)             => api('GET', `/api/password-reset/${encodeURIComponent(token)}`),
    redeemReset:       (token, password)   => api('POST', `/api/password-reset/${encodeURIComponent(token)}`, { password }),

    pushKey:           ()                  => api('GET',  '/api/push/key'),
    pushSubscribe:     (subscription)      => api('POST', '/api/push/subscribe', { subscription }),
    pushUnsubscribe:   (endpoint)          => api('POST', '/api/push/unsubscribe', { endpoint }),
    pushTest:          ()                  => api('POST', '/api/push/test'),
    deleteGroupExplicit: (groupId)       => api('DELETE', `/api/groups/${encodeURIComponent(groupId)}`)
  };
})();
