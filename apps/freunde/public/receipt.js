/* ==========================================================================
   FreundeTracker – Rechnung scannen
   --------------------------------------------------------------------------
   Foto eines Kassenbons aufnehmen, den Inhalt auslesen und als Ausgabe
   übernehmen. Zwei Wege laufen dabei parallel über dasselbe Foto:

   1. Der QR-Code (RKSV/„Beleg-Check", auf jedem österreichischen Kassenbon
      gesetzlich vorgeschrieben). Sein Betrag ist signiert und damit die
      einzige wirklich verlässliche Zahl – er hat deshalb Vorrang.
   2. Texterkennung (Tesseract.js, läuft als WASM im Browser – kein
      Server-Code, kein npm, keine laufenden Kosten). Daraus entstehen die
      einzelnen Posten. Sie sind Fotoqualität ausgeliefert und deshalb
      bewusst als *Vorschlag* gedacht: alles ist nachträglich änderbar.

   Tesseract.js wird erst beim Öffnen des Scanners von einem CDN nachgeladen,
   damit der normale App-Start nichts davon mitbekommt.

   Das Belegfoto wandert über einen EIGENEN Endpunkt in die Datenbank
   (POST /api/receipts), nicht in den normalen Datenstand – sonst würde
   jedes Speichern sämtliche Fotos erneut hochladen. Die Ausgabe merkt sich
   nur die zurückgegebene receiptId.
   ========================================================================== */

