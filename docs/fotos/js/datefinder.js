// Ermittelt das Aufnahmedatum einer Datei aus:
//   1. Metadaten  - EXIF (JPEG/TIFF/RAW/PNG/WebP/HEIC) bzw. MP4/MOV-Boxen
//   2. Dateinamen - IMG_20260707_..., 2026-07-07, IMG-20260707-WA0001, ...
//   3. Aenderungsdatum der Datei (lastModified)

const MIN_TIME = new Date(1990, 0, 1).getTime();
const maxTime = () => Date.now() + 366 * 24 * 3600 * 1000;

const IMAGE_EXT = /\.(jpe?g|jpe|png|gif|bmp|webp|tiff?|heic|heif|avif|dng|cr2|cr3|nef|arw|orf|rw2|raf|srw|pef|jxl|svg)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|3gp|3g2|avi|mkv|webm|mts|m2ts|mpg|mpeg|wmv|flv|insv|hevc)$/i;

export const isImage = (name) => IMAGE_EXT.test(name);
export const isVideo = (name) => VIDEO_EXT.test(name);
export const isMedia = (name) => isImage(name) || isVideo(name);

function plausible(date) {
  if (!date || isNaN(date.getTime())) return null;
  const t = date.getTime();
  return t >= MIN_TIME && t <= maxTime() ? date : null;
}

