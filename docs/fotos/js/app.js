import { detectDate, isImage, isVideo, isMedia } from './datefinder.js';
import { ZipWriter, StreamSink, BlobSink } from './zip.js';

const $ = (id) => document.getElementById(id);

const state = {
  /** @type {{file: File, path: string, date: Date|null, source: string}[]} */
  all: [],
  keys: new Set(),
  scanning: false,
  busy: false,
  cancelRequested: false,
};

const nf = new Intl.NumberFormat('de-DE');
const weekdayFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

const pad = (n) => String(n).padStart(2, '0');

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString('de-DE', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

const SOURCE_LABEL = {
  exif: 'EXIF',
  video: 'Video',
  name: 'Name',
  mtime: 'Datei',
  none: '—',
};

// ------------------------------------------------------------- Umgebung

const hasDirPicker = typeof window.showDirectoryPicker === 'function';
const hasSavePicker = typeof window.showSaveFilePicker === 'function';

function checkEnvironment() {
  const box = $('envWarning');
  const notes = [];
  if (location.protocol === 'file:') {
    notes.push(
      'Die Seite wurde direkt als Datei geöffnet. Zum Speichern in einen Ordner starte sie über <b>start.cmd</b> (lokaler Server).'
    );
  } else if (!hasDirPicker) {
    notes.push(
      'Dieser Browser unterstützt kein direktes Schreiben in Ordner. <b>Als ZIP speichern</b> funktioniert trotzdem — für die Ordner-Variante Chrome oder Edge verwenden.'
    );
  }
  if (notes.length) {
    box.innerHTML = notes.join('<br>');
    box.hidden = false;
  }
  $('saveFolder').disabled = !hasDirPicker || location.protocol === 'file:';
}

// --------------------------------------------------------- Dateien einlesen

async function filesFromDataTransfer(dt) {
  const out = [];
  const entries = [];
  for (const item of Array.from(dt.items || [])) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    entries.push(entry ?? item.getAsFile());
  }

  if (!entries.length || entries.every((e) => e === null)) {
    for (const f of dt.files) out.push({ file: f, path: f.name });
    return out;
  }

  const walk = async (entry, prefix) => {
    if (!entry) return;
    if (entry instanceof File) {
      out.push({ file: entry, path: prefix + entry.name });
      return;
    }
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null);
      if (file) out.push({ file, path: prefix + file.name });
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const dirPrefix = `${prefix + entry.name}/`;
      while (true) {
        const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
        if (!batch.length) break;
        for (const child of batch) await walk(child, dirPrefix);
      }
    }
  };

  for (const entry of entries) await walk(entry, '');
  return out;
}

function addFiles(entries) {
  const fresh = [];
  for (const { file, path } of entries) {
    const key = `${path}|${file.size}|${file.lastModified}`;
    if (state.keys.has(key)) continue;
    state.keys.add(key);
    const item = { file, path, date: null, source: 'none' };
    state.all.push(item);
    fresh.push(item);
  }
  return fresh;
}

// ------------------------------------------------------------ Metadaten

