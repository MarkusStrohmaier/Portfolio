// Minimaler ZIP-Writer (Methode "store", ohne Kompression).
// Unterstützt Streaming in einen FileSystemWritableFileStream und ZIP64
// fuer Dateien > 4 GB bzw. Archive > 4 GB.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export const crcInit = () => 0xffffffff;

export function crcUpdate(crc, bytes) {
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return crc >>> 0;
}

export const crcFinal = (crc) => (crc ^ 0xffffffff) >>> 0;

const MAX32 = 0xffffffff;
const encoder = new TextEncoder();

class ByteBuilder {
  constructor() {
    this.parts = [];
    this.length = 0;
  }
  u16(v) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    return this.raw(b);
  }
  u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    return this.raw(b);
  }
  u64(v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
    return this.raw(b);
  }
  raw(bytes) {
    this.parts.push(bytes);
    this.length += bytes.length;
    return this;
  }
  build() {
    const out = new Uint8Array(this.length);
    let pos = 0;
    for (const p of this.parts) {
      out.set(p, pos);
      pos += p.length;
    }
    return out;
  }
}

// MS-DOS Datum/Zeit (Aufloesung: 2 Sekunden, Jahre ab 1980).
function dosDateTime(date) {
  const d = date && !isNaN(date) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  const dosDate =
    ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const dosTime =
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { dosDate: dosDate & 0xffff, dosTime: dosTime & 0xffff };
}

/** Schreibt direkt in eine Datei (File System Access API) - RAM-schonend. */
export class StreamSink {
  constructor(writable) {
    this.writable = writable;
    this.passthrough = false;
  }
  async write(chunk) {
    await this.writable.write(chunk);
  }
  async finish() {
    await this.writable.close();
    return null;
  }
}

/** Sammelt alles in einem Blob (Fallback fuer Browser ohne File System Access API). */
export class BlobSink {
  constructor() {
    this.parts = [];
    // Datei-Blobs koennen unveraendert durchgereicht werden -> kein RAM-Verbrauch.
    this.passthrough = true;
  }
  async write(chunk) {
    this.parts.push(chunk);
  }
  async finish() {
    return new Blob(this.parts, { type: 'application/zip' });
  }
}

export class ZipWriter {
  constructor(sink) {
    this.sink = sink;
    this.offset = 0;
    this.entries = [];
  }