/** Baut ein Date aus "Wanduhr"-Komponenten (bereits lokale Aufnahmezeit). */
function wallClock(y, mo, d, h = 0, mi = 0, s = 0) {
  if (!y || !mo || !d || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(y, mo - 1, d, h, mi, s);
  // Ueberlauf abfangen (z.B. 31.02.)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return plausible(date);
}

// ---------------------------------------------------------------- Dateiname

const NAME_PATTERNS = [
  // 20260707_123456 / IMG_20260707_123456 / PXL_20260707_123456789 / VID-20260707-WA0001
  /(?:^|[^0-9])(\d{4})(\d{2})(\d{2})[_\-. T]?(\d{2})(\d{2})(\d{2})(?![0-9])/,
  // 2026-07-07 12.34.56 / 2026_07_07-12_34_56 / 2026.07.07 12-34-56
  /(?:^|[^0-9])(\d{4})[-_.](\d{2})[-_.](\d{2})[ _T-]+(\d{2})[-_.:](\d{2})[-_.:](\d{2})(?![0-9])/,
  // 2026-07-07 (nur Datum)
  /(?:^|[^0-9])(\d{4})[-_.](\d{2})[-_.](\d{2})(?![0-9])/,
  // 20260707 (nur Datum, z.B. IMG-20260707-WA0001)
  /(?:^|[^0-9])(\d{4})(\d{2})(\d{2})(?![0-9])/,
  // Unix-Timestamp in Millisekunden (13-stellig)
  /(?:^|[^0-9])(1[0-9]{12})(?![0-9])/,
];

export function dateFromName(name) {
  for (let i = 0; i < NAME_PATTERNS.length; i++) {
    const m = name.match(NAME_PATTERNS[i]);
    if (!m) continue;
    if (i === NAME_PATTERNS.length - 1) {
      const d = plausible(new Date(Number(m[1])));
      if (d) return d;
      continue;
    }
    const d = wallClock(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    if (d) return d;
  }
  return null;
}

// -------------------------------------------------------------------- EXIF

/** "2026:07:07 12:34:56" -> Date (als lokale Wanduhrzeit) */
function parseExifDate(str) {
  const m = String(str).trim().match(/^(\d{4})[:\-.](\d{2})[:\-.](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return wallClock(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
}

const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;

function readAscii(view, offset, count) {
  let out = '';
  for (let i = 0; i < count; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out;
}

/** Liest DateTimeOriginal aus einem TIFF-Header (Basis von EXIF). */
function parseTiff(view, base) {
  if (base + 8 > view.byteLength) return null;
  const byteOrder = view.getUint16(base, false);
  let le;
  if (byteOrder === 0x4949) le = true;
  else if (byteOrder === 0x4d4d) le = false;
  else return null;
  if (view.getUint16(base + 2, le) !== 42) return null;

  const found = {};
  const readIfd = (ifdOffset, depth) => {
    const start = base + ifdOffset;
    if (depth > 3 || start + 2 > view.byteLength) return;
    const count = view.getUint16(start, le);
    if (start + 2 + count * 12 > view.byteLength) return;
    for (let i = 0; i < count; i++) {
      const entry = start + 2 + i * 12;
      const tag = view.getUint16(entry, le);
      const type = view.getUint16(entry + 2, le);
      const num = view.getUint32(entry + 4, le);
      if (tag === TAG_EXIF_IFD && (type === 4 || type === 13)) {
        readIfd(view.getUint32(entry + 8, le), depth + 1);
        continue;
      }
      if (tag !== TAG_DATETIME && tag !== TAG_DATETIME_ORIGINAL && tag !== TAG_DATETIME_DIGITIZED) continue;
      if (type !== 2 || num < 19) continue;
      const valueOffset = num <= 4 ? entry + 8 : base + view.getUint32(entry + 8, le);
      if (valueOffset + num > view.byteLength) continue;
      found[tag] = readAscii(view, valueOffset, num);
    }
  };
  readIfd(view.getUint32(base + 4, le), 0);

  return (
    parseExifDate(found[TAG_DATETIME_ORIGINAL]) ||
    parseExifDate(found[TAG_DATETIME_DIGITIZED]) ||
    parseExifDate(found[TAG_DATETIME]) ||
    null
  );
}

/** Sucht die Signatur "Exif\0\0" im Puffer (Fallback z.B. fuer HEIC/AVIF). */
function findExifSignature(bytes) {
  for (let i = 0; i < bytes.length - 6; i++) {
    if (
      bytes[i] === 0x45 && bytes[i + 1] === 0x78 && bytes[i + 2] === 0x69 &&
      bytes[i + 3] === 0x66 && bytes[i + 4] === 0x00 && bytes[i + 5] === 0x00
    ) {
      return i + 6;
    }
  }
  return -1;
}

function parseJpeg(view, bytes) {
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = bytes[pos + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // Bilddaten beginnen
    const len = view.getUint16(pos + 2, false);
    if (len < 2) break;
    if (marker === 0xe1 && pos + 4 + 6 <= bytes.length) {
      const sig = String.fromCharCode(...bytes.slice(pos + 4, pos + 10));
      if (sig === 'Exif\0\0') {
        const date = parseTiff(view, pos + 10);
        if (date) return date;
      }
    }
    pos += 2 + len;
  }
  return null;
}

function parsePng(view, bytes) {
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos, false);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const dataStart = pos + 8;
    if (dataStart + len > bytes.length) break;
    if (type === 'eXIf') {
      const date = parseTiff(view, dataStart);
      if (date) return date;
    }
    if (type === 'tEXt' || type === 'iTXt') {
      const text = new TextDecoder('latin1').decode(bytes.subarray(dataStart, dataStart + len));
      if (/^Creation Time/i.test(text)) {
        const value = text.split('\0').filter(Boolean).pop();
        const d = parseExifDate(value) || plausible(new Date(value));
        if (d) return d;
      }
    }
    if (type === 'IDAT' || type === 'IEND') break;
    pos = dataStart + len + 4;
  }
  return null;
}

function parseWebp(view, bytes) {
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const type = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    const len = view.getUint32(pos + 4, true);
    const dataStart = pos + 8;
    if (dataStart + len > bytes.length) break;
    if (type === 'EXIF') {
      let base = dataStart;
      if (String.fromCharCode(...bytes.slice(dataStart, dataStart + 6)) === 'Exif\0\0') base += 6;
      const date = parseTiff(view, base);
      if (date) return date;
    }
    pos = dataStart + len + (len % 2);
  }
  return null;
}

async function readImageDate(file) {
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, 3 * 1024 * 1024)).arrayBuffer());
  if (head.length < 12) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);

  if (head[0] === 0xff && head[1] === 0xd8) return parseJpeg(view, head);
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return parsePng(view, head);
  if (
    String.fromCharCode(head[0], head[1], head[2], head[3]) === 'RIFF' &&
    String.fromCharCode(head[8], head[9], head[10], head[11]) === 'WEBP'
  ) {
    return parseWebp(view, head);
  }
  // TIFF und die meisten RAW-Formate beginnen direkt mit dem TIFF-Header.
  if ((head[0] === 0x49 && head[1] === 0x49) || (head[0] === 0x4d && head[1] === 0x4d)) {
    const date = parseTiff(view, 0);
    if (date) return date;
  }
  // HEIC/AVIF und Sonderfaelle: EXIF-Signatur suchen.
  const sig = findExifSignature(head);
  if (sig >= 0) return parseTiff(view, sig);
  return null;
}

// ----------------------------------------------------------- MP4 / QuickTime

