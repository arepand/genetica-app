(function activityCoreFactory(global) {
  'use strict';

  const SCHEMA_VERSION = 'ariadna-activity-v2';
  const CONFIG_SCHEMA = 'ariadna-activity-catalogs-v1';
  const MAX_PAGES = 10;
  const DEFAULT_MASK = Object.freeze({ x: 0.58, y: 0, width: 0.275, height: 1 });

  const DEFAULT_CATALOGS = Object.freeze({
    schema_version: CONFIG_SCHEMA,
    revision: 1,
    doctors: [
      { id: 'ara', code: 'ARA', label: 'Reparaz Andrade, Alfredo', active: true },
      { id: 'mbp', code: 'MBP', label: 'Blanco Pérez, María Milagros', active: true },
      { id: 'ctb', code: 'CTB', label: 'Torreira Banzas, Cristina', active: true },
      { id: 'nvp', code: 'NVP', label: 'Vicente Pérez, Nuria', active: true },
      { id: 'sc', code: 'SC', label: 'Sin codificar', active: true },
    ],
    agendas: [
      { id: 'uxpc03', code: 'UXPC03', label: 'Xenética', active: true },
      { id: 'uxpc04', code: 'UXPC04', label: 'Telefónicas Xenética', active: true },
    ],
    services: [
      { id: '8.01', code: '8.01', label: 'Consulta pretest', active: true },
      { id: '8.01t', code: '8.01T', label: 'Consulta pretest telefónica', active: true },
      { id: '8.01v', code: '8.01V', label: 'Consulta pretest virtual', active: true },
      { id: '8.03', code: '8.03', label: 'Consulta postest', active: true },
      { id: 'lxen.1', code: 'LXEN.1', label: 'Consulta Xenética', active: true },
    ],
    templates: [{
      id: 'chu-vigo-putty-v1',
      label: 'C.H.U. Vigo · actividad PuTTY v1',
      active: true,
      mask: DEFAULT_MASK,
      expected_columns: ['fecha', 'hora', 'prestacion', 'realizada', 'nreg', 'paciente', 'alta'],
    }],
  });

  const clone = value => JSON.parse(JSON.stringify(value));
  const text = value => String(value == null ? '' : value).trim();
  const canonicalCode = value => text(value).toUpperCase().replace(/\s+/g, '');
  const slug = value => canonicalCode(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'item';
  const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
  const normalizedMask = mask => {
    const x = clamp(mask?.x, 0, 1);
    const y = clamp(mask?.y, 0, 1);
    const width = clamp(mask?.width, 0.01, 1 - x);
    const height = clamp(mask?.height, 0.01, 1 - y);
    return { x, y, width, height };
  };

  function defaultCatalogs() { return clone(DEFAULT_CATALOGS); }

  function normalizeCatalogs(input) {
    const base = defaultCatalogs();
    const source = input && typeof input === 'object' ? input : {};
    const result = {
      schema_version: CONFIG_SCHEMA,
      revision: Math.max(1, Number(source.revision) || 1),
      updated_at: source.updated_at || null,
      doctors: normalizeCatalogCollection(source.doctors, base.doctors),
      agendas: normalizeCatalogCollection(source.agendas, base.agendas),
      services: normalizeCatalogCollection(source.services, base.services),
      templates: Array.isArray(source.templates) && source.templates.length
        ? source.templates.map((item, index) => ({
          id: text(item.id) || `template-${index + 1}`,
          label: text(item.label) || `Plantilla ${index + 1}`,
          active: item.active !== false,
          mask: normalizedMask(item.mask || DEFAULT_MASK),
          expected_columns: Array.isArray(item.expected_columns) ? item.expected_columns.map(text).filter(Boolean) : base.templates[0].expected_columns,
        }))
        : base.templates,
    };
    return result;
  }

  function normalizeCatalogCollection(items, fallback) {
    const source = Array.isArray(items) && items.length ? items : fallback;
    const used = new Set();
    return source.map((item, index) => {
      const code = canonicalCode(item.code || item.id || `ITEM${index + 1}`);
      let id = text(item.id) || slug(code);
      while (used.has(id)) id = `${id}-${index + 1}`;
      used.add(id);
      return { id, code, label: text(item.label) || code, active: item.active !== false };
    });
  }

  function parseDate(value) {
    const match = text(value).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) return null;
    const day = Number(match[1]), month = Number(match[2]), year = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return { display: `${match[1]}/${match[2]}/${match[3]}`, iso: `${match[3]}-${match[2]}-${match[1]}` };
  }

  function normalizeTime(value) {
    const match = text(value).match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return '';
    const hours = Number(match[1]), minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return '';
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  function normalizePerformed(value) {
    const cleaned = text(value).toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.\s]/g, '');
    if (/^URG/.test(cleaned)) return 'URG';
    if (/^SI/.test(cleaned)) return 'SI';
    if (/^NO/.test(cleaned)) return 'NO';
    return '';
  }

  function normalizeDischarge(value) {
    const cleaned = text(value);
    return cleaned === '0' || cleaned === '1' ? cleaned : '';
  }

  function normalizeNreg(value) {
    const cleaned = text(value).replace(/\s+/g, '');
    return /^\d+$/.test(cleaned) ? cleaned : '';
  }

  function normalizeRow(input, context = {}) {
    const date = parseDate(input?.fecha);
    const row = {
      fecha: date?.display || text(input?.fecha),
      fecha_iso: date?.iso || '',
      hora: normalizeTime(input?.hora),
      prestacion: canonicalCode(input?.prestacion),
      realizada: normalizePerformed(input?.realizada),
      alta: normalizeDischarge(input?.alta),
      nreg: normalizeNreg(input?.nreg),
      medico_id: text(context.medico_id || input?.medico_id),
      agenda_id: text(context.agenda_id || input?.agenda_id),
      pagina: Number(context.pagina || input?.pagina) || 0,
      fila: Number(context.fila || input?.fila) || 0,
      confidence: Number(input?.confidence) || 0,
      nreg_length_warning: false,
      issues: [],
    };
    if (!date) row.issues.push('Fecha inválida: usa DD/MM/AAAA.');
    if (!row.hora) row.issues.push('Hora inválida: usa HH:MM.');
    if (!row.prestacion) row.issues.push('Falta el código exacto de prestación.');
    if (!row.realizada) row.issues.push('Realizada debe ser SI, NO o URG.');
    if (!row.nreg) row.issues.push('NREG debe contener solo números.');
    if (row.nreg && row.nreg.length !== 9) row.nreg_length_warning = true;
    if (!row.alta) row.issues.push('Alta debe ser 0 o 1.');
    if (!row.medico_id) row.issues.push('Falta el médico seleccionado.');
    if (!row.agenda_id) row.issues.push('Falta confirmar la agenda de la página.');
    return row;
  }

  function rowIsValid(row) { return Array.isArray(row?.issues) && row.issues.length === 0; }

  function groupRows(rows) {
    const groups = new Map();
    for (const row of rows || []) {
      if (!rowIsValid(row)) throw new Error('No se puede agregar una fila con incidencias.');
      const key = [row.fecha_iso, row.medico_id, row.agenda_id, row.prestacion, row.realizada, row.alta].join('|');
      const current = groups.get(key) || {
        fecha: row.fecha,
        fecha_iso: row.fecha_iso,
        medico_id: row.medico_id,
        agenda_id: row.agenda_id,
        prestacion: row.prestacion,
        realizada: row.realizada,
        alta: row.alta,
        count: 0,
      };
      current.count += 1;
      groups.set(key, current);
    }
    return [...groups.values()].sort((a, b) => [a.fecha_iso, a.medico_id, a.agenda_id, a.prestacion, a.realizada, a.alta].join('|').localeCompare([b.fecha_iso, b.medico_id, b.agenda_id, b.prestacion, b.realizada, b.alta].join('|')));
  }

  function summarizeAggregates(aggregates) {
    const summary = { total: 0, realized: 0, urgent: 0, followup: 0, finished: 0 };
    for (const item of aggregates || []) {
      const count = Number(item.count) || 0;
      summary.total += count;
      if (item.realizada === 'SI' || item.realizada === 'URG') summary.realized += count;
      if (item.realizada === 'URG') summary.urgent += count;
      if (item.alta === '1') summary.followup += count;
      if (item.alta === '0') summary.finished += count;
    }
    return summary;
  }

  async function sha256Hex(value) {
    const bytes = value instanceof ArrayBuffer ? value : value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
    const digest = await global.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(part => part.toString(16).padStart(2, '0')).join('');
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (const part of bytes) binary += String.fromCharCode(part);
    return global.btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = global.atob(value);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }

  function getOrCreateHmacSecret(storage = global.localStorage) {
    const keyName = 'fh_activity_hmac_secret_v1';
    let encoded = storage?.getItem(keyName) || '';
    if (!encoded) {
      const bytes = global.crypto.getRandomValues(new Uint8Array(32));
      encoded = bytesToBase64(bytes);
      storage?.setItem(keyName, encoded);
    }
    return encoded;
  }

  async function hmacNreg(nreg, encodedSecret) {
    const value = normalizeNreg(nreg);
    if (!value) throw new Error('NREG inválido para deduplicación.');
    const key = await global.crypto.subtle.importKey('raw', base64ToBytes(encodedSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await global.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`ariadna:nreg:v1:${value}`));
    return [...new Uint8Array(signature)].map(part => part.toString(16).padStart(2, '0')).join('');
  }

  async function prepareBatch({ rows, fileHash, pages, catalogsRevision, secret, existingHmacs = {} }) {
    const activeRows = [], duplicates = [];
    const hmacs = [];
    for (const row of rows || []) {
      if (!rowIsValid(row)) throw new Error('Revisa todas las incidencias antes de preparar el lote.');
      const hmac = await hmacNreg(row.nreg, secret);
      if (existingHmacs[hmac]) duplicates.push({ hmac, batch_id: existingHmacs[hmac], page: row.pagina, row: row.fila });
      else { activeRows.push(row); hmacs.push(hmac); }
    }
    const aggregates = groupRows(activeRows);
    const idSeed = `${fileHash}|${new Date().toISOString()}|${activeRows.length}`;
    const id = `activity-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${(await sha256Hex(idSeed)).slice(0, 10)}`;
    return {
      batch: {
        schema_version: SCHEMA_VERSION,
        id,
        created_at: new Date().toISOString(),
        status: 'active',
        source: { sha256: fileHash, pages: Number(pages) || 0, template_id: 'chu-vigo-putty-v1' },
        catalogs_revision: Number(catalogsRevision) || 1,
        rows_reconciled: activeRows.length + duplicates.length,
        rows_included: activeRows.length,
        duplicate_rows_excluded: duplicates.length,
        aggregates,
        summary: summarizeAggregates(aggregates),
        dedup_hmacs: hmacs,
      },
      duplicates,
      includedRows: activeRows,
    };
  }

  function parseTsv(tsv) {
    const records = [];
    const lines = text(tsv).split(/\r?\n/);
    const standardHeader = ['level', 'page_num', 'block_num', 'par_num', 'line_num', 'word_num', 'left', 'top', 'width', 'height', 'conf', 'text'];
    // Tesseract.js 7 entrega TSV sin cabecera; versiones anteriores podían
    // incluirla. Aceptamos ambos formatos para no convertir una página leída
    // correctamente en «0 filas» por una diferencia de versión del motor.
    const first = (lines[0] || '').split('\t');
    const header = first[0] === 'level' ? (lines.shift() || '').split('\t') : standardHeader;
    for (const line of lines) {
      if (!line) continue;
      const parts = line.split('\t');
      const object = Object.fromEntries(header.map((name, index) => [name, parts[index] ?? '']));
      if (object.level === '5' && text(object.text)) {
        records.push({
          text: text(object.text),
          confidence: Number(object.conf) || 0,
          x: Number(object.left) || 0,
          y: Number(object.top) || 0,
          width: Number(object.width) || 0,
          height: Number(object.height) || 0,
          lineKey: [object.page_num, object.block_num, object.par_num, object.line_num].join(':'),
        });
      }
    }
    return records;
  }

  function tsvLines(tsv) {
    const grouped = new Map();
    for (const word of parseTsv(tsv)) {
      const list = grouped.get(word.lineKey) || [];
      list.push(word); grouped.set(word.lineKey, list);
    }
    return [...grouped.values()].map(words => {
      words.sort((a, b) => a.x - b.x);
      return {
        text: words.map(word => word.text).join(' '),
        confidence: words.reduce((sum, word) => sum + word.confidence, 0) / Math.max(1, words.length),
        y: Math.min(...words.map(word => word.y)),
        words,
      };
    }).sort((a, b) => a.y - b.y);
  }

  function tsvRowBands(tsv) {
    const words = parseTsv(tsv).sort((a, b) => (a.y + a.height / 2) - (b.y + b.height / 2) || a.x - b.x);
    const bands = [];
    for (const word of words) {
      const center = word.y + word.height / 2;
      let best = null, distance = Infinity;
      for (const band of bands) {
        const currentDistance = Math.abs(center - band.center);
        const tolerance = Math.max(8, Math.min(48, Math.max(word.height, band.height) * 0.9));
        if (currentDistance <= tolerance && currentDistance < distance) { best = band; distance = currentDistance; }
      }
      if (!best) {
        best = { center, height: word.height, words: [] };
        bands.push(best);
      }
      best.words.push(word);
      best.center = best.words.reduce((sum, item) => sum + item.y + item.height / 2, 0) / best.words.length;
      best.height = Math.max(best.height, word.height);
    }
    return bands.map(band => {
      band.words.sort((a, b) => a.x - b.x);
      return {
        text: band.words.map(word => word.text).join(' '),
        confidence: band.words.reduce((sum, word) => sum + word.confidence, 0) / Math.max(1, band.words.length),
        y: Math.min(...band.words.map(word => word.y)),
        words: band.words,
      };
    }).sort((a, b) => a.y - b.y);
  }

  function detectAgenda(ocrText, catalogs) {
    const normalized = canonicalCode(ocrText);
    const matches = (catalogs?.agendas || []).filter(item => normalized.includes(canonicalCode(item.code)));
    return matches.length === 1 ? matches[0].id : '';
  }

  function parseOcrRows(tsv, context) {
    // En tablas escaneadas, Tesseract suele asignar un line_num distinto a
    // cada celda. Reconstruimos las filas por su banda vertical para no perder
    // una consulta solo porque sus columnas se segmentaron por separado.
    const lines = tsvRowBands(tsv);
    // No descartamos una fila solo porque el OCR haya estropeado la fecha o la
    // hora. Una línea que conserva prestación + realizada/NREG también debe
    // llegar a revisión manual; la validación posterior fallará de forma cerrada.
    const candidates = lines.filter(line => {
      const value = line.text;
      const hasDate = /\b\d{2}\/\d{2}\/\d{4}\b/.test(value);
      const hasTime = /\b\d{1,2}:\d{2}\b/.test(value);
      const hasService = /\b(?:[A-Z]{1,8}\d*[.]\d+[A-Z]?|\d+[.]\d+[A-Z]?)\b/i.test(value);
      const hasPerformed = /\b(?:URG(?:ENTE)?|S[IÍ]|NO)\b/i.test(value);
      const hasNreg = /\b\d{6,}\b/.test(value);
      return hasDate || hasTime || (hasService && (hasPerformed || hasNreg));
    });
    const rows = candidates.map((line, index) => {
      const date = line.text.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0] || '';
      const time = line.text.match(/\b\d{1,2}:\d{2}\b/)?.[0] || '';
      const afterTime = time ? line.text.slice(line.text.indexOf(time) + time.length) : line.text;
      const service = afterTime.match(/\b(?:[A-Z]{1,8}\d*[.]\d+[A-Z]?|\d+[.]\d+[A-Z]?)\b/i)?.[0] || '';
      const performed = line.text.match(/\b(?:URG(?:ENTE)?|S[IÍ]|NO)\b/i)?.[0] || '';
      // El NREG sigue siendo recuperable aunque la celda SI/NO/URG quede
      // ilegible. La fecha contiene separadores, por lo que no se confunde con
      // esta secuencia continua de seis o más dígitos.
      const nreg = line.text.match(/\b\d{6,}\b/)?.[0] || '';
      const discharge = line.text.match(/\b[01]\s*$/)?.[0]?.trim() || '';
      const row = normalizeRow({
        fecha: date, hora: time, prestacion: service, realizada: performed, nreg, alta: discharge, confidence: line.confidence,
      }, { ...context, fila: index + 1 });
      row.raw_text = line.text;
      row.source_y = line.y;
      return row;
    });
    return { rows, candidates, detectedLines: lines.length, candidateCount: candidates.length };
  }

  function mergeAggregateRows(groups) {
    const merged = new Map();
    for (const group of groups || []) {
      const key = [group.fecha_iso, group.medico_id, group.agenda_id, group.prestacion, group.realizada, group.alta].join('|');
      const current = merged.get(key) || { ...group, count: 0 };
      current.count += Number(group.count) || 0;
      merged.set(key, current);
    }
    return [...merged.values()].sort((a, b) => [a.fecha_iso, a.medico_id, a.agenda_id, a.prestacion, a.realizada, a.alta].join('|').localeCompare([b.fecha_iso, b.medico_id, b.agenda_id, b.prestacion, b.realizada, b.alta].join('|')));
  }

  function buildAggregateIndex(batches, auditEvents = []) {
    const annulled = new Set((auditEvents || []).filter(event => event?.type === 'annul_batch').map(event => text(event.batch_id)).filter(Boolean));
    const active = (batches || []).filter(batch => batch?.status === 'active' && !annulled.has(batch.id));
    const aggregates = mergeAggregateRows(active.flatMap(batch => batch.aggregates || []));
    return {
      schema_version: 'ariadna-activity-index-v1',
      rebuilt_at: new Date().toISOString(),
      active_batches: active.map(batch => ({
        id: batch.id,
        created_at: batch.created_at,
        source_sha256: batch.source?.sha256 || '',
        pages: Number(batch.source?.pages) || 0,
        rows: Number(batch.rows_included) || 0,
        duplicates_excluded: Number(batch.duplicate_rows_excluded) || 0,
        summary: batch.summary || summarizeAggregates(batch.aggregates || []),
      })),
      annulled_batches: [...annulled],
      aggregates,
      summary: summarizeAggregates(aggregates),
    };
  }

  const dbName = 'ariadna-activity-local-v1';
  function openDb() {
    if (!global.indexedDB) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const request = global.indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('checkpoints')) db.createObjectStore('checkpoints', { keyPath: 'file_hash' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function checkpointPut(value) {
    const db = await openDb(); if (!db) return false;
    await new Promise((resolve, reject) => {
      const tx = db.transaction('checkpoints', 'readwrite');
      tx.objectStore('checkpoints').put(clone(value));
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    db.close(); return true;
  }

  async function checkpointGet(fileHash) {
    const db = await openDb(); if (!db) return null;
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction('checkpoints', 'readonly');
      const request = tx.objectStore('checkpoints').get(fileHash);
      request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error);
    });
    db.close(); return result;
  }

  async function checkpointDelete(fileHash) {
    const db = await openDb(); if (!db) return false;
    await new Promise((resolve, reject) => {
      const tx = db.transaction('checkpoints', 'readwrite');
      tx.objectStore('checkpoints').delete(fileHash);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    db.close(); return true;
  }

  global.AriadnaActivityCore = Object.freeze({
    SCHEMA_VERSION, CONFIG_SCHEMA, MAX_PAGES, DEFAULT_MASK,
    canonicalCode, slug, normalizedMask, defaultCatalogs, normalizeCatalogs,
    parseDate, normalizeTime, normalizePerformed, normalizeDischarge, normalizeNreg,
    normalizeRow, rowIsValid, groupRows, summarizeAggregates,
    sha256Hex, getOrCreateHmacSecret, hmacNreg, prepareBatch,
    parseTsv, tsvLines, tsvRowBands, detectAgenda, parseOcrRows, mergeAggregateRows, buildAggregateIndex,
    checkpointPut, checkpointGet, checkpointDelete,
  });
})(typeof window !== 'undefined' ? window : globalThis);
