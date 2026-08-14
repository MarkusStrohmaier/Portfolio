# MaxlDruck Manager

Kalkulations- und Auftragsverwaltung für 3D-Druck: Projekte kalkulieren (Material,
Druckzeit, Fremdteile, Arbeitszeit), Zahlungen verfolgen, Rechnungen als PDF erzeugen.

## Start

```bash
npm install
npm start
```

Läuft danach auf http://localhost:3000

## Konfiguration (.env)

Der Server benötigt eine `.env` im Projektordner und **startet ohne sie nicht** —
absichtlich, damit nie versehentlich ein fest eingebauter Schlüssel benutzt wird.

```
JWT_SECRET=<zufälliger Wert>
PORT=3000
```

Vorlage: `.env.example`. Passenden Schlüssel erzeugen:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Wird `JWT_SECRET` geändert, sind alle bestehenden Logins ungültig — jeder muss sich
neu anmelden. Das ist normal.

Voraussetzung: Node.js ≥ 20.6 (`.env` wird nativ über `--env-file-if-exists` geladen,
es gibt bewusst keine zusätzliche Abhängigkeit dafür).

## Benutzer

Zwei Rollen: `admin` sieht und bearbeitet alles, `customer` nur die eigenen Projekte.
Neue Kunden legt ein Admin unter *Einstellungen* an; Passwörter brauchen mindestens
8 Zeichen.

Existiert beim Start **kein** Admin, wird automatisch einer angelegt (`admin`) und
dessen Zufallspasswort **einmalig im Terminal** ausgegeben. Wer das übersieht, kommt
nur über einen DB-Eingriff wieder rein — also mitschreiben.

## Arbeitsaufschlag nach Stunden

Arbeitsstunden werden nicht als €/h abgerechnet, sondern als **prozentualer Aufschlag
auf die Postensumme**, gestaffelt nach Stunden. Die Staffel steht unter
*Einstellungen → Arbeitsaufschlag*. Standard:

| Arbeitszeit        | Aufschlag |
| ------------------ | --------- |
| über 0 bis 1 h     | +10 %     |
| über 1 bis 3 h     | +25 %     |
| über 3 bis 5 h     | +50 %     |
| über 5 h (und mehr)| +75 %     |

Es gilt die erste Staffel, deren Grenze erreicht wird; die oberste gilt auch für alles
darüber. Bei 0 h gibt es keinen Aufschlag. Beispiel: 7,80 € Posten + 4 h → +50 % =
**11,70 €**.

Gesamtpreis: `Posten + Arbeitsaufschlag`. (Rabatte, Fälligkeiten und Prioritäten
wurden bewusst entfernt, um die Kalkulation schlank zu halten.)

**Der Satz wird beim Speichern im Projekt eingefroren** (`workPct`). Änderst Du die
Staffel später, bleiben bestehende Aufträge bei ihrem vereinbarten Preis — sonst
würden bereits bezahlte Projekte rückwirkend auf „offen“ springen. Projekte von vor
der Einführung haben kein `workPct` und damit keinen Aufschlag; erst ein erneutes
Speichern vergibt einen.

Bedenke: Ein Prozentsatz auf den Materialwert heißt, dass dieselben 4 Stunden auf
einem 7,80-€-Auftrag 3,90 € bringen, auf einem 100-€-Auftrag aber 50 €. Wenn Arbeit
verlässlich vergütet werden soll, wäre ein €/h-Satz das passendere Modell — die
Staffel ist bewusst so gebaut, wie sie gewünscht war.

**Fehldruck / Ausschuss** (Gramm + Material) ist dieselbe Kategorie wie die
Arbeitsstunden: ein einfaches Formularfeld, aus dem automatisch ein **Zuschlag**
berechnet wird — keine manuelle Posten-Eingabe. Anders als beim Arbeitsaufschlag
wird hier aber bewusst nur **50 % des Materialwerts** verrechnet
(`FAIL_BILL_FACTOR`), da der Kunde für einen Fehldruck nicht den vollen Preis
zahlen soll. Beide Zuschläge erscheinen als eigene Zeilen direkt untereinander
in der Zusammenfassung, im Projekt und auf der Rechnung:

```
Zwischensumme:                     5.00 €
Gerät und Sonstiges (4 h → 50 %): +2.50 €
Fehldruck-Zuschlag (300 g → 50%): +3.00 €
GESAMT:                           10.50 €
```

Der Arbeitsaufschlag heißt auf der Rechnung und im Kalkulator bewusst **„Gerät und
Sonstiges“** statt „Arbeitsaufschlag“ — intern (Code, Variablen, Einstellungen)
bleibt es weiterhin der Arbeitsaufschlag/`workPct`, nur die sichtbare Beschriftung
wurde geändert.

Der volle (ungekürzte) Materialwert des Fehldrucks fließt trotzdem als echte
Produktionskosten in die interne Gewinnrechnung ein — ein zur Hälfte verrechneter
Fehldruck kann also durchaus ein Verlustgeschäft sein, und der Kalkulator zeigt
das auch so an.

**Der Zuschlag wird beim Speichern als Euro-Betrag eingefroren** (`failSurcharge`,
genau wie `workPct`). Änderst Du später den Preis des betroffenen Materials in
den Einstellungen, bleiben bereits abgerechnete Fehldrucke bei ihrem vereinbarten
Betrag — sonst würden bezahlte Projekte rückwirkend auf „offen" springen. Projekte
von vor der Einführung haben kein `failSurcharge` und damit keinen Zuschlag; erst
ein erneutes Speichern vergibt einen.

Neben Druckteil und Zubehör gibt es im Kalkulator noch **Sonstiges**: freier Text
+ Betrag für alles, was sich nicht in Material/Zeit ausdrücken lässt (Express-
Zuschlag, Verpackung, Versand …). Zählt voll zum Verkaufspreis, aber nicht zu den
Produktionskosten (reine Marge).

## Rechnungslayout