const Receipt = (() => {

  const TESS_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

  let overlayBuilt = false;
  let onConfirm = null;      // Rückgabe an das Ausgaben-Formular
  let photoDataUrl = null;   // komprimiertes Foto des aktuellen Scans
  let scanFile = null;       // Rohdatei, für die optionale Texterkennung aufgehoben
  let lastQr = null;         // QR-Ergebnis des aktuellen Scans, für den erneuten Render nach OCR
  let cropRect = null;       // gewählter Bon-Ausschnitt (Anteile 0…1), null = ganzes Foto
  let cropPreviewW = 0;      // Maße der Vorschau – nur zum Umrechnen der Dekodiergröße
  let cropPreviewH = 0;

  /* Einzelposten abschaltbar. Der Gesamtbetrag ist die verlässliche Zahl
     (QR-Code bzw. gedruckte Summe-Zeile); die Postenliste hängt dagegen an
     der Fotoqualität und ist bei schlechten Aufnahmen mehr Störung als
     Hilfe. Wer sie nicht braucht, schaltet sie einmal ab – die Wahl bleibt
     gespeichert, statt sie bei jedem Scan neu wegklicken zu müssen.
     localStorage und nicht der Server: eine reine Anzeige-Vorliebe dieses
     Geräts, wie auch das Farbschema ('ft-theme'). */
  const ITEMS_PREF_KEY = 'ft-rcpt-items';
  const itemsWanted = () => localStorage.getItem(ITEMS_PREF_KEY) !== 'off';
  const rememberItemsWanted = (on) => localStorage.setItem(ITEMS_PREF_KEY, on ? 'on' : 'off');

  /* --------------------------- Beträge/Text-Helfer ------------------------- */

  // Nimmt sowohl "9,90" (Komma als Dezimaltrenner, wie auf den meisten
  // österreichischen Bons) als auch "3.87" (manche Kassen drucken mit Punkt)
  // korrekt entgegen, statt blind ein Format anzunehmen.
  function parseAmount(str) {
    str = str.replace(/\s+/g, '');
    const hasComma = str.includes(',');
    const hasDot = str.includes('.');
    let normalized;
    if (hasComma) {
      normalized = str.replace(/\./g, '').replace(',', '.');
    } else if (hasDot) {
      const parts = str.split('.');
      const decimals = parts.pop();
      normalized = parts.join('') + '.' + decimals;
    } else {
      normalized = str;
    }
    const n = parseFloat(normalized);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  }

  // Optionales Leerzeichen nach dem Dezimaltrenner toleriert – OCR liest
  // ein Komma manchmal als Punkt-plus-Leerzeichen ("0. 59" statt "0,59").
  // Führendes "-" gehört mit zum Betrag: Rabattzeilen ("-2,25") drucken
  // Kassen wie Spar als eigene, negative Zeile – ohne das Minuszeichen
  // würde der Rabatt versehentlich ADDIERT statt abgezogen.
  const AMOUNT_TOKEN = /-?\d{1,3}(?:[.,]\d{3})*[.,]\s?\d{2}/g;

  // "21.0.2017 10:05:39" / "18.04.19 16:46" – Datum+Uhrzeit sieht wegen des
  // Punkts vor zwei Ziffern wie ein Betrag aus, ist aber keiner. Große
  // Lücke toleriert – Datum und Uhrzeit stehen auf Bons oft als weit
  // auseinanderliegende Spalten in derselben Zeile.
  const DATE_TIME_RE = /\d{1,2}\.\d{1,2}\.\d{2,4}\D{0,40}\d{1,2}:\d{2}/;

  // Zeilen, die sicher KEIN Posten sind (Summen/Zahlungen/Kopf-Fuß-Zeilen).
  // "ust\b" bewusst NICHT hier drin: manche Kassen drucken die Steuerklasse
  // direkt in die Artikelzeile ("... (Ust:10%)") – das würde sonst den
  // ganzen Posten mit verschlucken. "steuer" fängt die echten Steuerzeilen
  // ("Steuersumme", "Steuer 10 %") trotzdem zuverlässig ab. "ckgeld" statt
  // "rückgeld"/"rueckgeld" einzeln, damit beide Schreibweisen greifen.
  // "rabatt"/"pfand" bewusst NICHT hier drin: auf echten Bons (Spar) sind
  // das zu zählende Posten (Pfand-Rückerstattung, Rabattzeilen mit eigenem
  // negativem Betrag), keine Störzeilen – anders als z. B. "Kassier" oder
  // "Filiale", die nie ein Preis-tragender Posten sind. Aus demselben Grund
  // steht hier "ihre ersparnis" (die Zusammenfassung im Bonfuß) statt bloß
  // "ersparnis": "Aktionsersparnis" ist eine echte Rabattzeile im
  // Artikelblock und muss mitgezählt (abgezogen) werden.
  const SKIP_RE = /(summe|gesamt|total|zu\s*zahlen|endbetrag|zwischensumme|mwst|steuer(summe)?|netto|brutto|gegeben|bar\b|bezahlt|mastercard|visa|debit|kredit|karte|tel[.:]|atu\d|uid[.:]|beleg|kassa|filiale|bon-?nr|re-?nr|pos[.:]|kassier|öffnungszeiten|www\.|http|datum|zeit:|tisch|bedien|trinkgeld|tips?\s+not|aufteilung|zahlungen|dankend erhalten|allergen|garantie|ihre rechnung|ersparnis|ckgeld|kundenbeleg|buchung|verarbeitung|trm-id|trx|auth\.?\s*code|acq-id|contactless)/i;

  // "12  x  0,75          9,00 B" (Zeilensumme folgt, Titel steht auf der
  // Zeile DAVOR – Kassensystem-Stil wie bei Spar/Rossmann) ODER schlicht
  // "3 x 1.29" ohne Zeilensumme (der Preis steht dann ganz woanders, z. B.
  // bei Billa auf einer eigenen, folgenden Artikelzeile). Beide Fälle
  // erkennt dieselbe Zeilenanfang-Prüfung, unterschieden wird weiter unten
  // in der Schleife danach, ob noch ein zweiter Betrag in der Zeile steht.
  const QTY_PREFIX_RE = /^\s*\d+([.,]\d+)?\s*[x×]\s*[\d.,]+/i;

  // "10,00%   1,81    0,18     1,99 A" – MwSt-Aufschlüsselungszeile mit
  // Steuerklassen-Buchstabe am Ende. NUMBERS_ONLY_RE (unten) greift hier
  // nicht, weil der Buchstabe kein Teil der erlaubten Zeichen ist – eigene,
  // gezielte Erkennung statt NUMBERS_ONLY_RE mit noch mehr Zeichen zu
  // überladen.
  const VAT_ROW_RE = /^\d{1,2}[.,]\d{2}\s*%/;

  // "0,180 kg x 2,49 EUR/kg" – Gewicht-mal-Kilopreis-Zeile bei Waagen-Artikeln
  // (der tatsächlich bezahlte Betrag steht auf der nächsten Zeile beim Titel).
  // Nicht an den Zeilenanfang gebunden – OCR setzt gern Müll davor
  // ("SE 0.180 kg x 2.49 EUR/kg"). Die Einheit + das Mal-Zeichen sind
  // charakteristisch genug, um die Zeile sicher zu erkennen.
  const WEIGHT_QTY_RE = /\d+([.,]\d+)?\s*(kg|g|l|ml|stk)\s*[x×]\s*[\d.,]+/i;

  // Der Signatur-Ausdruck unter dem RKSV-QR-Code ("*7841 631/018/003/024
  // 18.04.19 16:46") sieht wie ein Datum mit Betrag aus, ist aber keiner.
  const FOOTER_CODE_RE = /^\*?\d{3,6}\s+\d+\/\d+\/\d+/;

  // Reine Zahlenzeile ohne Buchstaben (Gewicht/Menge/Preis-je-kg-Zeile, wie
  // bei Waagen-Artikeln üblich – der Titel steht dort eine Zeile darüber).
  const NUMBERS_ONLY_RE = /^[\d\s.,€/kg%*-]+$/i;

  // Rabatt-/Nachlasszeilen ("%-Joker 25%", "Mengenvorteil", "Aktionsersparnis")
  // drucken Kassen als eigene Zeile mit NEGATIVEM Betrag. Das Minuszeichen ist
  // aber nur ein dünner Strich und geht bei der Texterkennung regelmäßig
  // verloren (an echten Bons belegt: "%-Joker 25% 2,25" statt "-2,25"). Dann
  // würde der Rabatt ADDIERT statt abgezogen – der Bon wäre um das Doppelte
  // des Rabatts zu hoch. Ein Rabatt ist aber nie ein Zuschlag: auf diesen
  // Zeilen zählt der Betrag deshalb immer negativ, gelesenes Minus hin oder her.
  // "ersparnis" gehört bewusst NICHT dazu: "Aktionsersparnis 0,06" ist eine
  // reine Info-Zeile ("so viel hast du gespart"), kein zweiter Abzug – der
  // echte Abzug steht eine Zeile darunter als "Prozentrabatt -0,65". Die
  // Probe steht auf dem Bon selbst: 0,06 + 0,65 = 0,71 = "Ihre Ersparnis".
  // Solche Zeilen fängt SKIP_RE ab, sie dürfen gar nicht erst zählen.
  const DISCOUNT_RE = /(joker|mengenvorteil|rabatt|nachlass)/i;

  // Zeile, die die gedruckte Endsumme trägt – zugleich das Ende des
  // Artikelblocks. "s[uv]m+e" statt schlicht "summe": an echten Scans
  // belegt, dass die Texterkennung dort Buchstaben verschluckt oder
  // verwechselt (",] sume: 6,34"). Wird die Summenzeile nicht erkannt,
  // läuft der ganze Bon-Fuß als Posten mit – der teuerste Einzelfehler,
  // den dieser Parser machen kann.
  const TOTAL_RE = /(s[uv]m+e|gesamt|total|zu\s*zahlen|endbetrag|hofer preis)/i;

  // "Zwischensumme" beendet den Artikelblock NICHT – danach geht die
  // Artikelliste weiter. Ohne diese Ausnahme würde TOTAL_RE dort zuschlagen
  // und alles danach verschlucken.
  const SUBTOTAL_RE = /zwischen/i;

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function titleFromLine(line, priceToken) {
    const cols = line.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    if (cols.length > 1) return cols[0].replace(/^\*+/, '').trim();
    const stripped = line
      .replace(new RegExp(`${escapeRe(priceToken)}\\s*[A-E]?\\s*$`), '')
      .trim();
    return (stripped || line).replace(/^\*+/, '').trim();
  }

  /** Heuristischer Parser: OCR-Rohtext -> Posten + gedruckte Summe. */
  function parseReceiptText(text) {
    const rawLines = String(text || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    /* ---------------------- Artikelblock eingrenzen ------------------------
       Der Artikelblock steht auf JEDEM Bon zwischen der Datum/Uhrzeit-
       Kopfzeile ("Ihr Einkauf am … um … Uhr", "Datum: … Zeit: …") und der
       Summe-Zeile. Davor steht der Kopf (Firma, Adresse, UID, Telefon),
       danach der Fuß (Zahlung, Rückgeld, MwSt-Tabelle, Kartenbeleg-Anhang,
       Strichcode-Nummer, Werbetext).

       Diese eine strukturelle Eingrenzung wirkt stärker als jedes weitere
       Stichwort in SKIP_RE: sie kennt keine Ausnahmen und muss nicht mit
       jedem neuen Bon-Layout mitwachsen. Genau der Müll außerhalb des Blocks
       hat bei echten Scans die Summe vervielfacht – belegt an Fotos vom
       2026-08-06: der Dateiname des Fotos wurde als Posten "6,02" gezählt,
       "RÜCKGELD 93,66" als Posten, jede einzelne MwSt-Zeile als Posten, dazu
       der komplette Kartenbeleg (Trm-Id, AID, Auth. Code, Acq-Id). Ergebnis
       damals: 119,81 € statt 6,34 €.
       --------------------------------------------------------------------- */
    // Zuerst der Kopf: alles bis einschließlich der Datum/Uhrzeit-Zeile ist
    // Firmenanschrift, UID, Telefonnummer – und bei aus der Galerie
    // gewählten Bildern auch schon mal der eingeblendete Dateiname.
    let start = 0;
    for (let i = 0; i < rawLines.length; i++) {
      if (DATE_TIME_RE.test(rawLines[i])) { start = i + 1; break; }
    }

    // Danach der Fuß: ab der Summenzeile kommt kein Artikel mehr. Bewusst
    // erst ab `start` gesucht, damit ein Wort aus dem Briefkopf die Suche
    // nicht vorzeitig beendet.
    let printedTotal = null;
    let end = rawLines.length;
    for (let i = start; i < rawLines.length; i++) {
      if (!TOTAL_RE.test(rawLines[i]) || SUBTOTAL_RE.test(rawLines[i])) continue;
      // Auch wenn der Betrag selbst unleserlich ist ("SUMME : N.14.0" – so
      // von einem echten Scan geliefert), endet der Artikelblock hier: die
      // Zeile ist zweifelsfrei die Summenzeile. Nur der Betrag fehlt dann.
      const matches = rawLines[i].match(AMOUNT_TOKEN);
      if (matches) printedTotal = parseAmount(matches[matches.length - 1]);
      end = i;
      break;
    }

    const items = [];
    let pendingTitle = null;
    // Zeilen, die mitten im Artikelblock stehen, aber keinen lesbaren Preis
    // haben (z. B. "Mars Classic 4er B SE", weil die Texterkennung "2.19"
    // als "SE" gelesen hat). Die verschwinden sonst lautlos – sichtbar
    // gemacht zeigen sie genau, an welcher Zeile der Fehlbetrag hängt.
    const unreadable = [];

    // Sieht die Zeile nach einem Artikelnamen aus (genug Buchstaben), oder
    // ist sie nur OCR-Trümmer wie "Em 06 1"? Nur Ersteres ist es wert,
    // als "Preis nicht lesbar" gemeldet zu werden.
    const looksLikeItemName = (s) => (s.match(/[A-Za-zÄÖÜäöüß]/g) || []).length >= 4;

    // Rabattzeilen zählen immer als Abzug – auch wenn das Minuszeichen beim
    // Fotografieren verlorenging (siehe DISCOUNT_RE oben).
    const priceFrom = (line, token) => {
      const value = parseAmount(token);
      if (value === null) return null;
      return DISCOUNT_RE.test(line) ? -Math.abs(value) : value;
    };

    for (let i = start; i < end; i++) {
      const line = rawLines[i];

      if (SKIP_RE.test(line)) continue;
      if (VAT_ROW_RE.test(line)) continue;
      if (WEIGHT_QTY_RE.test(line)) continue;
      if (FOOTER_CODE_RE.test(line)) continue;
      if (DATE_TIME_RE.test(line)) continue;

      // "12  x  0,75          9,00 B": zwei oder mehr Beträge in der Zeile
      // heißt, nach dem Menge-mal-Stückpreis-Teil folgt noch eine echte
      // Zeilensumme – die gehört zum Titel der VORIGEN Zeile. Nur EIN
      // Betrag ("3 x 1.29" ohne Summe dahinter) heißt: die Zeile ist reine
      // Mengenangabe, der Preis steht ganz woanders.
      if (QTY_PREFIX_RE.test(line)) {
        const matches = line.match(AMOUNT_TOKEN);
        if (matches && matches.length >= 2 && pendingTitle) {
          items.push({ title: pendingTitle, price: priceFrom(line, matches[matches.length - 1]) });
          pendingTitle = null;
        }
        continue;
      }

      if (NUMBERS_ONLY_RE.test(line) && /\d/.test(line)) {
        const matches = line.match(AMOUNT_TOKEN);
        if (matches && pendingTitle) {
          items.push({ title: pendingTitle, price: priceFrom(line, matches[matches.length - 1]) });
        }
        pendingTitle = null;
        continue;
      }

      const matches = line.match(AMOUNT_TOKEN);
      if (matches && matches.length) {
        const priceToken = matches[matches.length - 1];
        items.push({ title: titleFromLine(line, priceToken), price: priceFrom(line, priceToken) });
        pendingTitle = null;
      } else if (line.length >= 3) {
        if (pendingTitle && items.length > 0 && looksLikeItemName(pendingTitle)) {
          unreadable.push(pendingTitle);
        }
        pendingTitle = line;
      }
    }
    if (pendingTitle && items.length > 0 && looksLikeItemName(pendingTitle)) {
      unreadable.push(pendingTitle);
    }

    const itemsSum = Math.round(items.reduce((s, i) => s + (i.price || 0), 0) * 100) / 100;
    return { items, itemsSum, printedTotal, rawLines, unreadable };
  }

  /** Gleiche RKSV-Logik wie der einfache QR-Test in account.js, lokal
   *  dupliziert statt importiert – die Datei soll ohne Kopplung an andere
   *  Module entfernbar bleiben. */
  function parseRksvTotal(rawValue) {
    const tokens = String(rawValue).split('_');
    for (let i = 0; i + 5 <= tokens.length; i++) {
      const slice = tokens.slice(i, i + 5);
      // Führendes "-" muss erlaubt sein: die Beträge je Steuersatz können
      // negativ sein (Leergut-Rückgabe landet als Minusbetrag im Nullsatz –
      // auf einem echten Spar-Bon nachgewiesen: "0,00%  -1,00"). Ohne das
      // Minus findet die Suche keine fünf gültigen Felder am Stück, gibt
      // null zurück – und ausgerechnet bei diesen Bons fällt der Betrag
      // still auf die unzuverlässige OCR-Summe zurück, statt den signierten
      // QR-Betrag zu nehmen.
      if (!slice.every((t) => /^-?\d{1,3}(\.\d{3})*,\d{2}$/.test(t))) continue;
      const sum = slice.reduce((s, t) => s + Number(t.replace(/\./g, '').replace(',', '.')), 0);
      return Math.round(sum * 100) / 100;
    }
    return null;
  }

  /* ------------------------------- Bildverarbeitung ------------------------ */

  /* -------------------------- Speicher-Haushalt ---------------------------
     Handyfotos haben 12+ Megapixel. Wird so ein Bild mehrfach dekodiert und
     dazu noch pixelweise kopiert, killt der Browser den Tab ("Zu wenig
     Speicher") – auf echten Geräten reproduziert. Deshalb hier drei Regeln:

     1. GENAU EINMAL dekodieren, schon beim Dekodieren verkleinern
        (resizeWidth), und dieses eine Bild für alles weiterverwenden.
     2. Kontrast über den Canvas-Filter der Grafikkarte statt über
        getImageData – letzteres zieht eine komplette zweite Pixelkopie.
     3. Jedes Zwischenbild sofort freigeben (close() bzw. Größe auf 0),
        insbesondere BEVOR die Texterkennung ihren eigenen Speicher holt.
     ---------------------------------------------------------------------- */

  // navigator.deviceMemory gibt es nicht überall (u. a. auf vielen Android-
  // Chrome-Konfigurationen nicht verfügbar) – „|| 8" hätte bei fehlender
  // Angabe fälschlich den GROSSZÜGIGEN Fall angenommen, also ausgerechnet
  // auf Geräten ohne diese Angabe die riskantesten Maße gewählt. Umgedreht:
  // unbekannt zählt jetzt als „eher wenig Speicher", nicht als „viel".
  const LOW_MEMORY   = (navigator.deviceMemory ?? 3) <= 4;
  // Diese Maße waren zwischenzeitlich auf 850–1200px heruntergedreht, weil
  // wir einen Absturz für ein Speicherproblem hielten. Das war ein Irrtum
  // (siehe Notiz in handleFile): der Absturz kam von der Kamera-App im
  // Vordergrund, nicht von der Bildgröße.
  //
  // DECODE_WIDTH richtet sich bewusst nach dem QR-CODE, nicht nach der
  // Schrift: der QR-Code ist auf dem Gesamtfoto nur ein kleiner Ausschnitt
  // und wird unterhalb von ~2000px schlicht nicht mehr gefunden. Und sein
  // Betrag ist die einzige signierte, wirklich verlässliche Zahl auf dem
  // ganzen Bon – die darf nicht an einer zu klein gewählten Vorlage
  // scheitern. Das große Bild lebt nur kurz: Archivfoto und OCR-Bild werden
  // daraus heruntergerechnet, danach wird es sofort freigegeben, noch bevor
  // die Texterkennung ihren eigenen Speicher anfordert.
  const DECODE_WIDTH = LOW_MEMORY ? 2000 : 2400;   // Vorlage, am QR-Code bemessen
  const OCR_WIDTH    = LOW_MEMORY ? 1300 : 1600;   // fein genug für Bon-Schrift
  const PHOTO_WIDTH  = LOW_MEMORY ? 700  : 850;    // Archivfoto
  const PREVIEW_WIDTH = 900;                       // nur zum Rahmen-Ziehen

  /* Obergrenze für das kurzzeitig entstehende Ausgangsbild, in Bildpunkten
     statt in Breite gerechnet: bei einem zugeschnittenen Bon wird bewusst
     GRÖSSER dekodiert als sonst (siehe cropDecodeWidth) – ohne eine harte
     Obergrenze könnte ein sehr enger Zuschnitt eine absurde Dekodiergröße
     verlangen und genau den Speicherabsturz zurückholen, den wir mühsam
     losgeworden sind. */
  const PIXEL_BUDGET = LOW_MEMORY ? 8e6 : 14e6;

  /**
   * Wie breit muss das GANZE Foto dekodiert werden, damit der ausgeschnittene
   * Bon hinterher DECODE_WIDTH breit ist?
   *
   * Nimmt der Bon nur 40 % der Bildbreite ein (typisch, wenn Tisch und
   * Umgebung mit drauf sind), landen bei 2400 px nur ~960 px auf dem Bon
   * selbst. Dekodiert man das Gesamtbild größer und schneidet heraus, holt
   * man sich diese Bildpunkte zurück.
   *
   * ABER: die Obergrenze ist immer die Auflösung des Originalfotos. Ist der
   * Bon dort 1200 px breit, sind 1200 px das Maximum – größer dekodieren
   * heißt dann nur noch hochrechnen und bringt gar nichts. Deshalb ist der
   * Auflösungsgewinn durch das Zuschneiden begrenzt (grob +20…35 %); der
   * größere Nutzen liegt darin, dass Text aus dem Hintergrund gar nicht erst
   * mitgelesen wird.
   *
   * PIXEL_BUDGET deckelt das Ganze, damit ein sehr enger Rahmen keine
   * absurde Dekodiergröße verlangt.
   */
  function cropDecodeWidth(crop, previewW, previewH) {
    if (!crop) return DECODE_WIDTH;
    const wanted = DECODE_WIDTH / Math.max(0.15, crop.w);
    const maxByBudget = Math.sqrt(PIXEL_BUDGET * (previewW / previewH));
    return Math.round(Math.max(DECODE_WIDTH, Math.min(wanted, maxByBudget)));
  }

  /**
   * Dekodiert das Foto ein einziges Mal, direkt verkleinert. Bei Fehlschlag
   * wird es IMMER KLEINER probiert, nie größer – ein Fehlschlag ist auf
   * einem schwachen Gerät eher ein Speicherproblem als ein Formatproblem,
   * und ein unverkleinerter Rückfall auf die volle Auflösung wäre da die
   * denkbar schlechteste Reaktion.
   */
  async function decodePhoto(file, width) {
    const widths = [width, Math.round(width * 0.66), Math.round(width * 0.4)];
    for (const w of widths) {
      try {
        return await createImageBitmap(file, {
          imageOrientation: 'from-image',
          resizeWidth: w,
          resizeQuality: 'low'
        });
      } catch { /* nächste, kleinere Stufe versuchen */ }
    }
    // Letzter Versuch ganz ohne Optionen – nur falls resizeWidth selbst auf
    // diesem Gerät der Stolperstein war, nicht die Größe.
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      throw new Error('Das Foto konnte nicht gelesen werden. Vielleicht ist es zu groß – versuch es mit einer kleineren Aufnahme oder weniger Zoom.');
    }
  }

  /**
   * Zeichnet aus einer Bildquelle eine Arbeitskopie, wahlweise nur einen
   * Ausschnitt. `source` darf ein ImageBitmap ODER ein Canvas sein – beides
   * kann drawImage verarbeiten und beides hat width/height. Dadurch lässt
   * sich erst zuschneiden und danach aus dem Ausschnitt weiterverkleinern,
   * ohne das große Ausgangsbild länger als nötig festzuhalten.
   *
   * `crop` sind Anteile (0…1) des bereits richtig gedrehten Bildes – bewusst
   * relativ und nicht in Bildpunkten, weil Vorschau und Ausgangsbild
   * unterschiedlich groß sind.
   */
  function canvasFrom(source, width, { contrast = false, crop = null } = {}) {
    const sx = crop ? Math.round(crop.x * source.width) : 0;
    const sy = crop ? Math.round(crop.y * source.height) : 0;
    const sw = crop ? Math.max(1, Math.round(crop.w * source.width)) : source.width;
    const sh = crop ? Math.max(1, Math.round(crop.h * source.height)) : source.height;

    const scale = Math.min(1, width / sw);
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    // Graustufen + Kontrast: Kassenbons sind eigentlich hoher Kontrast
    // (dunkler Druck auf hellem Thermopapier), das Foto glättet das weg.
    if (contrast) ctx.filter = 'grayscale(1) contrast(1.35) brightness(1.05)';
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
    return canvas;
  }

  /** Gibt den Bildspeicher eines Canvas frei. */
  function release(canvas) {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
  }

  async function detectQr(canvas) {
    if (!('BarcodeDetector' in window)) return { supported: false };
    try {
      const supported = await BarcodeDetector.getSupportedFormats();
      if (!supported.includes('qr_code')) return { supported: false };
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const codes = await detector.detect(canvas);
      if (!codes.length) return { supported: true, found: false };
      const rawValue = codes[0].rawValue;
      return { supported: true, found: true, rawValue, total: parseRksvTotal(rawValue) };
    } catch {
      return { supported: true, found: false, error: true };
    }
  }

  async function loadTesseract() {
    if (window.Tesseract) return window.Tesseract;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = TESS_CDN;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Tesseract.js konnte nicht geladen werden – Internetverbindung nötig.'));
      document.head.appendChild(script);
    });
    if (!window.Tesseract) throw new Error('Tesseract.js hat sich nicht wie erwartet initialisiert.');
    return window.Tesseract;
  }

  async function runOcr(canvas, onProgress) {
    const Tesseract = await loadTesseract();
    const worker = await Tesseract.createWorker('deu', 1, {
      logger: (msg) => {
        if (msg.status === 'recognizing text' && typeof msg.progress === 'number') {
          onProgress(Math.round(msg.progress * 100));
        }
      }
    });
    try {
      const { data } = await worker.recognize(canvas);
      return data.text;
    } finally {
      await worker.terminate();
    }
  }

  /* ---------------------------------- UI ------------------------------------ */

  function ensureOverlay() {
    if (overlayBuilt) return;
    overlayBuilt = true;

    const style = document.createElement('style');
    style.textContent = `
      .rcpt-overlay {
        position: fixed; inset: 0; z-index: 60;
        display: flex; align-items: flex-end; justify-content: center;
        background: color-mix(in srgb, black 45%, transparent);
      }
      .rcpt-sheet {
        width: 100%; max-width: 560px; max-height: 92vh;
        background: var(--bg); border-radius: var(--radius) var(--radius) 0 0;
        box-shadow: var(--shadow); display: flex; flex-direction: column; overflow: hidden;
      }
      .rcpt-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 16px 18px; border-bottom: 1px solid color-mix(in srgb, var(--text) 10%, transparent);
      }
      .rcpt-head h2 { margin: 0; font-family: var(--font-display); font-size: 1.15rem; }
      .rcpt-body { padding: 18px; overflow-y: auto; }

      /* Übernehmen liegt rechts und ist der einzige farbige Knopf – man
         sieht auf einen Blick, was der Weg nach vorn ist. */
      .rcpt-actions { display: flex; gap: 10px; margin-top: 4px; }
      .rcpt-actions .btn { flex: 1 1 0; }
      .rcpt-actions .btn-primary { flex: 1.4 1 0; }

      .rcpt-hero-static { font-family: var(--font-display); font-size: 2rem; font-weight: 600; }
      .rcpt-view-items { display: flex; flex-direction: column; gap: 2px; margin-bottom: 18px; }
      .rcpt-item-unshared { opacity: .6; }
      .rcpt-item-unshared small { font-size: .75rem; }
      .rcpt-photo {
        display: block; width: 100%; border-radius: var(--radius);
        margin-bottom: 18px; box-shadow: var(--shadow-soft);
      }
      .rcpt-intro { color: var(--text-dim); font-size: .92rem; margin: 0 0 16px; line-height: 1.5; }
      .rcpt-progress {
        display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 26px 10px; text-align: center;
      }
      .rcpt-spinner {
        width: 34px; height: 34px; border-radius: 50%;
        border: 3px solid color-mix(in srgb, var(--accent) 25%, transparent);
        border-top-color: var(--accent); animation: rcpt-spin 0.8s linear infinite;
      }
      @keyframes rcpt-spin { to { transform: rotate(360deg); } }
      /* Gesamtbetrag als Blickfang – die einzige Zahl, die (per QR-Code)
         wirklich verlässlich ist, soll man sofort sehen und antippen können. */
      .rcpt-hero {
        background: var(--surface); border-radius: var(--radius); padding: 16px 18px 14px;
        box-shadow: var(--shadow-soft); margin-bottom: 20px;
        border: 1px solid color-mix(in srgb, var(--text) 8%, transparent);
      }
      .rcpt-hero.is-trusted { border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
      .rcpt-hero-label { color: var(--text-dim); font-size: .82rem; }
      .rcpt-hero-amount { display: flex; align-items: baseline; gap: 6px; margin-top: 2px; }
      .rcpt-hero-input {
        flex: 1 1 auto; min-width: 0; width: 100%;
        font-family: var(--font-display); font-size: 2rem; font-weight: 600;
        color: var(--text); background: none; border: none; padding: 0;
        border-bottom: 2px dashed color-mix(in srgb, var(--text) 18%, transparent);
      }
      .rcpt-hero-input:focus {
        outline: none; border-bottom-style: solid; border-bottom-color: var(--accent);
      }
      .rcpt-hero-cur { font-family: var(--font-display); font-size: 1.5rem; color: var(--text-dim); }
      .rcpt-hero-source { display: block; margin-top: 8px; font-size: .8rem; color: var(--text-dim); }
      .rcpt-hero.is-trusted .rcpt-hero-source { color: var(--accent); }

      /* Kopfzeile: erster leerer Platzhalter rückt "Bezeichnung" auf Höhe des
         Titelfelds (nach dem Häkchen-Platz), die letzten beiden Spalten
         passen in der Breite zu Anzahl- und Preisfeld darunter. */
      .rcpt-head-row {
        display: flex; align-items: center; gap: 8px; padding: 0 12px 6px;
        font-size: .76rem; color: var(--text-dim);
      }
      .rcpt-head-row:not(.rcpt-head-row-simple) span:nth-child(1) { width: 26px; flex: 0 0 auto; }
      .rcpt-head-row:not(.rcpt-head-row-simple) span:nth-child(2) { flex: 1 1 auto; }
      .rcpt-head-row:not(.rcpt-head-row-simple) span:nth-child(3) { width: 40px; flex: 0 0 auto; text-align: center; }
      .rcpt-head-row:not(.rcpt-head-row-simple) span:nth-child(4) { width: 92px; flex: 0 0 auto; text-align: right; }
      .rcpt-head-row-simple span:first-child { flex: 1 1 auto; }
      .rcpt-head-row-simple span:last-child { width: 92px; text-align: right; }

      .rcpt-rows { display: flex; flex-direction: column; gap: 10px; }
      .rcpt-row-inputs { display: flex; align-items: center; gap: 8px; }
      .rcpt-row-qty-note { margin: 3px 0 0 34px; font-size: .74rem; color: var(--text-dim); }

      /* Häkchen: was nicht geteilt wird, hakt man ab. Grosszuegige Trefferflaeche,
         damit es sich am Handy mit dem Daumen sicher treffen laesst. */
      .rcpt-check { position: relative; flex: 0 0 auto; width: 26px; height: 40px; cursor: pointer; }
      .rcpt-check input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
      .rcpt-check span {
        position: absolute; top: 50%; left: 0; transform: translateY(-50%);
        width: 22px; height: 22px; border-radius: 7px;
        border: 1.5px solid color-mix(in srgb, var(--text) 28%, transparent);
        background: var(--surface);
      }
      .rcpt-check input:checked + span {
        background: var(--accent); border-color: var(--accent);
      }
      .rcpt-check input:checked + span::after {
        content: ''; position: absolute; left: 7px; top: 3px;
        width: 6px; height: 11px; border: solid var(--accent-ink);
        border-width: 0 2px 2px 0; transform: rotate(45deg);
      }
      .rcpt-check input:focus-visible + span { border-color: var(--accent); }
      /* Abgehakte Zeile sichtbar zurücknehmen, ohne sie zu verstecken.
         WICHTIG: auf die Checkbox einschränken – "input:not(:checked)"
         allein trifft auch die Text- und Preisfelder (die sind nie
         "checked"), dann wäre JEDE Zeile durchgestrichen. */
      .rcpt-row:has(.rcpt-check input:not(:checked)) .rcpt-in {
        opacity: .5;
        text-decoration: line-through;
      }
      .rcpt-balance small { font-size: .78rem; opacity: .8; }
      .rcpt-in {
        font-family: var(--font-body); font-size: .95rem; color: var(--text);
        background: var(--surface); border: 1px solid transparent;
        border-radius: 10px; padding: 11px 12px; min-width: 0;
      }
      .rcpt-in:focus { outline: none; border-color: var(--accent); background: var(--surface); }
      .rcpt-in-title { flex: 1 1 auto; }
      .rcpt-in-qty {
        width: 40px; flex: 0 0 auto; text-align: center; padding: 11px 2px;
        font-family: var(--font-display);
      }
      .rcpt-in-price {
        width: 92px; flex: 0 0 auto; text-align: right;
        font-family: var(--font-display);
      }
      .rcpt-in-price::placeholder { font-family: var(--font-body); }
      .rcpt-del {
        flex: 0 0 auto; width: 30px; height: 30px; border: none; background: none;
        color: var(--text-dim); border-radius: 50%; cursor: pointer; padding: 6px;
      }
      .rcpt-del svg { width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
      .rcpt-del:active { background: var(--surface-2); }

      .rcpt-add {
        width: 100%; margin-top: 10px; padding: 11px; cursor: pointer;
        font-family: var(--font-body); font-size: .9rem; color: var(--accent);
        background: none; border: 1px dashed color-mix(in srgb, var(--accent) 35%, transparent);
        border-radius: 10px;
      }
      .rcpt-add:active { background: color-mix(in srgb, var(--accent) 8%, transparent); }

      /* Schalter für die Postenliste. Bewusst als Schiebeschalter und nicht
         als weitere Checkbox: er steuert einen ganzen Abschnitt, nicht eine
         einzelne Zeile – das soll man auch sehen. */
      .rcpt-toggle {
        display: flex; align-items: center; gap: 11px; cursor: pointer;
        margin-bottom: 16px; font-size: .92rem; color: var(--text);
      }
      .rcpt-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
      .rcpt-toggle-track {
        flex: 0 0 auto; position: relative; width: 42px; height: 24px; border-radius: 999px;
        background: color-mix(in srgb, var(--text) 20%, transparent);
        transition: background .18s ease;
      }
      .rcpt-toggle-track::after {
        content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px;
        border-radius: 50%; background: var(--bg); transition: transform .18s ease;
      }
      .rcpt-toggle input:checked + .rcpt-toggle-track { background: var(--accent); }
      .rcpt-toggle input:checked + .rcpt-toggle-track::after { transform: translateX(18px); }
      .rcpt-toggle input:focus-visible + .rcpt-toggle-track {
        outline: 2px solid var(--accent); outline-offset: 2px;
      }
      .rcpt-toggle-off-note { margin: -6px 0 18px; font-size: .82rem; color: var(--text-dim); }

      /* ---------------------------- Zuschneiden ---------------------------
         touch-action: none ist hier keine Feinheit, sondern Bedingung: ohne
         das scrollt das Handy die Seite, statt den Rahmen zu ziehen. */
      .rcpt-crop {
        position: relative; overflow: hidden; touch-action: none;
        border-radius: var(--radius); margin-bottom: 16px; background: var(--surface-2, #000);
      }
      .rcpt-crop img { display: block; width: 100%; height: auto; user-select: none; -webkit-user-drag: none; }
      /* Abdunkeln außerhalb des Rahmens über einen riesigen Schlagschatten –
         spart ein zweites Element und passt sich jeder Rahmengröße an. */
      .rcpt-crop-box {
        position: absolute; box-sizing: border-box;
        border: 2px solid #fff; box-shadow: 0 0 0 9999px rgba(0, 0, 0, .55);
        cursor: move;
      }
      .rcpt-crop-grip {
        position: absolute; width: 34px; height: 34px;   /* Daumengröße, nicht Mauszeigergröße */
        display: flex; align-items: center; justify-content: center;
      }
      .rcpt-crop-grip::after {
        content: ''; width: 18px; height: 18px; border: 3px solid #fff; border-radius: 3px;
        background: rgba(0, 0, 0, .25);
      }
      .rcpt-crop-grip[data-grip="nw"] { top: -17px; left: -17px; cursor: nwse-resize; }
      .rcpt-crop-grip[data-grip="ne"] { top: -17px; right: -17px; cursor: nesw-resize; }
      .rcpt-crop-grip[data-grip="sw"] { bottom: -17px; left: -17px; cursor: nesw-resize; }
      .rcpt-crop-grip[data-grip="se"] { bottom: -17px; right: -17px; cursor: nwse-resize; }

      /* Nur sichtbar, wenn die automatische Texterkennung fehlgeschlagen ist –
         der Gesamtbetrag steht trotzdem schon, deshalb ruhig platziert statt
         als Vollbild-Fehler. */
      .rcpt-ocr-offer { margin: 0 0 20px; text-align: center; }
      .rcpt-ocr-offer .rcpt-add { margin-top: 0; }
      .rcpt-ocr-hint { margin: 8px 0 0; font-size: .78rem; color: var(--text-dim); }
      .rcpt-ocr-error {
        margin: 0 0 10px; padding: 10px 12px; border-radius: 10px;
        background: color-mix(in srgb, var(--neg) 10%, var(--surface));
        color: var(--neg); font-size: .85rem; text-align: left;
      }

      .rcpt-balance {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        margin: 16px 0 18px; padding: 12px 14px; border-radius: var(--radius);
        background: var(--surface); font-size: .88rem; color: var(--text-dim);
      }
      .rcpt-balance strong { font-family: var(--font-display); color: var(--text); }
      .rcpt-balance.is-ok { background: color-mix(in srgb, var(--pos) 12%, var(--surface)); }
      .rcpt-balance.is-ok strong { color: var(--pos); }
      .rcpt-balance.is-open { background: color-mix(in srgb, var(--neg) 10%, var(--surface)); }
      .rcpt-fill {
        flex: 0 0 auto; cursor: pointer; padding: 7px 11px; border-radius: 999px;
        font-family: var(--font-body); font-size: .82rem;
        color: var(--neg); background: color-mix(in srgb, var(--neg) 14%, var(--surface));
        border: none; text-align: right;
      }
      .rcpt-fill:active { filter: brightness(.94); }
      .rcpt-raw { margin-bottom: 16px; }
      .rcpt-raw summary { cursor: pointer; color: var(--text-dim); font-size: .85rem; }
      .rcpt-raw pre {
        white-space: pre-wrap; word-break: break-word; font-size: .8rem; color: var(--text-dim);
        background: var(--surface); border-radius: 10px; padding: 10px; margin-top: 8px; max-height: 220px; overflow-y: auto;
      }
    `;
    document.head.appendChild(style);

    const wrap = document.createElement('div');
    wrap.id = 'receiptOverlay';
    wrap.className = 'rcpt-overlay';
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="rcpt-sheet">
        <div class="rcpt-head">
          <h2 id="rcptHeadTitle">Rechnung scannen</h2>
          <button class="icon-btn" id="rcptClose" type="button" aria-label="Schließen">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="rcpt-body" id="rcptBody"></div>
      </div>
    `;
    document.body.appendChild(wrap);

    wrap.querySelector('#rcptClose').addEventListener('click', close);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.getElementById('receiptOverlay').hidden) close();
    });
  }

  function renderIdle() {
    const body = document.getElementById('rcptBody');
    body.innerHTML = `
      <p class="rcpt-intro">
        Bon fotografieren – am besten von oben, sodass der QR-Code am
        unteren Ende mit drauf ist. Gesamtbetrag und Posten werden
        automatisch ausgelesen; ändern kannst du danach alles.
      </p>
      <!-- Zwei getrennte Datei-Inputs statt einem umgeschalteten: die
           Kamera-Variante trägt capture="environment" (springt direkt in
           die Kamera-App), die Galerie-Variante bewusst nicht – auf
           manchen Handys reisst das Starten der Kamera-App den Browser-Tab
           im Hintergrund mit (Android killt ihn unter Speicherdruck,
           während die Kamera-App vorne läuft). Beide Wege bleiben nutzbar,
           die Galerie ist der Ausweg, falls die Kamera-Variante abstürzt. -->
      <input type="file" accept="image/*" capture="environment" id="rcptCameraInput" hidden>
      <input type="file" accept="image/*" id="rcptFileInput" hidden>
      <button class="btn btn-primary btn-block" type="button" id="rcptPickBtn">Bon fotografieren</button>
      <button class="btn btn-ghost btn-block" type="button" id="rcptGalleryBtn">Aus Galerie wählen</button>
      <p class="rcpt-ocr-hint">
        Wird der Browser beim Fotografieren immer wieder neu gestartet?
        Nimm das Foto stattdessen mit der normalen Kamera-App auf und
        wähle es hier danach aus der Galerie.
      </p>
    `;
    body.querySelector('#rcptPickBtn').addEventListener('click', () => body.querySelector('#rcptCameraInput').click());
    body.querySelector('#rcptGalleryBtn').addEventListener('click', () => body.querySelector('#rcptFileInput').click());
    const onPicked = (e) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    };
    body.querySelector('#rcptCameraInput').addEventListener('change', onPicked);
    body.querySelector('#rcptFileInput').addEventListener('change', onPicked);
  }

  function renderProgress(message) {
    const body = document.getElementById('rcptBody');
    body.innerHTML = `
      <div class="rcpt-progress">
        <div class="rcpt-spinner"></div>
        <p>${esc(message)}</p>
      </div>
    `;
  }

  /**
   * Rahmen um den Bon ziehen, bevor gelesen wird.
   *
   * Der Grund ist handfest: auf echten Fotos füllt der Bon oft nur einen
   * Teil des Bildes, der Rest ist Tisch, Bildschirm oder Fensterbank. Ohne
   * Zuschnitt verteilt sich die verfügbare Auflösung über das ganze Bild und
   * die Texterkennung liest den Hintergrund mit – beobachtet wurden dadurch
   * Phantom-Posten wie „N PS PARK" und sogar der eingeblendete Dateiname des
   * Fotos als Betrag. Der Zuschnitt wirkt doppelt: mehr Bildpunkte auf der
   * Schrift UND kein Hintergrundtext mehr im Ergebnis.
   *
   * @param onDone  bekommt den Ausschnitt als Anteile {x,y,w,h} – oder null
   *                für „ganzes Foto".
   */
  function renderCrop(previewUrl, onDone) {
    const body = document.getElementById('rcptBody');
    // Startrahmen: hochkant und leicht eingerückt – das trifft die typische
    // Bonform schon ganz gut, meist muss man nur nachjustieren.
    const rect = { x: 0.12, y: 0.06, w: 0.76, h: 0.88 };

    body.innerHTML = `
      <p class="rcpt-intro">
        Zieh den Rahmen so, dass möglichst nur der Bon darin liegt –
        je genauer, desto besser wird der Text erkannt.
      </p>
      <div class="rcpt-crop" id="rcptCropArea">
        <img src="${esc(previewUrl)}" alt="Aufgenommenes Foto" draggable="false">
        <div class="rcpt-crop-box" id="rcptCropBox">
          <span class="rcpt-crop-grip" data-grip="nw"></span>
          <span class="rcpt-crop-grip" data-grip="ne"></span>
          <span class="rcpt-crop-grip" data-grip="sw"></span>
          <span class="rcpt-crop-grip" data-grip="se"></span>
        </div>
      </div>
      <div class="rcpt-actions">
        <button class="btn btn-ghost" type="button" id="rcptCropAll">Ganzes Foto</button>
        <button class="btn btn-primary" type="button" id="rcptCropGo">Weiter</button>
      </div>
    `;

    const area = body.querySelector('#rcptCropArea');
    const box = body.querySelector('#rcptCropBox');

    const MIN = 0.12;   // kleiner als ein Achtel wird der Rahmen nicht
    const clamp01 = (v) => Math.min(1, Math.max(0, v));

    function draw() {
      box.style.left   = `${rect.x * 100}%`;
      box.style.top    = `${rect.y * 100}%`;
      box.style.width  = `${rect.w * 100}%`;
      box.style.height = `${rect.h * 100}%`;
    }
    draw();

    let drag = null;

    area.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest('.rcpt-crop-grip');
      const onBox = e.target.closest('.rcpt-crop-box');
      if (!grip && !onBox) return;   // Tipp neben den Rahmen ändert nichts

      const bounds = area.getBoundingClientRect();
      drag = {
        grip: grip ? grip.dataset.grip : null,
        bounds,
        // Beim Verschieben merken, wo im Rahmen man angefasst hat – sonst
        // springt der Rahmen unter den Finger statt mitzugehen.
        offX: (e.clientX - bounds.left) / bounds.width - rect.x,
        offY: (e.clientY - bounds.top) / bounds.height - rect.y
      };
      area.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    area.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const px = clamp01((e.clientX - drag.bounds.left) / drag.bounds.width);
      const py = clamp01((e.clientY - drag.bounds.top) / drag.bounds.height);

      if (!drag.grip) {
        // Verschieben: Größe bleibt, Position wird an den Rand angehalten.
        rect.x = Math.min(1 - rect.w, Math.max(0, px - drag.offX));
        rect.y = Math.min(1 - rect.h, Math.max(0, py - drag.offY));
      } else {
        // Größe ändern: die jeweils gegenüberliegende Ecke bleibt stehen.
        const right = rect.x + rect.w;
        const bottom = rect.y + rect.h;
        if (drag.grip.includes('w')) { rect.x = Math.min(px, right - MIN);  rect.w = right - rect.x; }
        if (drag.grip.includes('e')) { rect.w = Math.max(MIN, px - rect.x); }
        if (drag.grip.includes('n')) { rect.y = Math.min(py, bottom - MIN); rect.h = bottom - rect.y; }
        if (drag.grip.includes('s')) { rect.h = Math.max(MIN, py - rect.y); }
        rect.w = Math.min(rect.w, 1 - rect.x);
        rect.h = Math.min(rect.h, 1 - rect.y);
      }
      draw();
      e.preventDefault();
    });

    const stop = (e) => {
      if (!drag) return;
      drag = null;
      area.releasePointerCapture?.(e.pointerId);
    };
    area.addEventListener('pointerup', stop);
    area.addEventListener('pointercancel', stop);

    body.querySelector('#rcptCropGo').addEventListener('click', () => onDone({ ...rect }));
    body.querySelector('#rcptCropAll').addEventListener('click', () => onDone(null));
  }

  function renderError(message) {
    const body = document.getElementById('rcptBody');
    body.innerHTML = `
      <p class="scan-result is-error">${esc(message)}</p>
      <button class="btn btn-ghost btn-block" type="button" id="rcptRetry">Nochmal versuchen</button>
    `;
    body.querySelector('#rcptRetry').addEventListener('click', renderIdle);
  }

  /* ------------------------- Eingabemaske (bearbeitbar) -------------------- */

  // Beträge im Formular immer deutsch anzeigen ("2,19"), aber beim Tippen
  // beide Schreibweisen annehmen – niemanden zwingen, das Komma zu suchen.
  const fmt = (n) => (n === null || n === undefined || Number.isNaN(n)) ? '' : n.toFixed(2).replace('.', ',');
  const num = (s) => {
    const v = parseFloat(String(s).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  };

  const parseQty = (s) => {
    const n = parseInt(String(s).replace(/\D/g, ''), 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  };

  /**
   * Eine Postenzeile. Das Häkchen entscheidet, ob der Posten mitgeteilt
   * wird – abgehakte Posten (z. B. was nur einem selbst gehört) werden vom
   * Gesamtbetrag abgezogen, statt die Postenliste zu verlassen. Die Anzahl
   * lässt sich hochzählen (z. B. "1 Wurstsemmel" → "2"), der Preis daneben
   * bleibt der Stückpreis – was das für die Zeile insgesamt macht, steht
   * bei mehr als 1 Stück direkt als kleine Rechnung dabei.
   */
  function rowHtml(title, price, checked = true, qty = 1) {
    return `
      <div class="rcpt-row">
        <div class="rcpt-row-inputs">
          <label class="rcpt-check">
            <input type="checkbox" ${checked ? 'checked' : ''} aria-label="Posten mitteilen">
            <span aria-hidden="true"></span>
          </label>
          <input class="rcpt-in rcpt-in-title" type="text" value="${esc(title || '')}"
                 placeholder="Bezeichnung" aria-label="Bezeichnung">
          <input class="rcpt-in rcpt-in-qty" type="text" inputmode="numeric"
                 value="${qty}" aria-label="Anzahl" title="Anzahl">
          <input class="rcpt-in rcpt-in-price" type="text" inputmode="decimal"
                 value="${price === null || price === undefined ? '' : fmt(price)}"
                 placeholder="0,00" aria-label="Preis pro Stück">
          <button class="rcpt-del" type="button" aria-label="Zeile entfernen">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="rcpt-row-qty-note" hidden></div>
      </div>
    `;
  }

  /** Zeigt "2 × 2,50 € = 5,00 €" unter der Zeile, aber nur wenn Anzahl > 1. */
  function updateQtyNote(row) {
    const qty = parseQty(row.querySelector('.rcpt-in-qty').value);
    const price = num(row.querySelector('.rcpt-in-price').value);
    const note = row.querySelector('.rcpt-row-qty-note');
    if (qty > 1 && price !== null) {
      note.hidden = false;
      note.textContent = `${qty} × ${fmt(price)} € = ${fmt(Math.round(qty * price * 100) / 100)} €`;
    } else {
      note.hidden = true;
    }
  }

  function renderResult({ qr, text, parsed, ocrDone = true, ocrError = null }) {
    const body = document.getElementById('rcptBody');

    const useItems = itemsWanted();

    // Der QR-Betrag ist die einzige Zahl, die signiert und damit verlässlich
    // ist – er hat deshalb Vorrang vor der (per OCR gelesenen) Summe-Zeile.
    // Die Postensumme ist nur die letzte Notlösung, und wer die Posten
    // abgeschaltet hat, will sie erst recht nicht als Gesamtbetrag: dann
    // lieber ein leeres Feld zum Selbst-Eintragen als eine erratene Zahl.
    const itemsFallback = useItems ? (parsed.itemsSum || null) : null;
    const total = qr.total ?? parsed.printedTotal ?? itemsFallback;
    const source = qr.total !== null && qr.total !== undefined
      ? { label: 'aus dem QR-Code gelesen', trusted: true }
      : parsed.printedTotal !== null
        ? { label: 'aus der gedruckten Summe-Zeile', trusted: false }
        : itemsFallback !== null
          ? { label: 'aus den Posten berechnet', trusted: false }
          : { label: 'nicht erkannt – bitte selbst eintragen', trusted: false };

    // Zeilen ohne lesbaren Preis kommen mit leerem Preisfeld rein, statt zu
    // verschwinden – dann muss man nur die eine Zahl nachtragen.
    const rows = [
      ...parsed.items.map((i) => ({ title: i.title, price: i.price })),
      ...(parsed.unreadable || []).map((t) => ({ title: t, price: null }))
    ];
    if (rows.length === 0) rows.push({ title: '', price: null });

    // Ohne ocrDone ist die Texterkennung fehlgeschlagen (sie läuft jetzt
    // automatisch, "!ocrDone" bedeutet also immer: hat nicht geklappt).
    // Der Gesamtbetrag (meist aus dem QR-Code) steht trotzdem schon fest.
    const ocrOfferHtml = !ocrDone ? `
      <div class="rcpt-ocr-offer">
        <p class="rcpt-ocr-error">${esc(ocrError || 'Die Texterkennung hat nicht geklappt – der Gesamtbetrag bleibt trotzdem stehen.')}</p>
        <button class="rcpt-add" type="button" id="rcptRunOcr">Nochmal versuchen</button>
      </div>` : '';

    body.innerHTML = `
      <div class="rcpt-hero ${source.trusted ? 'is-trusted' : ''}">
        <span class="rcpt-hero-label">Gesamtbetrag</span>
        <div class="rcpt-hero-amount">
          <input class="rcpt-hero-input" id="rcptTotal" type="text" inputmode="decimal"
                 value="${fmt(total)}" placeholder="0,00" aria-label="Gesamtbetrag">
          <span class="rcpt-hero-cur">€</span>
        </div>
        <span class="rcpt-hero-source">${source.trusted ? '✓ ' : ''}${esc(source.label)}</span>
      </div>

      ${ocrOfferHtml}

      <label class="rcpt-toggle">
        <input type="checkbox" id="rcptUseItems" ${useItems ? 'checked' : ''}>
        <span class="rcpt-toggle-track" aria-hidden="true"></span>
        <span>Einzelposten übernehmen</span>
      </label>
      <p class="rcpt-toggle-off-note" id="rcptItemsOffNote" ${useItems ? 'hidden' : ''}>
        Es wird nur der Gesamtbetrag übernommen.
      </p>

      <div id="rcptItemsBlock" ${useItems ? '' : 'hidden'}>
        <div class="rcpt-head-row">
          <span></span>
          <span>Bezeichnung</span>
          <span>Anzahl</span>
          <span>Preis/Stk</span>
        </div>
        <div class="rcpt-rows" id="rcptRows">${rows.map((r) => rowHtml(r.title, r.price)).join('')}</div>

        <button class="rcpt-add" type="button" id="rcptAdd">+ Posten hinzufügen</button>

        <div class="rcpt-balance" id="rcptBalance"></div>
      </div>

      ${ocrDone ? `
        <details class="rcpt-raw">
          <summary>Erkannter Rohtext (OCR)</summary>
          <pre>${esc(text || '(leer)')}</pre>
        </details>` : ''}

      <div class="rcpt-actions">
        <button class="btn btn-ghost" type="button" id="rcptAgain">Neues Foto</button>
        <button class="btn btn-primary" type="button" id="rcptConfirm">Übernehmen</button>
      </div>
    `;

    body.querySelector('#rcptRunOcr')?.addEventListener('click', runTextRecognition);

    const rowsEl = body.querySelector('#rcptRows');
    const totalEl = body.querySelector('#rcptTotal');
    const balanceEl = body.querySelector('#rcptBalance');
    const useItemsEl = body.querySelector('#rcptUseItems');
    const itemsBlock = body.querySelector('#rcptItemsBlock');
    const offNote = body.querySelector('#rcptItemsOffNote');

    useItemsEl.addEventListener('change', () => {
      const on = useItemsEl.checked;
      rememberItemsWanted(on);
      itemsBlock.hidden = !on;
      offNote.hidden = on;
    });

    // "Preis" ist der Stückpreis, die Zeile zählt qty-mal – bei Anzahl 1
    // (der Normalfall) ist das exakt das bisherige Verhalten.
    const priceOf = (row) => {
      const unit = num(row.querySelector('.rcpt-in-price').value) || 0;
      const qty = parseQty(row.querySelector('.rcpt-in-qty').value);
      return Math.round(unit * qty * 100) / 100;
    };
    const isChecked = (row) => row.querySelector('.rcpt-check input').checked;
    const allRows = () => [...rowsEl.querySelectorAll('.rcpt-row')];

    function currentSum() {
      return Math.round(allRows().reduce((s, r) => s + priceOf(r), 0) * 100) / 100;
    }

    /** Summe der abgehakten Posten – die zahlt jemand allein. */
    function excludedSum() {
      return Math.round(
        allRows().filter((r) => !isChecked(r)).reduce((s, r) => s + priceOf(r), 0) * 100
      ) / 100;
    }

    /**
     * Was am Ende als Ausgabe übernommen wird. Bewusst „Gesamtbetrag minus
     * Abgehaktes" statt „Summe der angehakten Posten": Hat die Texterkennung
     * eine Zeile verschluckt, bliebe sonst genau dieser Betrag unter den
     * Tisch fallen. So stimmt der Betrag auch bei lückenhaft gelesenen Bons.
     */
    function sharedTotal() {
      const goal = num(totalEl.value);
      // Ohne Postenliste gibt es nichts abzuhaken und nichts zu summieren –
      // dann zählt allein der Betrag, der oben steht.
      if (!useItemsEl.checked) return goal ?? 0;
      const base = goal === null ? currentSum() : goal;
      return Math.round((base - excludedSum()) * 100) / 100;
    }

    // Läuft bei jedem Tastendruck – deshalb bewusst NUR diese eine Zeile neu
    // schreiben und nie die Eingabefelder selbst, sonst springt der Cursor.
    function updateBalance() {
      const sum = currentSum();
      const goal = num(totalEl.value);
      const excluded = excludedSum();

      // Sobald etwas abgehakt ist, zählt nur noch, was tatsächlich geteilt
      // wird – das ist dann die Zahl, die den Nutzer interessiert.
      if (excluded > 0) {
        balanceEl.className = 'rcpt-balance is-ok';
        balanceEl.innerHTML =
          `<span>Wird geteilt<br><small>${euro(excluded)} nicht geteilt</small></span>` +
          `<strong>${euro(sharedTotal())}</strong>`;
        return;
      }

      if (goal === null) {
        balanceEl.className = 'rcpt-balance';
        balanceEl.innerHTML = `<span>Posten zusammen</span><strong>${euro(sum)}</strong>`;
        return;
      }
      const diff = Math.round((goal - sum) * 100) / 100;
      if (Math.abs(diff) <= 0.02) {
        balanceEl.className = 'rcpt-balance is-ok';
        balanceEl.innerHTML = `<span>Posten zusammen</span><strong>${euro(sum)} ✓</strong>`;
        return;
      }
      balanceEl.className = 'rcpt-balance is-open';
      balanceEl.innerHTML = `
        <span>Posten zusammen <strong>${euro(sum)}</strong></span>
        <button class="rcpt-fill" type="button" id="rcptFill">
          ${diff > 0 ? `${euro(diff)} fehlen – ergänzen` : `${euro(-diff)} zu viel`}
        </button>
      `;
      const fill = balanceEl.querySelector('#rcptFill');
      if (fill && diff > 0) {
        fill.addEventListener('click', () => {
          addRow('', diff);
          updateBalance();
        });
      }
    }

    function addRow(title, price, checked = true, qty = 1) {
      rowsEl.insertAdjacentHTML('beforeend', rowHtml(title, price, checked, qty));
      const added = rowsEl.lastElementChild;
      updateQtyNote(added);
      added.querySelector('.rcpt-in-title').focus();
    }

    rowsEl.addEventListener('input', (e) => {
      const row = e.target.closest('.rcpt-row');
      if (row && (e.target.classList.contains('rcpt-in-qty') || e.target.classList.contains('rcpt-in-price'))) {
        updateQtyNote(row);
      }
      updateBalance();
    });
    rowsEl.addEventListener('change', updateBalance);   // Häkchen
    totalEl.addEventListener('input', updateBalance);

    // Beim Verlassen eines Feldes sauber formatieren ("2.5" -> "2,50", eine
    // leere/kaputte Anzahl -> "1"), aber niemals währenddessen – das würde
    // beim Tippen dazwischenfunken.
    body.addEventListener('blur', (e) => {
      if (e.target.classList?.contains('rcpt-in-qty')) {
        e.target.value = String(parseQty(e.target.value));
        return;
      }
      if (!e.target.classList?.contains('rcpt-in-price') && e.target.id !== 'rcptTotal') return;
      const v = num(e.target.value);
      e.target.value = v === null ? '' : fmt(v);
    }, true);

    rowsEl.addEventListener('click', (e) => {
      const del = e.target.closest('.rcpt-del');
      if (!del) return;
      del.closest('.rcpt-row').remove();
      if (!rowsEl.children.length) addRow('', null);
      updateBalance();
    });

    body.querySelector('#rcptAdd').addEventListener('click', () => {
      addRow('', null);
      updateBalance();
    });
    body.querySelector('#rcptAgain').addEventListener('click', renderIdle);

    body.querySelector('#rcptConfirm').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      // Abgehakte Posten kommen mit ins Beleg-Archiv (shared: false), zählen
      // aber nicht zum geteilten Betrag – der Bon bleibt so vollständig.
      // Sind die Einzelposten ganz abgeschaltet, wandert bewusst auch nichts
      // ins Archiv: eine halb erratene Postenliste, die niemand geprüft hat,
      // wäre dort später irreführender als gar keine.
      const rows = !useItemsEl.checked ? [] : allRows()
        .map((r) => {
          const qty = parseQty(r.querySelector('.rcpt-in-qty').value);
          const unitPrice = num(r.querySelector('.rcpt-in-price').value);
          return {
            title: r.querySelector('.rcpt-in-title').value.trim(),
            qty,
            // "price" bleibt aus Sicht des restlichen Archivs die Zeilensumme
            // (Stückpreis × Anzahl) – so muss nichts anderes wissen, dass es
            // eine Anzahl überhaupt gibt.
            price: unitPrice === null ? null : Math.round(unitPrice * qty * 100) / 100,
            shared: isChecked(r)
          };
        })
        .filter((r) => r.title || r.price !== null);

      const chosenTotal = sharedTotal();

      btn.disabled = true;
      btn.textContent = 'Beleg wird gespeichert …';

      // Beleg speichern ist Komfort, kein Selbstzweck: klappt es nicht,
      // wird die Ausgabe trotzdem übernommen – nur eben ohne Foto.
      let receiptId = null;
      try {
        // Im Beleg steht der ECHTE Rechnungsbetrag, nicht der geteilte Anteil –
        // sonst passt das Archiv später nicht mehr zum Foto daneben.
        const saved = await Store.saveReceipt({
          photo: photoDataUrl,
          items: rows,
          // Ohne Postenliste gibt es keine Postensumme, auf die man
          // zurückfallen könnte – dann bleibt nur der eingetippte Betrag.
          total: num(totalEl.value) ?? (useItemsEl.checked ? currentSum() : 0)
        });
        receiptId = saved?.id || null;
      } catch (error) {
        console.warn('Beleg konnte nicht gespeichert werden:', error.message);
      }

      const callback = onConfirm;
      const photo = photoDataUrl;   // close() räumt den Zwischenspeicher auf
      close();
      callback?.({
        total: chosenTotal, items: rows, receiptId, photo,
        shop: shopFromText(text), savedPhoto: Boolean(receiptId)
      });
    });

    allRows().forEach(updateQtyNote);
    updateBalance();
  }

  /** Bekannte Ketten aus dem Rohtext – füllt den Titel der Ausgabe vor. */
  function shopFromText(text) {
    const SHOPS = ['Billa', 'Spar', 'Hofer', 'Lidl', 'Penny', 'Merkur', 'MPreis', 'Denns', 'DM', 'Bipa', 'Müller', 'Interspar'];
    const upper = String(text || '').toUpperCase();
    const hit = SHOPS.find((s) => upper.includes(s.toUpperCase()));
    return hit || null;
  }

  const emptyParsed = () => ({ items: [], itemsSum: 0, printedTotal: null, unreadable: [] });

  /**
   * Liest QR-Code UND Text in einem durchgehenden Ablauf, automatisch –
   * kein Extra-Klick nötig. Trotzdem bewusst als zwei getrennte Bilder
   * nacheinander (nicht gleichzeitig im Speicher): erst QR-Code + Archivfoto
   * aus einem Foto-Dekodierdurchgang, danach das große Ausgangsbild
   * freigegeben, BEVOR die Texterkennung ihren eigenen (großen) Speicher
   * anfordert. Scheitert nur die Texterkennung, geht der Gesamtbetrag
   * (meist aus dem QR-Code, unabhängig davon schon ermittelt) nicht
   * verloren – dann kommt die QR-Ansicht mit einer Wiederholen-Möglichkeit.
   */
  /**
   * Erster Schritt nach dem Foto: kleine Vorschau zeigen und den Bon
   * eingrenzen lassen. Die Vorschau ist bewusst winzig (PREVIEW_WIDTH) – zum
   * Rahmenziehen reicht das, und das große Bild entsteht erst danach, in
   * genau der Größe, die der gewählte Ausschnitt braucht.
   */
  async function handleFile(file) {
    scanFile = file;
    let preview = null;

    try {
      renderProgress('Foto wird vorbereitet …');
      preview = await decodePhoto(file, PREVIEW_WIDTH);
      const previewCanvas = canvasFrom(preview, PREVIEW_WIDTH);
      const previewUrl = previewCanvas.toDataURL('image/jpeg', 0.75);
      const previewW = preview.width;
      const previewH = preview.height;
      release(previewCanvas);
      preview.close?.();
      preview = null;

      cropPreviewW = previewW;
      cropPreviewH = previewH;

      renderCrop(previewUrl, (crop) => {
        cropRect = crop;
        processFile(file, crop, previewW, previewH);
      });
    } catch (error) {
      preview?.close?.();
      renderError(error.message || 'Beim Auslesen ist etwas schiefgelaufen.');
    }
  }

  async function processFile(file, crop, previewW, previewH) {
    let bitmap = null;
    let scanCanvas = null;
    let ocrCanvas = null;

    try {
      renderProgress('Foto wird vorbereitet …');
      bitmap = await decodePhoto(file, cropDecodeWidth(crop, previewW, previewH));

      // Ausschnitt herausrechnen und das große Ausgangsbild SOFORT freigeben –
      // ab hier arbeitet alles nur noch auf dem (kleineren) Bon-Ausschnitt.
      // Das senkt den Höchststand an belegtem Speicher gegenüber vorher sogar,
      // obwohl größer dekodiert wurde.
      scanCanvas = canvasFrom(bitmap, DECODE_WIDTH, { crop });
      bitmap.close?.();
      bitmap = null;

      renderProgress('QR-Code wird gesucht …');
      const qr = await detectQr(scanCanvas);
      lastQr = qr;

      const photoCanvas = canvasFrom(scanCanvas, PHOTO_WIDTH);
      photoDataUrl = photoCanvas.toDataURL('image/jpeg', 0.7);
      release(photoCanvas);

      ocrCanvas = canvasFrom(scanCanvas, OCR_WIDTH, { contrast: true });
      release(scanCanvas);
      scanCanvas = null;

      try {
        renderProgress('Text wird erkannt … 0%');
        const text = await runOcr(ocrCanvas, (pct) => renderProgress(`Text wird erkannt … ${pct}%`));
        release(ocrCanvas);
        ocrCanvas = null;

        const parsed = parseReceiptText(text);
        renderResult({ qr, text, parsed, ocrDone: true });
      } catch (ocrError) {
        renderResult({
          qr, text: '', parsed: emptyParsed(), ocrDone: false,
          ocrError: 'Die Texterkennung hat nicht geklappt – der Gesamtbetrag bleibt trotzdem stehen.'
        });
      }
    } catch (error) {
      renderError(error.message || 'Beim Auslesen ist etwas schiefgelaufen.');
    } finally {
      bitmap?.close?.();
      release(scanCanvas);
      release(ocrCanvas);
    }
  }

  /** Erneuter Versuch der Texterkennung nach einem Fehlschlag (Knopf in der Fehlermeldung). */
  async function runTextRecognition() {
    if (!scanFile) return;
    let bitmap = null;
    let ocrCanvas = null;

    try {
      renderProgress('Foto wird vorbereitet …');
      // Denselben Ausschnitt wie beim ersten Durchgang verwenden – sonst
      // liefe der zweite Versuch auf einem anderen Bild als der erste.
      bitmap = await decodePhoto(scanFile, cropDecodeWidth(cropRect, cropPreviewW, cropPreviewH));
      ocrCanvas = canvasFrom(bitmap, OCR_WIDTH, { contrast: true, crop: cropRect });
      bitmap.close?.();
      bitmap = null;

      renderProgress('Text wird erkannt … 0%');
      const text = await runOcr(ocrCanvas, (pct) => renderProgress(`Text wird erkannt … ${pct}%`));
      release(ocrCanvas);
      ocrCanvas = null;

      const parsed = parseReceiptText(text);
      // Der beim ersten Durchgang gelesene QR-Betrag gilt weiter – er wird
      // hier bewusst NICHT neu ermittelt: er ist signiert und ändert sich
      // nicht, nur die Texterkennung wird wiederholt.
      renderResult({ qr: lastQr || { supported: false }, text, parsed, ocrDone: true });
    } catch (error) {
      renderResult({
        qr: lastQr || { supported: false }, text: '', parsed: emptyParsed(), ocrDone: false,
        ocrError: 'Die Texterkennung hat wieder nicht geklappt – der Gesamtbetrag bleibt trotzdem stehen.'
      });
    } finally {
      bitmap?.close?.();
      release(ocrCanvas);
    }
  }

  /* ------------------------------ Beleg ansehen ---------------------------- */

  /** Zeigt einen bereits gespeicherten Beleg (Foto + Posten) schreibgeschützt. */
  async function view(receiptId) {
    ensureOverlay();
    document.getElementById('receiptOverlay').hidden = false;
    document.body.style.overflow = 'hidden';
    document.getElementById('rcptHeadTitle').textContent = 'Beleg';
    renderProgress('Beleg wird geladen …');

    try {
      const receipt = await Store.getReceipt(receiptId);
      const body = document.getElementById('rcptBody');
      body.innerHTML = `
        <div class="rcpt-hero is-trusted">
          <span class="rcpt-hero-label">Gesamtbetrag</span>
          <div class="rcpt-hero-amount">
            <span class="rcpt-hero-static">${euro(receipt.total || 0)}</span>
          </div>
        </div>
        ${receipt.items.length ? `
          <div class="rcpt-head-row rcpt-head-row-simple"><span>Bezeichnung</span><span>Preis</span></div>
          <div class="rcpt-view-items">
            ${receipt.items.map((i) => `
              <div class="rcpt-item-row${i.shared === false ? ' rcpt-item-unshared' : ''}">
                <span>${i.qty > 1 ? `${i.qty}× ` : ''}${esc(i.title || '—')}${i.shared === false ? ' <small>(nicht geteilt)</small>' : ''}</span>
                <span>${i.price === null || i.price === undefined ? '—' : euro(i.price)}</span>
              </div>
            `).join('')}
          </div>` : '<p class="rcpt-intro">Keine einzelnen Posten gespeichert.</p>'}
        ${receipt.photo ? `<img class="rcpt-photo" src="${esc(receipt.photo)}" alt="Foto des Belegs">` : ''}
        <button class="btn btn-ghost btn-block" type="button" id="rcptViewClose">Schließen</button>
      `;
      body.querySelector('#rcptViewClose').addEventListener('click', close);
    } catch (error) {
      renderError(error.message || 'Beleg konnte nicht geladen werden.');
    }
  }

  /**
   * @param callback  bekommt { total, items, receiptId, shop } nach dem
   *                  Bestätigen – das Ausgaben-Formular füllt sich daraus.
   */
  function open(callback) {
    ensureOverlay();
    onConfirm = typeof callback === 'function' ? callback : null;
    photoDataUrl = null;
    scanFile = null;
    lastQr = null;
    cropRect = null;
    cropPreviewW = 0;
    cropPreviewH = 0;
    document.getElementById('rcptHeadTitle').textContent = 'Rechnung scannen';
    renderIdle();
    document.getElementById('receiptOverlay').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function close() {
    const el = document.getElementById('receiptOverlay');
    if (el) el.hidden = true;
    onConfirm = null;
    photoDataUrl = null;
    scanFile = null;
    lastQr = null;
    cropRect = null;
    cropPreviewW = 0;
    cropPreviewH = 0;
    // Der Scanner wird aus dem Ausgaben-Formular heraus geöffnet, das
    // dahinter offen bleibt und seine eigene Sperre verwaltet.
    if (document.getElementById('sheet').hidden) {
      document.body.style.overflow = '';
    }
  }

  return { open, close, view, parseReceiptText, parseAmount, parseRksvTotal };
})();

// Isomorph nutzbar für Node-Tests des Parsers, ohne das Browser-Verhalten
// zu beeinflussen (im Browser ist `module` nicht definiert).
if (typeof module !== 'undefined') module.exports = Receipt;