async function scanItems(items) {
  if (!items.length) return;
  state.scanning = true;
  setControlsDisabled(true);
  const status = $('scanStatus');
  status.hidden = false;

  const priority = $('optPriority').value;
  let done = 0;
  const total = items.length;
  let lastPaint = 0;

  const worker = async () => {
    while (items.length) {
      const item = items.pop();
      if (!item) return;
      const { date, source } = await detectDate(item.file, priority);
      item.date = date;
      item.source = source;
      done++;
      const now = performance.now();
      if (now - lastPaint > 60 || done === total) {
        lastPaint = now;
        $('scanBar').style.width = `${(done / total) * 100}%`;
        $('scanText').textContent = `Lese Metadaten … ${nf.format(done)} / ${nf.format(total)}`;
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  };

  await Promise.all(Array.from({ length: 6 }, worker));
  status.hidden = true;
  state.scanning = false;
  setControlsDisabled(false);
}

// -------------------------------------------------------------- Plan bauen

function folderFor(date, mode) {
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  switch (mode) {
    case 'day-dash': return `${y}-${m}-${d}`;
    case 'month': return `${y}${m}`;
    case 'year-month': return `${y}/${m}`;
    case 'year': return `${y}`;
    default: return `${y}${m}${d}`;
  }
}

// Ersetzt die unter Windows verbotenen Zeichen; Leerzeichen bleiben erhalten.
function sanitize(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '') || 'datei';
}

function uniqueName(used, folder, name) {
  const key = `${folder}/${name}`.toLowerCase();
  if (!used.has(key)) {
    used.add(key);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    const candidateKey = `${folder}/${candidate}`.toLowerCase();
    if (!used.has(candidateKey)) {
      used.add(candidateKey);
      return candidate;
    }
  }
}

function buildPlan() {
  const mode = $('optGrouping').value;
  const unknownName = sanitize($('optUnknown').value.trim() || 'Ohne Datum');
  const mediaOnly = $('optMediaOnly').checked;
  const splitType = $('optSplitType').checked;

  const groups = new Map();
  const used = new Set();
  const skipped = [];

  const sorted = [...state.all].sort((a, b) => {
    const ta = a.date ? a.date.getTime() : Infinity;
    const tb = b.date ? b.date.getTime() : Infinity;
    if (ta !== tb) return ta - tb;
    return a.path.localeCompare(b.path, 'de');
  });

  for (const item of sorted) {
    if (mediaOnly && !isMedia(item.file.name)) {
      skipped.push(item);
      continue;
    }
    let folder = item.date ? folderFor(item.date, mode) : unknownName;
    if (splitType) {
      if (isVideo(item.file.name)) folder += '/Videos';
      else if (isImage(item.file.name)) folder += '/Fotos';
      else folder += '/Sonstiges';
    }
    const filename = uniqueName(used, folder, sanitize(item.file.name));
    if (!groups.has(folder)) groups.set(folder, { folder, entries: [], bytes: 0 });
    const group = groups.get(folder);
    group.entries.push({ item, filename });
    group.bytes += item.file.size;
  }

  const list = [...groups.values()].sort((a, b) => {
    const aUnknown = a.folder.startsWith(unknownName);
    const bUnknown = b.folder.startsWith(unknownName);
    if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
    return a.folder.localeCompare(b.folder, 'de');
  });

  return { groups: list, skipped };
}

let currentPlan = { groups: [], skipped: [] };

// ------------------------------------------------------------------ Render

function loadThumb(el) {
  const file = el._file;
  if (!file || el._thumbDone) return;
  el._thumbDone = true;
  if (!isImage(file.name) || file.size > 40 * 1024 * 1024) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.width = 34;
  img.height = 34;
  img.style.objectFit = 'cover';
  img.onload = () => {
    el.textContent = '';
    el.appendChild(img);
    URL.revokeObjectURL(url);
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      thumbObserver.unobserve(entry.target);
      loadThumb(entry.target);
    }
  },
  { rootMargin: '150px' }
);

function renderRow({ item, filename }) {
  const row = document.createElement('div');
  row.className = 'row';

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  thumb.textContent = isVideo(item.file.name) ? '🎬' : isImage(item.file.name) ? '🖼️' : '📄';
  thumb._file = item.file;
  thumbObserver.observe(thumb);
  row.appendChild(thumb);

  const name = document.createElement('div');
  name.className = 'row-name';
  name.textContent = filename;
  if (item.path !== item.file.name) {
    const src = document.createElement('span');
    src.className = 'row-path';
    src.textContent = `  ← ${item.path}`;
    name.appendChild(src);
  }
  name.title = item.path;
  row.appendChild(name);

  const tag = document.createElement('span');
  tag.className = `tag ${item.source}`;
  tag.textContent = SOURCE_LABEL[item.source] ?? item.source;
  tag.title = 'Quelle des Datums';
  row.appendChild(tag);

  const time = document.createElement('span');
  time.className = 'row-time';
  time.textContent = item.date
    ? `${pad(item.date.getHours())}:${pad(item.date.getMinutes())}`
    : '--:--';
  row.appendChild(time);

  const size = document.createElement('span');
  size.className = 'row-size';
  size.textContent = formatBytes(item.file.size);
  row.appendChild(size);

  return row;
}