Rechnung und Sammelrechnung teilen sich dieselben Layout-Bausteine (`_pdfHeader`,
`_pdfSummary`, `_pdfStatusBadge`, `_pdfFooter`, `_pdfTableStyle` — alle unter
„PDF-LAYOUT-BAUSTEINE" im Code), damit beide Dokumente identisch aussehen:
dunkles Navy-Farbband mit Dokumenttitel, der **Kundenname groß und prominent**
links oben (bewusst kein Firmen-/Absenderblock), Rechnungs-Metadaten in einer
Box rechts, Positionstabelle, Summenblock mit hervorgehobenem Gesamtbetrag,
ein Status-Stempel („BEZAHLT" / „ZAHLUNG OFFEN") und eine schlichte Fußzeile
mit Seitenzahl auf jeder Seite.

Tabellen reservieren aktiv Platz für die Fußzeile (`margin.bottom` in
`_pdfTableStyle`, Höhe aus `_pdfFooterTop()`), damit eine lange Positionsliste
nie in den Fuß hineinläuft, sondern sauber mit wiederholter Kopfzeile auf die
nächste Seite umbricht.

Es gibt bewusst **keine Firmendaten-Einstellung** (Absender, Adresse, Bank) —
das wurde ausprobiert und auf Wunsch wieder entfernt, um die Rechnung schlank
zu halten.

## Weitere Funktionen

- **Preis-Finalisierung beim ersten Export:** Beim allerersten PDF-Export eines
  Projekts (Einzel- **oder** Sammelrechnung) wird der Preis endgültig festgeschrieben:
  Rechnungsnummer (`RE-<Jahr>-<NNNN>`, lückenlos, Zähler in `counters`), Arbeitsaufschlag-
  Prozentsatz (`workPct`) und Fehldruck-Zuschlag (`failSurcharge`) — alles zusammen in
  `_finalizePricing()`. Fehlt eines dieser Felder noch (z. B. bei Projekten von vor
  Einführung dieser Funktionen, die zwar Arbeitsstunden/Fehldruck-Gramm, aber keinen
  eingefrorenen Prozentsatz haben), wird es aus den *aktuellen* Werten (Staffel,
  Materialpreis) berechnet und dauerhaft gespeichert. Ein erneuter Export desselben
  Projekts ändert nichts mehr daran, selbst wenn sich Staffel oder Materialpreise
  später ändern.
- **Sammelrechnung:** In *Kunden* zeigt die Tabelle pro Kunde die Anzahl und Summe
  offener Projekte (Spalte „Offen“); ab einem offenen Projekt erscheint der Button
  *Sammelrechnung*. Erzeugt eine einzelne PDF mit allen offenen Projekten des Kunden
  als eigene „Unterrechnungen“ (jeweils mit Positionen, Arbeitsaufschlag/Fehldruck-
  Zuschlag als „Gerät und Sonstiges“ bzw. „Fehldruck-Zuschlag“, und Zwischensumme),
  am Ende eine Gesamtsumme über alle. Unterrechnungen bekommen dieselbe Rechnungsnummer
  wie bei Einzelexport (via `_finalizePricing()`); die Sammelrechnung selbst bekommt bei
  jeder Erstellung eine neue Nummer, da sie den *aktuellen* Stand abbildet (ändert sich,
  sobald zwischenzeitlich etwas bezahlt wird). Zeigt nur Projekte aus der aktuell
  geladenen Ansicht (aktiv oder archiviert, je nach Archiv-Filter in *Projekte*).
- **Jahresreport (PDF):** *Statistik → Report PDF* erzeugt einen vierseitigen Bericht
  mit eingebetteten Grafiken:
  1. Kennzahlen (Volumen, bezahlt, offen, Materialkosten, Rohertrag, Marge) +
     Monatstabelle + Balkendiagramm Monatsumsatz
  2. Kunden (Volumen/bezahlt/offen/Rohertrag) + Ringdiagramm Umsatzanteil +
     die 10 größten Projekte
  3. Filament-Einkauf je Material in kg, € und **Ø €/kg** + Liniendiagramm
     Einkaufspreis-Verlauf
  4. Materialverbrauch & Bestand in kg je Material (für Kunden / Eigenbedarf /
     Ausschuss / Bestand) + Balkendiagramm Materialfluss

  Die Diagramme werden als JPEG eingebettet, damit die Datei klein bleibt (~180 KB).
- **Globale Suche** (Sidebar): Projekte, Kunden und Filamentrollen in einem Feld.
- **Rollen bearbeiten:** Im Stapel-Fenster lassen sich Name, Farbe, Gewicht und Preis
  für alle Rollen des Stapels ändern (z. B. um Importnamen zu glätten).
- **Einkaufspreis-Verlauf:** Chart im Filament-Bereich zeigt €/kg je Material über die
  Zeit (ab der zweiten Rechnung).
- **Kundenportal:** Kunden sehen oben in *Projekte* eine Übersicht ihres offenen Saldos
  und laden Rechnungen pro Auftrag selbst als PDF.

## Filament & Einkauf

Die Ansicht *Filament* (nur Admin) beantwortet: Wofür ist das Filamentgeld geflossen?

Du erfasst nur die **Einkaufsseite** — Rechnung anlegen, Rollen dazu (Material, Farbe,
Gewicht, Preis). Alles andere rechnet sich aus vorhandenen Daten:

| Topf           | Woher                                                          |
| -------------- | -------------------------------------------------------------- |
| Für Kunden     | Gramm-Angaben der Projekte, **inkl. archivierter**              |
| Ausschuss      | Fehldruck-Gramm der Projekte (`fail`)                           |
| Für mich       | manuell gebuchter Eigenverbrauch                                |
| Noch auf Rollen| Einkauf minus alles Obige                                       |

Versandkosten werden anteilig nach Warenwert auf die Rollen der Rechnung umgelegt,
damit der €/kg-Preis nicht geschönt ist. Der Geldwert je Topf entsteht über den €/g
des jeweiligen Materials.

### PDF-Rechnung importieren

*Filament → Rechnungen → PDF importieren* liest eine **Bambu-Lab-Rechnung** ein
(Parsing läuft im Browser über pdf.js). Es öffnet sich ein Prüf-Fenster mit allen
erkannten Positionen: Material (automatisch zugeordnet, fehlende werden angelegt),
Bezeichnung, Farbe, Gewicht, Menge und tatsächlich gezahltem Preis pro Rolle
(Rabatte sind eingerechnet). Nichts wird gespeichert, bevor Du auf *importieren*
klickst.

- Menge > 1 legt entsprechend viele einzelne Rollen an.
- Nicht-Filament (z. B. „Bambu Reusable Spool") ist vorab abgewählt – deshalb kann
  die importierte Rechnungssumme minimal unter dem PDF-Gesamtbetrag liegen.
- Farben werden aus dem Bambu-Farbnamen abgeleitet; unbekannte bekommen einen
  neutralen Ton, den Du im Prüf-Fenster mit dem Farbwähler anpasst.
- Neu angelegte Materialien bekommen einen Standard-Verkaufspreis (20 €/kg) – der
  ist für die *Kalkulation* gedacht, nicht der Einkaufspreis, und gehört in den
  Einstellungen geprüft.

Der Parser ist auf das Bambu-Lab-Format abgestimmt. Andere Lieferanten lassen sich
weiterhin über *Neu* + Rollen von Hand erfassen.

Die Füllstände der Rollen sind nach **FIFO** geschätzt (älteste Rolle wird zuerst
leer) — Projekte buchen auf ein *Material*, nicht auf eine konkrete Rolle. Die
Füllstände sind also eine plausible Annahme, keine gemessene Wahrheit.

Steht „mehr verdruckt als eingekauft erfasst“, fehlen schlicht noch Rechnungen —
verbraucht wurde ja trotzdem. Der Bestand geht dann auf 0 statt ins Minus.

### Beispieldaten

```bash
node seed-filament.js            # anlegen
node seed-filament.js --remove   # restlos entfernen
```

Alle Beispieldatensätze tragen `DEMO` in der ID und „(Beispiel)“ im Namen; echte
Daten werden nie angefasst.

## Aufbau

| Datei              | Zweck                                                        |
| ------------------ | ------------------------------------------------------------ |
| `server.js`        | Express-API, SQLite, JWT-Auth (Token 24 h gültig)            |
| `public/index.html`| Komplettes Frontend — Vanilla JS, kein Build-Schritt          |
| `database.sqlite`  | Alle Daten. Nicht im Git — selbst sichern!                    |
| `seed-filament.js` | Beispieldaten für die Filamentverwaltung, umkehrbar           |
| `recover.js`       | Einmaliges Rettungsskript mit alten Daten, siehe Warnung      |

## Datensicherung

*Einstellungen → Export* lädt die komplette `database.sqlite` herunter.

Beim Import wird geprüft, ob die Datei überhaupt eine SQLite-Datenbank ist, und
vorher automatisch eine Sicherungskopie `database.sqlite.bak-<zeitstempel>` angelegt.
Schlägt der Import fehl, wird der alte Stand zurückgeholt.

## Warnung: recover.js

`recover.js` enthält einen fest eingebauten Datenstand von Februar 2026 und schreibt
ihn per `INSERT OR REPLACE` in die Datenbank. Ein versehentlicher Aufruf überschreibt
gleichnamige Projekte mit dem alten Stand. Nur im Notfall benutzen.

## Preise und Rundung

Positionspreise werden bei der Eingabe auf Cent gerundet, damit die angezeigten
Zeilen exakt die angezeigte Summe ergeben.

Projekte aus der Zeit davor liegen ungerundet in der Datenbank (z. B. `5.675 €`).
Deshalb gilt ein Projekt als bezahlt, sobald weniger als 5 Cent offen sind — diese
Toleranz trägt echte Altdaten und darf nicht ohne Datenmigration verschärft werden.