  async #push(chunk) {
    await this.sink.write(chunk);
    this.offset += chunk.byteLength ?? chunk.size;
  }

  /**
   * @param {string} path Pfad im Archiv, z.B. "20260707/IMG_0001.jpg"
   * @param {Blob}   blob Dateiinhalt
   * @param {Date}   date Zeitstempel fuer den Eintrag
   * @param {(n:number)=>void} onBytes Fortschritt in Bytes
   */
  async addFile(path, blob, date, onBytes) {
    const nameBytes = encoder.encode(path.replace(/\\/g, '/'));
    const { dosDate, dosTime } = dosDateTime(date);
    const size = blob.size;
    const localOffset = this.offset;
    const zip64 = size >= MAX32 || localOffset >= MAX32;
    const versionNeeded = zip64 ? 45 : 20;

    if (this.sink.passthrough) {
      // CRC vorab berechnen, dann den Blob unveraendert durchreichen.
      const crc = await crcOfBlob(blob, onBytes);
      const header = new ByteBuilder()
        .u32(0x04034b50)
        .u16(versionNeeded)
        .u16(0x0800) // UTF-8
        .u16(0) // store
        .u16(dosTime)
        .u16(dosDate)
        .u32(crc)
        .u32(zip64 ? MAX32 : size)
        .u32(zip64 ? MAX32 : size)
        .u16(nameBytes.length)
        .u16(zip64 ? 20 : 0)
        .raw(nameBytes);
      if (zip64) header.u16(0x0001).u16(16).u64(size).u64(size);
      await this.#push(header.build());
      await this.#push(blob);
      this.entries.push({ nameBytes, crc, size, localOffset, dosDate, dosTime, versionNeeded, flags: 0x0800 });
      return;
    }

    // Streaming: CRC und Groessen stehen erst nach den Daten fest
    // -> Data Descriptor (Flag Bit 3).
    const flags = 0x0808;
    const header = new ByteBuilder()
      .u32(0x04034b50)
      .u16(versionNeeded)
      .u16(flags)
      .u16(0)
      .u16(dosTime)
      .u16(dosDate)
      .u32(0)
      .u32(zip64 ? MAX32 : 0)
      .u32(zip64 ? MAX32 : 0)
      .u16(nameBytes.length)
      .u16(zip64 ? 20 : 0)
      .raw(nameBytes);
    if (zip64) header.u16(0x0001).u16(16).u64(0).u64(0);
    await this.#push(header.build());

    let crc = crcInit();
    let written = 0;
    const reader = blob.stream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      crc = crcUpdate(crc, value);
      written += value.byteLength;
      await this.#push(value);
      if (onBytes) onBytes(value.byteLength);
    }
    crc = crcFinal(crc);

    const desc = new ByteBuilder().u32(0x08074b50).u32(crc);
    if (zip64) desc.u64(written).u64(written);
    else desc.u32(written).u32(written);
    await this.#push(desc.build());

    this.entries.push({ nameBytes, crc, size: written, localOffset, dosDate, dosTime, versionNeeded, flags });
  }

  async close() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const needSize = e.size >= MAX32;
      const needOffset = e.localOffset >= MAX32;
      const extra = new ByteBuilder();
      if (needSize || needOffset) {
        const body = new ByteBuilder();
        if (needSize) body.u64(e.size).u64(e.size);
        if (needOffset) body.u64(e.localOffset);
        extra.u16(0x0001).u16(body.length).raw(body.build());
      }
      const extraBytes = extra.build();
      const cd = new ByteBuilder()
        .u32(0x02014b50)
        .u16(e.versionNeeded) // version made by
        .u16(e.versionNeeded)
        .u16(e.flags)
        .u16(0)
        .u16(e.dosTime)
        .u16(e.dosDate)
        .u32(e.crc)
        .u32(needSize ? MAX32 : e.size)
        .u32(needSize ? MAX32 : e.size)
        .u16(e.nameBytes.length)
        .u16(extraBytes.length)
        .u16(0) // Kommentar
        .u16(0) // Disk
        .u16(0) // interne Attribute
        .u32(0) // externe Attribute
        .u32(needOffset ? MAX32 : e.localOffset)
        .raw(e.nameBytes)
        .raw(extraBytes);
      await this.#push(cd.build());
    }
    const cdSize = this.offset - cdStart;
    const count = this.entries.length;
    const needZip64 = count >= 0xffff || cdSize >= MAX32 || cdStart >= MAX32;

    if (needZip64) {
      const z64Start = this.offset;
      const rec = new ByteBuilder()
        .u32(0x06064b50)
        .u64(44) // Groesse des Records ab hier
        .u16(45)
        .u16(45)
        .u32(0)
        .u32(0)
        .u64(count)
        .u64(count)
        .u64(cdSize)
        .u64(cdStart);
      await this.#push(rec.build());
      const loc = new ByteBuilder()
        .u32(0x07064b50)
        .u32(0)
        .u64(z64Start)
        .u32(1);
      await this.#push(loc.build());
    }

    const eocd = new ByteBuilder()
      .u32(0x06054b50)
      .u16(0)
      .u16(0)
      .u16(Math.min(count, 0xffff))
      .u16(Math.min(count, 0xffff))
      .u32(Math.min(cdSize, MAX32))
      .u32(Math.min(cdStart, MAX32))
      .u16(0);
    await this.#push(eocd.build());

    return this.sink.finish();
  }
}

async function crcOfBlob(blob, onBytes) {
  const CHUNK = 8 * 1024 * 1024;
  let crc = crcInit();
  for (let pos = 0; pos < blob.size; pos += CHUNK) {
    const slice = blob.slice(pos, Math.min(pos + CHUNK, blob.size));
    const bytes = new Uint8Array(await slice.arrayBuffer());
    crc = crcUpdate(crc, bytes);
    if (onBytes) onBytes(bytes.length);
  }
  return crcFinal(crc);
}