function renderGroup(group) {
  const el = document.createElement('div');
  el.className = 'group';

  const head = document.createElement('div');
  head.className = 'group-head';

  const caret = document.createElement('span');
  caret.className = 'group-caret';
  caret.textContent = '▶';
  head.appendChild(caret);

  const name = document.createElement('span');
  name.className = 'group-name';
  name.textContent = group.folder;
  head.appendChild(name);

  const first = group.entries[0].item.date;
  if (first) {
    const wd = document.createElement('span');
    wd.className = 'group-weekday';
    wd.textContent = weekdayFmt.format(first);
    head.appendChild(wd);
  }

  const meta = document.createElement('span');
  meta.className = 'group-meta';
  const photos = group.entries.filter((e) => isImage(e.item.file.name)).length;
  const videos = group.entries.filter((e) => isVideo(e.item.file.name)).length;
  const parts = [];
  if (photos) parts.push(`${nf.format(photos)} ${photos === 1 ? 'Foto' : 'Fotos'}`);
  if (videos) parts.push(`${nf.format(videos)} ${videos === 1 ? 'Video' : 'Videos'}`);
  const other = group.entries.length - photos - videos;
  if (other) parts.push(`${nf.format(other)} ${other === 1 ? 'weitere Datei' : 'weitere Dateien'}`);
  meta.textContent = `${parts.join(' · ')} · ${formatBytes(group.bytes)}`;
  head.appendChild(meta);

  const body = document.createElement('div');
  body.className = 'group-body';

  let filled = false;
  head.addEventListener('click', () => {
    el.classList.toggle('open');
    if (el.classList.contains('open') && !filled) {
      filled = true;
      const limit = 400;
      const frag = document.createDocumentFragment();
      for (const entry of group.entries.slice(0, limit)) frag.appendChild(renderRow(entry));
      if (group.entries.length > limit) {
        const more = document.createElement('div');
        more.className = 'more';
        more.textContent = `… und ${nf.format(group.entries.length - limit)} weitere Dateien`;
        frag.appendChild(more);
      }
      body.appendChild(frag);
      // Die ersten Vorschaubilder sofort laden, den Rest beim Scrollen.
      for (const thumb of [...body.querySelectorAll('.thumb')].slice(0, 40)) {
        thumbObserver.unobserve(thumb);
        loadThumb(thumb);
      }
    }
  });

  el.appendChild(head);
  el.appendChild(body);
  return el;
}

function render() {
  currentPlan = buildPlan();
  const { groups, skipped } = currentPlan;
  const hasFiles = state.all.length > 0;

  $('optionsPanel').hidden = !hasFiles;
  $('resultPanel').hidden = !hasFiles;
  $('exportPanel').hidden = !hasFiles;
  $('dropzone').classList.toggle('compact', hasFiles);

  const container = $('groups');
  container.textContent = '';
  const frag = document.createDocumentFragment();
  for (const group of groups) frag.appendChild(renderGroup(group));
  container.appendChild(frag);

  const totalFiles = groups.reduce((n, g) => n + g.entries.length, 0);
  const totalBytes = groups.reduce((n, g) => n + g.bytes, 0);
  const noDate = groups
    .filter((g) => g.entries.some((e) => !e.item.date))
    .reduce((n, g) => n + g.entries.filter((e) => !e.item.date).length, 0);

  $('summary').innerHTML =
    `<b>${nf.format(totalFiles)}</b> Dateien · <b>${nf.format(groups.length)}</b> Ordner · <b>${formatBytes(totalBytes)}</b>` +
    (noDate ? ` · <b>${nf.format(noDate)}</b> ohne erkanntes Datum` : '');

  const skippedBox = $('skipped');
  if (skipped.length) {
    skippedBox.hidden = false;
    skippedBox.textContent = `${nf.format(skipped.length)} Datei(en) übersprungen (keine Fotos/Videos): ${skipped
      .slice(0, 6)
      .map((s) => s.file.name)
      .join(', ')}${skipped.length > 6 ? ' …' : ''}`;
  } else {
    skippedBox.hidden = true;
  }

  const nothingToDo = totalFiles === 0;
  $('saveZip').disabled = nothingToDo || state.busy;
  $('saveFolder').disabled = nothingToDo || state.busy || !hasDirPicker || location.protocol === 'file:';
}