/** Iteriert die Boxen zwischen start und end, ohne die Datei komplett zu laden. */
async function* iterBoxes(file, start, end, budget) {
  let pos = start;
  while (pos + 8 <= end && budget.reads-- > 0) {
    const head = new DataView(await file.slice(pos, Math.min(pos + 16, end)).arrayBuffer());
    if (head.byteLength < 8) return;
    let size = head.getUint32(0, false);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    let headerLen = 8;
    if (size === 1) {
      if (head.byteLength < 16) return;
      size = Number(head.getBigUint64(8, false));
      headerLen = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerLen || pos + size > end) {
      yield { type, dataStart: pos + headerLen, dataEnd: end };
      return;
    }
    yield { type, dataStart: pos + headerLen, dataEnd: pos + size };
    pos += size;
  }
}

async function findBox(file, start, end, wanted, budget) {
  for await (const box of iterBoxes(file, start, end, budget)) {
    if (box.type === wanted) return box;
  }
  return null;
}

/** mvhd: Sekunden seit 1904-01-01 UTC. */
async function readMvhd(file, moov, budget) {
  const mvhd = await findBox(file, moov.dataStart, moov.dataEnd, 'mvhd', budget);
  if (!mvhd) return null;
  const buf = new DataView(await file.slice(mvhd.dataStart, Math.min(mvhd.dataStart + 24, mvhd.dataEnd)).arrayBuffer());
  if (buf.byteLength < 12) return null;
  const version = buf.getUint8(0);
  let seconds;
  if (version === 1) {
    if (buf.byteLength < 12) return null;
    seconds = Number(buf.getBigUint64(4, false));
  } else {
    seconds = buf.getUint32(4, false);
  }
  if (!seconds) return null;
  return plausible(new Date((seconds - 2082844800) * 1000));
}

/** udta/©day bzw. meta/ilst/©day: ISO-Datum inkl. Zeitzone der Kamera. */
async function readCreationDay(file, moov, budget) {
  const udta = await findBox(file, moov.dataStart, moov.dataEnd, 'udta', budget);
  if (!udta) return null;
  const candidates = [udta];
  const meta = await findBox(file, udta.dataStart, udta.dataEnd, 'meta', budget);
  if (meta) {
    const ilst = await findBox(file, meta.dataStart + 4, meta.dataEnd, 'ilst', budget);
    if (ilst) candidates.push(ilst);
  }
  for (const scope of candidates) {
    for await (const box of iterBoxes(file, scope.dataStart, scope.dataEnd, budget)) {
      if (box.type !== '©day' && box.type !== 'date') continue;
      const bytes = new Uint8Array(
        await file.slice(box.dataStart, Math.min(box.dataStart + 128, box.dataEnd)).arrayBuffer()
      );
      const text = new TextDecoder('latin1').decode(bytes);
      const m = text.match(/(\d{4})[-:](\d{2})[-:](\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
      if (m) {
        const d = wallClock(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
        if (d) return d;
      }
    }
  }
  return null;
}

async function readVideoDate(file) {
  const budget = { reads: 400 };
  const moov = await findBox(file, 0, file.size, 'moov', budget);
  if (!moov) return null;
  return (await readCreationDay(file, moov, budget)) || (await readMvhd(file, moov, budget));
}

// ------------------------------------------------------------------- Public

/**
 * @param {File} file
 * @param {'meta'|'name'|'mtime'} priority
 * @returns {Promise<{date: Date|null, source: 'exif'|'video'|'name'|'mtime'|'none'}>}
 */
export async function detectDate(file, priority = 'meta') {
  const name = file.name;

  const fromMeta = async () => {
    try {
      if (isVideo(name)) {
        const d = await readVideoDate(file);
        if (d) return { date: d, source: 'video' };
        return null;
      }
      if (isImage(name)) {
        const d = await readImageDate(file);
        if (d) return { date: d, source: 'exif' };
      }
    } catch {
      /* defekte oder unbekannte Metadaten ignorieren */
    }
    return null;
  };

  const fromName = () => {
    const d = dateFromName(name);
    return d ? { date: d, source: 'name' } : null;
  };

  const fromMtime = () => {
    const d = plausible(new Date(file.lastModified));
    return d ? { date: d, source: 'mtime' } : null;
  };

  let result = null;
  if (priority === 'mtime') {
    result = fromMtime() || fromName() || (await fromMeta());
  } else if (priority === 'name') {
    result = fromName() || (await fromMeta()) || fromMtime();
  } else {
    result = (await fromMeta()) || fromName() || fromMtime();
  }
  return result || { date: null, source: 'none' };
}
