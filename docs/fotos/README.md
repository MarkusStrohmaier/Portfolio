# PictureSort

Fotos und Videos per Drag & Drop einwerfen — die App sortiert sie nach dem
Aufnahmedatum in Ordner wie `20260707`, `20260808`, `20260809` und schreibt sie
entweder direkt in einen Zielordner oder in ein ZIP-Archiv.

Alles läuft lokal im Browser. Es wird nichts hochgeladen und keine Datei am
Ursprungsort verändert oder gelöscht — es wird immer kopiert.

## Starten

`start.cmd` doppelklicken. Es startet einen kleinen lokalen Server und öffnet
<http://127.0.0.1:8765/> im Standardbrowser, sobald der Server bereit ist. Ist
der Port belegt, wird automatisch der nächste freie genommen — die tatsächliche
Adresse steht im Konsolenfenster. Das Fenster offen lassen, solange die App
benutzt wird; beenden mit `Strg+C`.

Empfohlener Browser: **Chrome oder Edge** — nur dort kann die App direkt in
einen gewählten Ordner schreiben. In Firefox/Safari funktioniert der
ZIP-Download.

## Bedienung

1. Dateien **oder ganze Ordner** in das Feld ziehen (Unterordner werden
   mitgelesen). Alternativ die Buttons „Dateien wählen“ / „Ordner wählen“.
2. In der Vorschau prüfen: pro Datumsordner werden Anzahl, Größe und die
   einzelnen Dateien mit Uhrzeit und Herkunft des Datums angezeigt.
3. Speichern:
   * **In Ordner speichern** — Zielordner auswählen, die Datumsordner werden
     dort angelegt und die Dateien hineinkopiert.
   * **Als ZIP speichern** — ein Archiv, das dieselbe Ordnerstruktur enthält.

## Woher das Datum kommt

Geprüft wird in dieser Reihenfolge (umstellbar in den Optionen):

| Quelle  | Bedeutung |
|---------|-----------|
| `EXIF`  | Aufnahmezeit aus dem Bild (JPEG, PNG, WebP, TIFF/RAW, HEIC) |
| `Video` | Aufnahmezeit aus den MP4/MOV-Metadaten (`©day`, sonst `mvhd`) |
| `Name`  | Datum im Dateinamen, z. B. `IMG_20260707_142311`, `IMG-20260808-WA0012`, `2026-07-07 14.23.11`, `PXL_20260707_...` |
| `Datei` | Änderungsdatum der Datei (letzter Ausweg) |

Unplausible Werte (etwa das Jahr 1904, das viele Kameras in leere
Video-Metadaten schreiben) werden verworfen und die nächste Quelle wird
verwendet. Dateien, für die gar kein Datum ermittelbar ist, landen im Ordner
„Ohne Datum“.

## Optionen

* **Gruppieren nach** — Tag (`20260707`), Tag mit Bindestrich (`2026-07-07`),
  Monat (`202607`), Jahr/Monat (`2026/07`) oder Jahr (`2026`).
* **Datum ermitteln aus** — Metadaten bevorzugen, Dateiname bevorzugen oder
  ausschließlich das Änderungsdatum verwenden.
* **Nur Fotos & Videos übernehmen** — andere Dateien werden ignoriert und
  unter der Liste aufgeführt.
* **Unterordner „Fotos“/„Videos“** — trennt Bilder und Videos innerhalb jedes
  Datumsordners.
* **Vorhandene Dateien überspringen** — beim Schreiben in einen Ordner werden
  namens- und größengleiche Dateien nicht erneut kopiert. So kann man denselben
  Zielordner mehrfach befüllen. Gleichnamige Dateien mit abweichendem Inhalt
  bekommen automatisch den Zusatz `(2)`, `(3)`, …

## Hinweise

* Der Zeitstempel im ZIP entspricht dem erkannten Aufnahmedatum. Beim Kopieren
  in einen Ordner setzt Windows dagegen die aktuelle Uhrzeit als Änderungsdatum
  — der Browser darf Dateizeiten nicht setzen. Das Datum steckt aber weiterhin
  im Ordnernamen und in den EXIF-Daten.
* Sehr große Mengen sind kein Problem: Dateien werden gestreamt, nicht
  vollständig in den Arbeitsspeicher geladen. Auch ZIPs über 4 GB werden
  korrekt erzeugt (ZIP64).
* Beim Abbrechen bleiben bereits kopierte Dateien erhalten.

## Dateien im Projekt

| Datei | Zweck |
|-------|-------|
| `index.html`, `css/style.css` | Oberfläche |
| `js/app.js` | Ablauf: Einlesen, Vorschau, Speichern |
| `js/datefinder.js` | Datumserkennung (EXIF, MP4/MOV, Dateiname) |
| `js/zip.js` | ZIP-Erzeugung inkl. ZIP64, ohne Fremdbibliotheken |
| `start.cmd` | Startet den lokalen Server (nimmt Python, sonst Node.js) |
| `launch.py` | Server-Variante für Python |
| `server.js` | Server-Variante für Node.js |