// -------------------------------------------------------------------- Log

function log(message, cls = '') {
  const box = $('log');
  box.hidden = false;
  const line = document.createElement('div');
  line.className = `line ${cls}`;
  line.textContent = message;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function setControlsDisabled(disabled) {
  for (const id of ['optGrouping', 'optPriority', 'optUnknown', 'optMediaOnly', 'optSplitType', 'optSkipExisting', 'clearAll']) {
    $(id).disabled = disabled;
  }
  $('saveZip').disabled = disabled || !currentPlan.groups.length;
  $('saveFolder').disabled =
    disabled || !currentPlan.groups.length || !hasDirPicker || location.protocol === 'file:';
}

class Progress {
  constructor(totalBytes, totalFiles) {
    this.totalBytes = Math.max(totalBytes, 1);
    this.totalFiles = totalFiles;
    this.bytes = 0;
    this.files = 0;
    this.last = 0;
    $('progress').hidden = false;
    $('progressBar').style.width = '0%';
    $('progressText').textContent = 'Starte …';
  }
  addBytes(n) {
    this.bytes += n;
    this.paint();
  }
  fileDone() {
    this.files++;
    this.paint(true);
  }
  paint(force = false) {
    const now = performance.now();
    if (!force && now - this.last < 80) return;
    this.last = now;
    const pct = Math.min(100, (this.bytes / this.totalBytes) * 100);
    $('progressBar').style.width = `${pct}%`;
    $('progressText').textContent =
      `${nf.format(this.files)} / ${nf.format(this.totalFiles)} Dateien · ${formatBytes(this.bytes)} von ${formatBytes(this.totalBytes)}`;
  }
  finish(text) {
    $('progressBar').style.width = '100%';
    $('progressText').textContent = text;
  }
}

const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

// --------------------------------------------------- Export: echter Ordner

async function ensureDir(root, path, cache) {
  let handle = root;
  let key = '';
  for (const part of path.split('/')) {
    key += `/${part}`;
    const cached = cache.get(key);
    if (cached) {
      handle = cached;
      continue;
    }
    handle = await handle.getDirectoryHandle(part, { create: true });
    cache.set(key, handle);
  }
  return handle;
}

async function existingFile(dir, name) {
  try {
    const handle = await dir.getFileHandle(name);
    return await handle.getFile();
  } catch {
    return null;
  }
}

async function saveToFolder() {
  let root;
  try {
    root = await window.showDirectoryPicker({ id: 'picturesort-target', mode: 'readwrite', startIn: 'pictures' });
  } catch {
    return; // Abbruch durch Nutzer
  }
  if ((await root.queryPermission?.({ mode: 'readwrite' })) === 'prompt') {
    const granted = await root.requestPermission({ mode: 'readwrite' });
    if (granted !== 'granted') {
      log('Kein Schreibrecht für den Zielordner erhalten.', 'err');
      return;
    }
  }

  const { groups } = currentPlan;
  const totalFiles = groups.reduce((n, g) => n + g.entries.length, 0);
  const totalBytes = groups.reduce((n, g) => n + g.bytes, 0);
  const skipExisting = $('optSkipExisting').checked;

  startBusy();
  $('log').textContent = '';
  const progress = new Progress(totalBytes, totalFiles);
  const cache = new Map();
  let copied = 0;
  let skipped = 0;
  let failed = 0;

  try {
    for (const group of groups) {
      const dir = await ensureDir(root, group.folder, cache);
      for (const entry of group.entries) {
        if (state.cancelRequested) throw new DOMException('abgebrochen', 'AbortError');
        let name = entry.filename;
        try {
          const existing = await existingFile(dir, name);
          if (existing) {
            if (skipExisting && existing.size === entry.item.file.size) {
              skipped++;
              progress.addBytes(entry.item.file.size);
              progress.fileDone();
              continue;
            }
            if (existing.size !== entry.item.file.size) {
              const dot = name.lastIndexOf('.');
              const base = dot > 0 ? name.slice(0, dot) : name;
              const ext = dot > 0 ? name.slice(dot) : '';
              for (let i = 2; i < 1000; i++) {
                const candidate = `${base} (${i})${ext}`;
                if (!(await existingFile(dir, candidate))) {
                  name = candidate;
                  break;
                }
              }
            }
          }
          const handle = await dir.getFileHandle(name, { create: true });
          const writable = await handle.createWritable();
          await writable.write(entry.item.file);
          await writable.close();
          copied++;
          progress.addBytes(entry.item.file.size);
          progress.fileDone();
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          failed++;
          log(`Fehler bei ${group.folder}/${name}: ${err.message}`, 'err');
          progress.fileDone();
        }
        if (progress.files % 25 === 0) await yieldToUi();
      }
    }
    progress.finish(`Fertig — ${nf.format(copied)} Dateien kopiert.`);
    log(
      `✔ ${nf.format(copied)} Dateien in ${nf.format(groups.length)} Ordner kopiert` +
        (skipped ? `, ${nf.format(skipped)} bereits vorhanden` : '') +
        (failed ? `, ${nf.format(failed)} fehlgeschlagen` : '') +
        '.',
      failed ? 'err' : 'ok'
    );
  } catch (err) {
    if (err?.name === 'AbortError') {
      progress.finish('Abgebrochen.');
      log(`Abgebrochen — ${nf.format(copied)} Dateien wurden bereits kopiert.`, 'err');
    } else {
      progress.finish('Fehler.');
      log(`Abbruch: ${err.message}`, 'err');
    }
  } finally {
    endBusy();
  }
}

// ------------------------------------------------------------ Export: ZIP

function suggestZipName() {
  const dated = currentPlan.groups.filter((g) => g.entries[0]?.item.date);
  if (!dated.length) return 'Fotos_sortiert.zip';
  const first = dated[0].entries[0].item.date;
  const last = dated[dated.length - 1].entries[0].item.date;
  const fmt = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  return fmt(first) === fmt(last) ? `Fotos_${fmt(first)}.zip` : `Fotos_${fmt(first)}-${fmt(last)}.zip`;
}

async function saveAsZip() {
  const { groups } = currentPlan;
  const totalFiles = groups.reduce((n, g) => n + g.entries.length, 0);
  const totalBytes = groups.reduce((n, g) => n + g.bytes, 0);

  let sink;
  let writable = null;
  if (hasSavePicker) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({
        id: 'picturesort-zip',
        suggestedName: suggestZipName(),
        types: [{ description: 'ZIP-Archiv', accept: { 'application/zip': ['.zip'] } }],
      });
    } catch {
      return; // Abbruch durch Nutzer
    }
    writable = await handle.createWritable();
    sink = new StreamSink(writable);
  } else {
    if (totalBytes > 1.5 * 1024 * 1024 * 1024) {
      log('Ohne Chrome/Edge muss das ZIP im Arbeitsspeicher gebaut werden — bei über 1,5 GB kann das fehlschlagen.', 'err');
    }
    sink = new BlobSink();
  }

  startBusy();
  $('log').textContent = '';
  const progress = new Progress(totalBytes, totalFiles);
  const zip = new ZipWriter(sink);

  try {
    for (const group of groups) {
      for (const entry of group.entries) {
        if (state.cancelRequested) throw new DOMException('abgebrochen', 'AbortError');
        const item = entry.item;
        const date = item.date ?? new Date(item.file.lastModified);
        await zip.addFile(`${group.folder}/${entry.filename}`, item.file, date, (n) => progress.addBytes(n));
        progress.fileDone();
        if (progress.files % 25 === 0) await yieldToUi();
      }
    }
    const blob = await zip.close();
    if (blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = suggestZipName();
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      progress.finish('ZIP erstellt — Download gestartet.');
    } else {
      progress.finish('ZIP gespeichert.');
    }
    log(`✔ ${nf.format(totalFiles)} Dateien in ${nf.format(groups.length)} Ordner verpackt (${formatBytes(totalBytes)}).`, 'ok');
  } catch (err) {
    try {
      await writable?.abort();
    } catch { /* ignorieren */ }
    if (err?.name === 'AbortError') {
      progress.finish('Abgebrochen.');
      log('ZIP-Erstellung abgebrochen.', 'err');
    } else {
      progress.finish('Fehler.');
      log(`Fehler beim Erstellen des ZIP: ${err.message}`, 'err');
    }
  } finally {
    endBusy();
  }
}

