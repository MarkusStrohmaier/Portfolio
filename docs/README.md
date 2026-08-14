# Portfolio – Fassung für GitHub Pages

Dieser Ordner ist die **statische Fassung** der Seite: nur Dateien, kein
Server, keine Datenbank. Genau das kann GitHub Pages ausliefern.

## Veröffentlichen

1. Ordner als Git-Repository anlegen und zu GitHub schieben.
2. Im Repository unter *Settings → Pages* als Quelle **`main` / `/docs`**
   auswählen.
3. Nach ein paar Minuten ist die Seite unter
   `https://<benutzername>.github.io/<repository>/` erreichbar.

Alle Verweise sind **relativ**. Die Seite läuft dadurch sowohl unter einer
solchen Unteradresse als auch direkt auf einer eigenen Domain.

## Was hier drin liegt

| Pfad | Werkzeug | Läuft |
|------|----------|-------|
| `index.html` | Portfolio | — |
| `dienstplan-kalender.html` | Dienstplan → Kalender | unverändert, war immer im Browser |
| `fotos/` | PictureSort | unverändert, war immer im Browser |
| `freunde/` | FreundeTracker | Daten im `localStorage` statt auf dem Server |
| `druck/` | MaxlDruck | Daten im `localStorage` statt in SQLite |

## Der Unterschied zur Fassung mit Server

Die beiden letzten Werkzeuge haben normalerweise ein Backend (Node, SQLite).
Für diese Fassung wurde nur die **Datenhaltung** ersetzt:

* `freunde/store.js` – dieselbe Schnittstelle wie die Server-Fassung, aber
  gegen den `localStorage`. Das Projekt war ursprünglich ohnehin so gebaut.
* `druck/demo-api.js` – bedient dieselben 22 Endpunkte wie der Express-Server
  und liefert dieselben Antworten aus dem `localStorage`.

An der Oberfläche beider Apps musste dafür nichts geändert werden: Sie
sprechen jeweils über genau eine Funktion mit dem Server.

Kalkulation, Salden, Aufteilungen, PDF-Erzeugung und Statistik laufen
unverändert — die waren immer schon im Browser.

## Was ohne Server nicht geht

Steht in beiden Demos sichtbar in der App (bei FreundeTracker unter *Profil*,
bei MaxlDruck unter *Einstellungen*):

* Einladungen und geteilte Gruppen – bräuchten einen Server, den beide Seiten erreichen
* Benachrichtigungen – verschickt ein Server
* Abgleich zwischen mehreren Geräten – ohne Server gibt es nichts abzugleichen
* Konten, Anmeldung, Kundenzugänge
* Sicherung einspielen (bei MaxlDruck) – es gibt keine Datenbankdatei

Jeder Besucher bekommt seine eigene Spielwiese; niemand kann die Demo für
andere zerspielen. Über *Demo zurücksetzen* geht es zurück auf die
Beispieldaten.

## Fassung mit Server

Die vollständigen Apps liegen unverändert daneben:

* `../server.js` und `../apps/` – alles unter einer Adresse, mit Backend
  (`node server.js`, danach <http://localhost:4100>)
* Die Originalprojekte unter `Clauden/FreundeTracker` und
  `Clauden/3D-Preisrechner` – mit Anmeldung und echten Daten

## Vorschau vor dem Veröffentlichen

```bash
node docs-preview.js
```

Liefert `docs/` unter <http://localhost:4200> aus – **ohne** Backend. Läuft
die Seite dort, läuft sie auch auf GitHub Pages.