function startBusy() {
  state.busy = true;
  state.cancelRequested = false;
  setControlsDisabled(true);
  $('saveZip').disabled = true;
  $('saveFolder').disabled = true;
  $('cancelBtn').disabled = false;
}

function endBusy() {
  state.busy = false;
  setControlsDisabled(false);
  $('cancelBtn').disabled = true;
}

// ------------------------------------------------------------------ Events

function wire() {
  const dz = $('dropzone');

  const onDragOver = (e) => {
    e.preventDefault();
    if (state.busy) return;
    e.dataTransfer.dropEffect = 'copy';
    dz.classList.add('hover');
  };
  ['dragenter', 'dragover'].forEach((ev) => {
    dz.addEventListener(ev, onDragOver);
    document.addEventListener(ev, (e) => e.preventDefault());
  });
  ['dragleave', 'dragend'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      if (e.target === dz) dz.classList.remove('hover');
    })
  );

  const handleDrop = async (e) => {
    e.preventDefault();
    dz.classList.remove('hover');
    if (state.busy || state.scanning) return;
    const entries = await filesFromDataTransfer(e.dataTransfer);
    const fresh = addFiles(entries);
    render();
    await scanItems(fresh);
    render();
  };
  dz.addEventListener('drop', handleDrop);
  document.addEventListener('drop', (e) => {
    if (!dz.contains(e.target)) handleDrop(e);
  });

  $('pickFiles').addEventListener('click', () => $('fileInput').click());
  $('pickFolder').addEventListener('click', () => $('folderInput').click());

  const fromInput = async (input) => {
    const entries = [...input.files].map((f) => ({
      file: f,
      path: f.webkitRelativePath || f.name,
    }));
    input.value = '';
    const fresh = addFiles(entries);
    render();
    await scanItems(fresh);
    render();
  };
  $('fileInput').addEventListener('change', (e) => fromInput(e.target));
  $('folderInput').addEventListener('change', (e) => fromInput(e.target));

  for (const id of ['optGrouping', 'optUnknown', 'optMediaOnly', 'optSplitType']) {
    $(id).addEventListener('change', render);
  }
  $('optUnknown').addEventListener('input', render);

  $('optPriority').addEventListener('change', async () => {
    const items = [...state.all];
    await scanItems(items);
    render();
  });

  $('expandAll').addEventListener('click', () => {
    const groups = [...document.querySelectorAll('.group')];
    const anyClosed = groups.some((g) => !g.classList.contains('open'));
    for (const g of groups) {
      if (anyClosed !== g.classList.contains('open')) g.querySelector('.group-head').click();
    }
    $('expandAll').textContent = anyClosed ? 'Alle zuklappen' : 'Alle aufklappen';
  });

  $('clearAll').addEventListener('click', () => {
    state.all = [];
    state.keys.clear();
    $('log').textContent = '';
    $('log').hidden = true;
    $('progress').hidden = true;
    render();
  });

  $('saveFolder').addEventListener('click', saveToFolder);
  $('saveZip').addEventListener('click', saveAsZip);
  $('cancelBtn').addEventListener('click', () => {
    state.cancelRequested = true;
    $('cancelBtn').disabled = true;
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.busy) e.preventDefault();
  });
}

checkEnvironment();
wire();
render();
window.__pictureSortReady = true;
