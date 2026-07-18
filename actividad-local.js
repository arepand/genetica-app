(function activityLocalFactory(global) {
  'use strict';

  const core = global.AriadnaActivityCore;
  if (!core) throw new Error('AriadnaActivityCore debe cargarse antes de actividad-local.js.');
  const ACTIVITY_SCRIPT_BASE = new URL('./', global.document?.currentScript?.src || global.location?.href);

  const PATHS = Object.freeze({
    catalogs: 'activity/config/catalogs.json',
    index: 'activity/index.json',
    dedup: 'activity/dedup/index.json',
    batches: 'activity/batches',
    audit: 'activity/audit',
  });
  const CACHE_KEY = 'fh_activity_public_state_v1';
  const SECRET_KEY = 'fh_activity_hmac_secret_v1';
  const LOW_CONFIDENCE = 70;
  const state = {
    adapter: null,
    loaded: false,
    loading: null,
    catalogs: core.defaultCatalogs(),
    catalogsSha: null,
    index: emptyIndex(),
    indexSha: null,
    dedup: emptyDedup(),
    dedupSha: null,
    view: 'dashboard',
    filters: { from: '', to: '', doctor: [], agenda: [], service: [], performed: [] },
    wizard: null,
    pdfjs: null,
    ocrWorker: null,
    ocrProgress: null,
  };

  function emptyIndex() {
    return { schema_version: 'ariadna-activity-index-v1', rebuilt_at: null, active_batches: [], annulled_batches: [], aggregates: [], summary: core.summarizeAggregates([]) };
  }
  function emptyDedup() { return { schema_version: 'ariadna-activity-dedup-v1', revision: 1, active: {} }; }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function esc(value) { return state.adapter?.escHtml ? state.adapter.escHtml(value) : String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
  function toast(message) { if (state.adapter?.showToast) state.adapter.showToast(message); }
  function configured() { return !!state.adapter?.ghConfigured?.(); }
  function cacheState() {
    const value = { catalogs: state.catalogs, index: state.index, dedup: state.dedup, cached_at: new Date().toISOString() };
    if (state.adapter?.safeLocalSet) state.adapter.safeLocalSet(CACHE_KEY, JSON.stringify(value));
    else { try { global.localStorage.setItem(CACHE_KEY, JSON.stringify(value)); } catch (_) {} }
  }
  function loadCache() {
    try {
      const value = JSON.parse(global.localStorage.getItem(CACHE_KEY) || 'null');
      if (value?.catalogs) state.catalogs = core.normalizeCatalogs(value.catalogs);
      if (value?.index) state.index = { ...emptyIndex(), ...value.index };
      if (value?.dedup) state.dedup = { ...emptyDedup(), ...value.dedup, active: value.dedup.active || {} };
    } catch (_) {}
  }

  function configure(adapter) {
    state.adapter = adapter || {};
    injectStyles();
    return api;
  }

  async function load(force = false) {
    if (state.loading && !force) return state.loading;
    state.loading = (async () => {
      loadCache();
      if (configured()) {
        const [catalogs, index, dedup] = await Promise.all([
          safeGet(PATHS.catalogs), safeGet(PATHS.index), safeGet(PATHS.dedup),
        ]);
        if (catalogs?.json) { state.catalogs = core.normalizeCatalogs(catalogs.json); state.catalogsSha = catalogs.sha; }
        if (index?.json) { state.index = { ...emptyIndex(), ...index.json }; state.indexSha = index.sha; }
        if (dedup?.json) { state.dedup = { ...emptyDedup(), ...dedup.json, active: dedup.json.active || {} }; state.dedupSha = dedup.sha; }
      }
      state.loaded = true;
      cacheState();
      return state;
    })().finally(() => { state.loading = null; });
    return state.loading;
  }

  async function safeGet(path) {
    try { return await state.adapter.ghGetFile(path); }
    catch (error) { console.warn('Actividad local GET', path, error); return null; }
  }

  async function render(box) {
    if (!box) return;
    if (!state.loaded) {
      box.innerHTML = '<div class="activity-shell"><div class="sec-note">Cargando actividad local segura…</div></div>';
      await load();
    }
    if (state.view === 'wizard') return renderWizard(box);
    if (state.view === 'catalogs') return renderCatalogs(box);
    return renderDashboard(box);
  }

  function renderDashboard(box) {
    const aggregates = filteredAggregates();
    const summary = core.summarizeAggregates(aggregates);
    const all = state.index.aggregates || [];
    const catalogs = state.catalogs;
    box.innerHTML = `<div class="activity-shell">
      <div class="activity-head">
        <div><h2>📊 Cuadro de mando · actividad de consulta</h2><div class="dx-meta">Importación local privada · ningún PDF, imagen, nombre ni NREG sale del navegador.</div></div>
        <div class="activity-actions"><button class="btn ghost" data-act="catalogs">Catálogos</button><button class="btn primary" data-act="new">Preparar lote</button></div>
      </div>
      ${configured() ? '' : '<div class="activity-warning">Configura primero el repositorio privado de GitHub. El OCR puede probarse localmente, pero no se podrá confirmar un lote.</div>'}
      <div class="activity-privacy"><b>Privacidad por diseño:</b> PDF.js, OCR, máscara y revisión se ejecutan en este navegador. GitHub recibe únicamente agregados diarios, huellas HMAC y auditoría de lotes.</div>
      ${renderFilters(all, catalogs)}
      <div class="activity-cards">
        ${metric('Consultas', summary.total)}${metric('Realizadas', summary.realized)}${metric('Urgentes', summary.urgent)}${metric('Alta = 1', summary.followup)}
      </div>
      <div class="activity-grid">
        ${breakdown('Por médico', aggregates, 'medico_id', catalogs.doctors)}
        ${breakdown('Por agenda', aggregates, 'agenda_id', catalogs.agendas)}
        ${breakdown('Por prestación', aggregates, 'prestacion', catalogs.services, true)}
        ${breakdown('Por resultado', aggregates, 'realizada', [])}
      </div>
      ${quarterTable(aggregates)}
      ${batchTable()}
      <details class="activity-technical"><summary>Seguridad, recuperación y diagnóstico</summary>
        <p>Clave HMAC: permanece únicamente en este navegador. Guarda una copia de recuperación para poder detectar solapamientos desde otro navegador.</p>
        <div class="activity-actions"><button class="btn ghost" data-act="secret-export">Guardar clave de recuperación</button><label class="btn ghost activity-file-label">Restaurar clave<input type="file" accept="application/json" data-secret-import hidden></label><button class="btn ghost" data-act="refresh">Refrescar desde GitHub</button></div>
        <div class="dx-meta">${state.index.rebuilt_at ? 'Índice verificado: ' + esc(new Date(state.index.rebuilt_at).toLocaleString('es-ES')) : 'Todavía no hay lotes confirmados.'}</div>
      </details>
    </div>`;
    wireDashboard(box);
  }

  function metric(label, value) { return `<div class="activity-metric"><span>${esc(label)}</span><b>${Number(value) || 0}</b></div>`; }
  function itemLabel(items, value, isCode) {
    if (isCode) return items.find(item => item.code === value)?.label || value || '—';
    return items.find(item => item.id === value)?.label || value || '—';
  }
  function breakdown(title, rows, field, items, isCode = false) {
    const counts = new Map();
    for (const row of rows) counts.set(row[field] || '—', (counts.get(row[field] || '—') || 0) + (Number(row.count) || 0));
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...sorted.map(entry => entry[1]));
    return `<section class="activity-panel"><h3>${esc(title)}</h3>${sorted.length ? sorted.map(([key, count]) => `<div class="activity-bar-row"><span>${esc(itemLabel(items, key, isCode))}</span><div><i style="width:${Math.max(2, count / max * 100)}%"></i></div><b>${count}</b></div>`).join('') : '<div class="dx-meta">Sin datos en el rango.</div>'}</section>`;
  }
  function renderFilters(rows, catalogs) {
    const minDate = rows.map(row => row.fecha_iso).filter(Boolean).sort()[0] || '';
    const maxDate = rows.map(row => row.fecha_iso).filter(Boolean).sort().slice(-1)[0] || '';
    const select = (name, label, options, getValue, getLabel) => `<label>${esc(label)}<select multiple data-filter="${name}">${options.map(item => `<option value="${esc(getValue(item))}" ${state.filters[name].includes(getValue(item)) ? 'selected' : ''}>${esc(getLabel(item))}</option>`).join('')}</select></label>`;
    return `<details class="activity-filters" open><summary>Filtros</summary><div class="activity-filter-grid">
      <label>Desde<input type="date" data-date="from" value="${esc(state.filters.from || minDate)}"></label>
      <label>Hasta<input type="date" data-date="to" value="${esc(state.filters.to || maxDate)}"></label>
      ${select('doctor', 'Médicos', catalogs.doctors, item => item.id, item => item.label)}
      ${select('agenda', 'Agendas', catalogs.agendas, item => item.id, item => item.label)}
      ${select('service', 'Prestaciones', catalogs.services, item => item.code, item => `${item.code} · ${item.label}`)}
      ${select('performed', 'Realizada', ['SI', 'URG', 'NO'], item => item, item => item)}
    </div><div class="activity-actions"><button class="btn ghost" data-act="apply-filters">Aplicar</button><button class="btn ghost" data-act="clear-filters">Todo</button></div></details>`;
  }
  function filteredAggregates() {
    const f = state.filters;
    return (state.index.aggregates || []).filter(row => {
      if (f.from && row.fecha_iso < f.from) return false;
      if (f.to && row.fecha_iso > f.to) return false;
      if (f.doctor.length && !f.doctor.includes(row.medico_id)) return false;
      if (f.agenda.length && !f.agenda.includes(row.agenda_id)) return false;
      if (f.service.length && !f.service.includes(row.prestacion)) return false;
      if (f.performed.length && !f.performed.includes(row.realizada)) return false;
      return true;
    });
  }
  function quarterTable(rows) {
    const map = new Map();
    for (const row of rows) {
      const match = String(row.fecha_iso || '').match(/^(\d{4})-(\d{2})/); if (!match) continue;
      const quarter = `${match[1]} T${Math.floor((Number(match[2]) - 1) / 3) + 1}`;
      const key = [quarter, row.agenda_id, row.prestacion].join('|');
      map.set(key, (map.get(key) || 0) + (Number(row.count) || 0));
    }
    const data = [...map.entries()].map(([key, count]) => [...key.split('|'), count]).sort((a, b) => b[0].localeCompare(a[0]) || b[3] - a[3]);
    return `<section class="activity-panel activity-wide"><h3>Resumen trimestral por agenda y prestación</h3>${data.length ? `<div class="activity-table-wrap"><table><thead><tr><th>Trimestre</th><th>Agenda</th><th>Prestación</th><th>Total</th></tr></thead><tbody>${data.map(([q, agenda, service, count]) => `<tr><td>${esc(q)}</td><td>${esc(itemLabel(state.catalogs.agendas, agenda))}</td><td>${esc(service)} · ${esc(itemLabel(state.catalogs.services, service, true))}</td><td>${count}</td></tr>`).join('')}</tbody></table></div>` : '<div class="dx-meta">Sin datos.</div>'}</section>`;
  }
  function batchTable() {
    const batches = state.index.active_batches || [];
    const annulled = new Set(state.index.annulled_batches || []);
    return `<section class="activity-panel activity-wide"><h3>Lotes y trazabilidad</h3>${batches.length ? `<div class="activity-table-wrap"><table><thead><tr><th>Fecha</th><th>Lote</th><th>Páginas</th><th>Filas</th><th>Duplicados</th><th></th></tr></thead><tbody>${batches.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map(batch => `<tr><td>${esc(new Date(batch.created_at).toLocaleString('es-ES'))}</td><td><code>${esc(batch.id)}</code></td><td>${batch.pages || 0}</td><td>${batch.rows || 0}</td><td>${batch.duplicates_excluded || 0}</td><td>${annulled.has(batch.id) ? 'Anulado' : `<button class="btn ghost" data-annul="${esc(batch.id)}">Anular</button>`}</td></tr>`).join('')}</tbody></table></div>` : '<div class="dx-meta">El histórico nuevo empieza en cero. Los tres registros erróneos antiguos no se migran.</div>'}</section>`;
  }

  function wireDashboard(box) {
    box.querySelector('[data-act="new"]')?.addEventListener('click', () => { state.view = 'wizard'; state.wizard = freshWizard(); render(box); });
    box.querySelector('[data-act="catalogs"]')?.addEventListener('click', () => { state.view = 'catalogs'; render(box); });
    box.querySelector('[data-act="apply-filters"]')?.addEventListener('click', () => { readFilters(box); render(box); });
    box.querySelector('[data-act="clear-filters"]')?.addEventListener('click', () => { state.filters = { from: '', to: '', doctor: [], agenda: [], service: [], performed: [] }; render(box); });
    box.querySelector('[data-act="refresh"]')?.addEventListener('click', async () => { state.loaded = false; await load(true); toast('Actividad actualizada'); render(box); });
    box.querySelector('[data-act="secret-export"]')?.addEventListener('click', exportSecret);
    box.querySelector('[data-secret-import]')?.addEventListener('change', event => importSecret(event.target.files?.[0]));
    box.querySelectorAll('[data-annul]').forEach(button => button.addEventListener('click', () => annulBatch(button.dataset.annul, box)));
  }
  function readFilters(box) {
    box.querySelectorAll('[data-date]').forEach(input => { state.filters[input.dataset.date] = input.value; });
    box.querySelectorAll('[data-filter]').forEach(select => { state.filters[select.dataset.filter] = [...select.selectedOptions].map(option => option.value); });
  }

  function freshWizard() {
    return {
      step: 'select', doctorId: '', file: null, fileName: '', fileHash: '', pdf: null, pageCount: 0, currentPage: 1,
      pages: [], running: false, error: '', duplicateConfirmed: false, prepared: null,
    };
  }

  async function renderWizard(box) {
    const wizard = state.wizard || (state.wizard = freshWizard());
    const steps = ['select', 'protect', 'ocr', 'review', 'save'];
    const active = Math.max(0, steps.indexOf(wizard.step));
    box.innerHTML = `<div class="activity-shell">
      <div class="activity-head"><div><h2>Importar actividad</h2><div class="dx-meta">Asistente local seguro · máximo ${core.MAX_PAGES} páginas</div></div><button class="btn ghost" data-wiz="cancel">Volver al cuadro de mando</button></div>
      <ol class="activity-steps">${['Preparar lote', 'Proteger páginas', 'OCR local', 'Revisar y conciliar', 'Confirmar y guardar'].map((label, index) => `<li class="${index < active ? 'done' : index === active ? 'active' : ''}"><b>${index + 1}</b>${label}</li>`).join('')}</ol>
      ${wizard.error ? `<div class="activity-error">${esc(wizard.error)}</div>` : ''}
      <div id="activityWizardBody">${wizardStepHtml(wizard)}</div>
    </div>`;
    wireWizard(box, wizard);
    if (wizard.step === 'protect') await drawCurrentPage(box, false);
  }

  function wizardStepHtml(wizard) {
    if (wizard.step === 'select') return selectStep(wizard);
    if (wizard.step === 'protect') return protectStep(wizard);
    if (wizard.step === 'ocr') return ocrStep(wizard);
    if (wizard.step === 'review') return reviewStep(wizard);
    return saveStep(wizard);
  }
  function selectStep(wizard) {
    const activeDoctors = state.catalogs.doctors.filter(item => item.active);
    return `<section class="activity-panel activity-wide"><h3>1. Preparar lote</h3>
      <div class="activity-form-grid"><label>Médico del PDF <select data-wiz-doctor><option value="">Selecciona obligatoriamente…</option>${activeDoctors.map(item => `<option value="${esc(item.id)}" ${wizard.doctorId === item.id ? 'selected' : ''}>${esc(item.code)} · ${esc(item.label)}</option>`).join('')}</select></label>
      <label>PDF escaneado <input type="file" accept="application/pdf" data-wiz-file></label></div>
      <div class="activity-privacy"><b>El archivo no se sube.</b> Se calcula su SHA-256 local y se abre con el PDF.js incluido en Ariadna.</div>
      ${wizard.fileHash ? `<p>Archivo preparado: <b>${esc(wizard.fileName)}</b> · ${wizard.pageCount} página(s) · <code>${esc(wizard.fileHash.slice(0, 16))}…</code></p>` : ''}
      <div class="activity-actions"><button class="btn primary" data-wiz="protect" ${wizard.fileHash && wizard.doctorId ? '' : 'disabled'}>Revisar protección de las páginas</button></div>
    </section>`;
  }
  function protectStep(wizard) {
    const page = wizard.pages[wizard.currentPage - 1];
    const confirmed = wizard.pages.filter(item => item.maskConfirmed).length;
    return `<section class="activity-panel activity-wide"><h3>2. Proteger páginas</h3>
      <p>Comprueba que el rectángulo cubra por completo la columna «Paciente» sin tapar NREG ni Alta. Arrástralo o usa los controles; cada página debe confirmarse.</p>
      <div class="activity-page-nav"><button class="btn ghost" data-wiz="prev" ${wizard.currentPage <= 1 ? 'disabled' : ''}>←</button><b>Página ${wizard.currentPage} de ${wizard.pageCount}</b><button class="btn ghost" data-wiz="next" ${wizard.currentPage >= wizard.pageCount ? 'disabled' : ''}>→</button><span>${confirmed}/${wizard.pageCount} protegidas</span></div>
      <div class="activity-preview-wrap"><canvas id="activityPageCanvas"></canvas><div id="activityMask" class="activity-mask"><span>Paciente protegido</span><i></i></div></div>
      <div class="activity-control-grid">
        ${range('mask-x', 'Inicio X', page.mask.x, 0, 0.95, 0.005)}${range('mask-width', 'Ancho', page.mask.width, 0.02, 0.6, 0.005)}
        ${range('rotation', 'Rotación', page.rotation, 0, 270, 90)}${range('deskew', 'Ajuste fino', page.deskew, -5, 5, 0.1)}
        ${range('contrast', 'Contraste', page.contrast, 0.5, 2.5, 0.05)}${range('threshold', 'Umbral (0 = no)', page.threshold, 0, 255, 1)}
      </div>
      <div class="activity-actions"><button class="btn ghost" data-wiz="reset-page">Restablecer página</button><button class="btn ghost" data-wiz="copy-mask">Aplicar esta máscara a páginas sin confirmar</button><button class="btn primary" data-wiz="confirm-mask">${page.maskConfirmed ? '✓ Protección confirmada' : 'Confirmar esta página'}</button></div>
      <div class="activity-actions activity-end"><button class="btn primary" data-wiz="start-ocr" ${confirmed === wizard.pageCount ? '' : 'disabled'}>Iniciar OCR local</button></div>
    </section>`;
  }
  function range(name, label, value, min, max, step) { return `<label>${esc(label)}<input type="range" data-control="${name}" min="${min}" max="${max}" step="${step}" value="${Number(value)}"><output>${Number(value).toFixed(step < 1 ? 2 : 0)}</output></label>`; }
  function ocrStep(wizard) {
    const done = wizard.pages.filter(page => page.ocrStatus === 'completed').length;
    const current = wizard.pages.find(page => page.ocrStatus === 'running');
    return `<section class="activity-panel activity-wide"><h3>3. OCR local</h3><p>Un único worker procesa una página cada vez y libera el lienzo al terminar. No se utiliza ninguna API externa.</p>
      <div class="activity-progress"><i style="width:${wizard.pageCount ? done / wizard.pageCount * 100 : 0}%"></i></div><p><b>${done}/${wizard.pageCount}</b> páginas${current ? ` · procesando página ${current.number}` : ''}</p>
      <div class="dx-meta">${state.ocrProgress ? esc(`${state.ocrProgress.status || ''} ${Math.round((state.ocrProgress.progress || 0) * 100)} %`) : 'Preparando motor OCR incluido en Ariadna…'}</div>
    </section>`;
  }
  function reviewStep(wizard) {
    const pages = wizard.pages;
    const rows = pages.flatMap(page => page.rows || []);
    const valid = rows.filter(reviewRowValid).length;
    return `<section class="activity-panel activity-wide"><h3>4. Revisar y conciliar el 100 %</h3>
      <p>Cada banda de fila detectada debe corresponder a una fila revisada. Una incidencia bloquea el lote completo: no se puede omitir silenciosamente.</p>
      <div class="activity-cards">${metric('Filas detectadas', pages.reduce((sum, page) => sum + Number(page.expectedCount || 0), 0))}${metric('Filas transcritas', rows.length)}${metric('Revisadas y válidas', valid)}${metric('Incidencias', rows.length - valid)}</div>
      ${pages.map(page => reviewPage(page)).join('')}
      <div class="activity-actions activity-end"><button class="btn ghost" data-wiz="back-protect">Volver a protección</button><button class="btn primary" data-wiz="prepare-save" ${canPrepare(wizard) ? '' : 'disabled'}>Preparar confirmación</button></div>
    </section>`;
  }
  function reviewPage(page) {
    return `<details class="activity-review-page" open data-page="${page.number}"><summary><b>Página ${page.number}</b> · ${page.rows.length}/${page.expectedCount} filas · agenda ${esc(itemLabel(state.catalogs.agendas, page.agendaId) || 'pendiente')}</summary>
      <div class="activity-form-grid"><label>Agenda de esta página <select data-page-agenda="${page.number}"><option value="">Confirma la agenda…</option>${state.catalogs.agendas.filter(item => item.active).map(item => `<option value="${esc(item.id)}" ${page.agendaId === item.id ? 'selected' : ''}>${esc(item.code)} · ${esc(item.label)}</option>`).join('')}</select></label>
      <label>Filas visibles en el original <input type="number" min="${page.candidateCount || 0}" max="200" value="${page.expectedCount}" data-expected="${page.number}"></label></div>
      ${page.ocrTextHint ? `<details class="activity-ocr-hint"><summary>Diagnóstico OCR local anonimizado</summary><pre>${page.ocrDiagnostics ? `${esc(`${page.ocrDiagnostics.words} palabras · ${page.ocrDiagnostics.bands} bandas · TSV ${page.ocrDiagnostics.tsvChars} caracteres`)}\n\n` : ''}${esc(page.ocrTextHint)}</pre></details>` : ''}
      <div class="activity-table-wrap"><table class="activity-review-table"><thead><tr><th>Fecha</th><th>Hora</th><th>Prestación</th><th>Realizada</th><th>NREG</th><th>Alta</th><th>Conf.</th><th>Revisada</th></tr></thead><tbody>${page.rows.map((row, index) => reviewRow(page, row, index)).join('')}</tbody></table></div>
      <div class="activity-actions"><button class="btn ghost" data-add-row="${page.number}">Añadir fila que el OCR no detectó</button><button class="btn ghost" data-check-page="${page.number}">Marcar como revisadas las filas válidas</button></div>
    </details>`;
  }
  function reviewRow(page, row, index) {
    const normalized = normalizedReviewRow(row, page);
    const knownService = state.catalogs.services.some(item => item.code === normalized.prestacion);
    const issues = normalized.issues.concat(knownService || !normalized.prestacion ? [] : ['Prestación no incluida en el catálogo.']);
    const low = Number(row.confidence) < LOW_CONFIDENCE;
    return `<tr data-review-row="${page.number}:${index}" class="${issues.length || !row.reviewed || (normalized.nreg_length_warning && !row.nregLengthConfirmed) ? 'has-issue' : ''}">
      ${reviewInput('fecha', row.fecha)}${reviewInput('hora', row.hora)}${reviewInput('prestacion', row.prestacion)}
      <td><select data-field="realizada"><option></option>${['SI', 'NO', 'URG'].map(value => `<option ${row.realizada === value ? 'selected' : ''}>${value}</option>`).join('')}</select></td>
      ${reviewInput('nreg', row.nreg)}<td><select data-field="alta"><option></option>${['0', '1'].map(value => `<option ${row.alta === value ? 'selected' : ''}>${value}</option>`).join('')}</select></td>
      <td class="${low ? 'activity-low' : ''}">${Math.round(Number(row.confidence) || 0)} %${normalized.nreg_length_warning ? `<label class="activity-inline-check"><input type="checkbox" data-nreg-confirm ${row.nregLengthConfirmed ? 'checked' : ''}> longitud ${esc(String(row.nreg || '').length)}</label>` : ''}</td>
      <td><label class="activity-inline-check"><input type="checkbox" data-reviewed ${row.reviewed ? 'checked' : ''}> ✓</label>${!knownService && normalized.prestacion ? `<button class="btn ghost activity-add-service" data-add-service="${esc(normalized.prestacion)}">Añadir ${esc(normalized.prestacion)} al catálogo</button>` : ''}${issues.length ? `<div class="activity-row-issues">${issues.map(esc).join('<br>')}</div>` : ''}</td></tr>`;
  }
  function reviewInput(field, value) { return `<td><input data-field="${field}" value="${esc(value || '')}"></td>`; }
  function normalizedReviewRow(row, page) {
    return core.normalizeRow(row, { medico_id: state.wizard.doctorId, agenda_id: page.agendaId, pagina: page.number, fila: row.fila });
  }
  function reviewRowValid(row, page) {
    const normalized = normalizedReviewRow(row, page);
    const knownService = state.catalogs.services.some(item => item.code === normalized.prestacion);
    return core.rowIsValid(normalized) && knownService && row.reviewed && (!normalized.nreg_length_warning || row.nregLengthConfirmed);
  }
  function canPrepare(wizard) {
    return wizard.pages.every(page => page.agendaId && page.rows.length === Number(page.expectedCount) && page.rows.every(row => reviewRowValid(row, page)));
  }
  function saveStep(wizard) {
    const prepared = wizard.prepared;
    const rows = wizard.pages.flatMap(page => page.rows || []);
    return `<section class="activity-panel activity-wide"><h3>5. Confirmar y guardar</h3>
      <div class="activity-privacy"><b>Lo que saldrá del navegador:</b> ${rows.length} HMAC irreversibles para deduplicar, agregados diarios y metadatos del lote. No saldrán PDF, imágenes, nombre, NREG, hora ni filas individuales.</div>
      ${prepared ? `<div class="activity-cards">${metric('Filas del PDF', prepared.batch.rows_reconciled)}${metric('Incluidas', prepared.batch.rows_included)}${metric('Duplicadas', prepared.batch.duplicate_rows_excluded)}${metric('Grupos agregados', prepared.batch.aggregates.length)}</div>
        ${prepared.duplicates.length ? `<div class="activity-warning"><b>${prepared.duplicates.length} fila(s) ya constan en lotes activos.</b> Se excluirán del nuevo lote. <label class="activity-inline-check"><input type="checkbox" data-duplicate-confirm ${wizard.duplicateConfirmed ? 'checked' : ''}> Confirmo esta exclusión</label></div>` : ''}` : '<div class="sec-note">Calculando deduplicación local…</div>'}
      <div class="activity-actions activity-end"><button class="btn ghost" data-wiz="back-review">Volver a revisión</button><button class="btn primary" data-wiz="commit" ${prepared && (!prepared.duplicates.length || wizard.duplicateConfirmed) && configured() ? '' : 'disabled'}>Confirmar y guardar en GitHub privado</button></div>
    </section>`;
  }

  function wireWizard(box, wizard) {
    box.querySelector('[data-wiz="cancel"]')?.addEventListener('click', async () => { await releasePdf(); state.view = 'dashboard'; state.wizard = null; render(box); });
    box.querySelector('[data-wiz-doctor]')?.addEventListener('change', event => { wizard.doctorId = event.target.value; render(box); });
    box.querySelector('[data-wiz-file]')?.addEventListener('change', event => prepareFile(event.target.files?.[0], box));
    box.querySelector('[data-wiz="protect"]')?.addEventListener('click', async () => { wizard.step = 'protect'; wizard.currentPage = 1; render(box); });
    box.querySelector('[data-wiz="prev"]')?.addEventListener('click', () => { wizard.currentPage--; render(box); });
    box.querySelector('[data-wiz="next"]')?.addEventListener('click', () => { wizard.currentPage++; render(box); });
    box.querySelectorAll('[data-control]').forEach(input => input.addEventListener('input', () => updatePageControls(box)));
    box.querySelector('[data-wiz="reset-page"]')?.addEventListener('click', () => { const page = wizard.pages[wizard.currentPage - 1]; Object.assign(page, { mask: clone(core.DEFAULT_MASK), rotation: 0, deskew: 0, contrast: 1, threshold: 0, maskConfirmed: false }); saveCheckpoint(); render(box); });
    box.querySelector('[data-wiz="copy-mask"]')?.addEventListener('click', () => { const source = wizard.pages[wizard.currentPage - 1]; wizard.pages.forEach(page => { if (!page.maskConfirmed) page.mask = clone(source.mask); }); saveCheckpoint(); toast('Máscara copiada a las páginas sin confirmar'); render(box); });
    box.querySelector('[data-wiz="confirm-mask"]')?.addEventListener('click', () => { wizard.pages[wizard.currentPage - 1].maskConfirmed = true; if (wizard.currentPage < wizard.pageCount) wizard.currentPage++; saveCheckpoint(); render(box); });
    box.querySelector('[data-wiz="start-ocr"]')?.addEventListener('click', () => runOcr(box));
    box.querySelector('[data-wiz="back-protect"]')?.addEventListener('click', () => { wizard.step = 'protect'; render(box); });
    wireReview(box, wizard);
    box.querySelector('[data-wiz="prepare-save"]')?.addEventListener('click', () => prepareSave(box));
    box.querySelector('[data-wiz="back-review"]')?.addEventListener('click', () => { wizard.step = 'review'; wizard.prepared = null; render(box); });
    box.querySelector('[data-duplicate-confirm]')?.addEventListener('change', event => { wizard.duplicateConfirmed = event.target.checked; render(box); });
    box.querySelector('[data-wiz="commit"]')?.addEventListener('click', () => commitBatch(box));
  }

  async function prepareFile(file, box) {
    const wizard = state.wizard; wizard.error = '';
    if (!file || file.type !== 'application/pdf') { wizard.error = 'Selecciona un PDF.'; return render(box); }
    try {
      const buffer = await file.arrayBuffer();
      const hash = await core.sha256Hex(buffer);
      if ((state.index.active_batches || []).some(batch => batch.source_sha256 === hash)) throw new Error('Este PDF exacto ya pertenece a un lote activo. Si la importación era errónea, anula primero ese lote.');
      const pdfjs = await getPdfjs();
      const loading = pdfjs.getDocument({ data: new Uint8Array(buffer) });
      const pdf = await loading.promise;
      if (pdf.numPages < 1 || pdf.numPages > core.MAX_PAGES) { await pdf.destroy(); throw new Error(`El PDF debe tener entre 1 y ${core.MAX_PAGES} páginas.`); }
      await releasePdf();
      wizard.file = file; wizard.fileName = file.name; wizard.fileHash = hash; wizard.pdf = pdf; wizard.pageCount = pdf.numPages;
      wizard.pages = Array.from({ length: pdf.numPages }, (_, index) => ({ number: index + 1, mask: clone(state.catalogs.templates[0]?.mask || core.DEFAULT_MASK), rotation: 0, deskew: 0, contrast: 1, threshold: 0, maskConfirmed: false, ocrStatus: 'pending', rows: [], expectedCount: 0, candidateCount: 0, agendaId: '' }));
      const checkpoint = await core.checkpointGet(hash);
      if (checkpoint?.pages?.length === pdf.numPages) {
        wizard.doctorId = checkpoint.doctorId || wizard.doctorId;
        wizard.pages = checkpoint.pages.map((page, index) => ({ ...wizard.pages[index], ...page, mask: core.normalizedMask(page.mask || wizard.pages[index].mask) }));
        wizard.prepared = checkpoint.prepared || null;
        wizard.duplicateConfirmed = checkpoint.duplicateConfirmed === true;
        if (['protect', 'review', 'save'].includes(checkpoint.step)) wizard.step = checkpoint.step;
        toast('Checkpoint local recuperado');
      }
    } catch (error) { wizard.error = error.message || String(error); }
    render(box);
  }

  async function getPdfjs() {
    if (state.pdfjs) return state.pdfjs;
    state.pdfjs = await import('./vendor/activity/pdfjs/pdf.min.mjs');
    // PDF.js resuelve las rutas relativas desde su propio módulo. Entregarle
    // una URL absoluta evita duplicar `vendor/activity/pdfjs/` en navegador.
    state.pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/activity/pdfjs/pdf.worker.min.mjs', ACTIVITY_SCRIPT_BASE).href;
    return state.pdfjs;
  }
  async function releasePdf() {
    const pdf = state.wizard?.pdf;
    if (pdf?.destroy) { try { await pdf.destroy(); } catch (_) {} }
    if (state.wizard) state.wizard.pdf = null;
  }

  async function drawCurrentPage(box, sanitized) {
    const wizard = state.wizard, pageState = wizard.pages[wizard.currentPage - 1], target = box.querySelector('#activityPageCanvas');
    if (!target || !wizard.pdf) return null;
    const canvas = await renderPageCanvas(pageState, sanitized, 1.6);
    target.width = canvas.width; target.height = canvas.height;
    target.getContext('2d').drawImage(canvas, 0, 0);
    canvas.width = 0; canvas.height = 0;
    positionMask(box, pageState);
    wireMaskDrag(box, pageState);
    return target;
  }
  async function renderPageCanvas(pageState, sanitized, scale = 2) {
    const pdfPage = await state.wizard.pdf.getPage(pageState.number);
    try {
      const initial = pdfPage.getViewport({ scale, rotation: Number(pageState.rotation) || 0 });
      const raw = document.createElement('canvas'); raw.width = Math.ceil(initial.width); raw.height = Math.ceil(initial.height);
      const rawContext = raw.getContext('2d', { willReadFrequently: true });
      await pdfPage.render({ canvasContext: rawContext, viewport: initial }).promise;
      const output = document.createElement('canvas'); output.width = raw.width; output.height = raw.height;
      const context = output.getContext('2d', { willReadFrequently: true });
      context.fillStyle = '#fff'; context.fillRect(0, 0, output.width, output.height);
      context.save(); context.translate(output.width / 2, output.height / 2); context.rotate((Number(pageState.deskew) || 0) * Math.PI / 180); context.drawImage(raw, -raw.width / 2, -raw.height / 2); context.restore();
      applyImageControls(context, output.width, output.height, pageState);
      if (sanitized) {
        const mask = core.normalizedMask(pageState.mask);
        context.fillStyle = '#fff'; context.fillRect(Math.floor(mask.x * output.width), Math.floor(mask.y * output.height), Math.ceil(mask.width * output.width), Math.ceil(mask.height * output.height));
      }
      raw.width = 0; raw.height = 0;
      return output;
    } finally { try { pdfPage.cleanup(); } catch (_) {} }
  }
  function applyImageControls(context, width, height, page) {
    const contrast = Number(page.contrast) || 1, threshold = Number(page.threshold) || 0;
    if (Math.abs(contrast - 1) < 0.01 && !threshold) return;
    const image = context.getImageData(0, 0, width, height), data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      for (let channel = 0; channel < 3; channel++) {
        let value = (data[i + channel] - 128) * contrast + 128;
        if (threshold) value = value >= threshold ? 255 : 0;
        data[i + channel] = Math.max(0, Math.min(255, value));
      }
    }
    context.putImageData(image, 0, 0);
  }
  function positionMask(box, pageState) {
    const mask = box.querySelector('#activityMask'), normalized = core.normalizedMask(pageState.mask); if (!mask) return;
    mask.style.left = `${normalized.x * 100}%`; mask.style.top = `${normalized.y * 100}%`; mask.style.width = `${normalized.width * 100}%`; mask.style.height = `${normalized.height * 100}%`;
  }
  function updatePageControls(box) {
    const page = state.wizard.pages[state.wizard.currentPage - 1];
    box.querySelectorAll('[data-control]').forEach(input => {
      const value = Number(input.value), name = input.dataset.control;
      input.nextElementSibling.textContent = value.toFixed(Number(input.step) < 1 ? 2 : 0);
      if (name === 'mask-x') page.mask.x = value;
      else if (name === 'mask-width') page.mask.width = value;
      else page[name] = value;
    });
    page.mask = core.normalizedMask(page.mask); page.maskConfirmed = false;
    saveCheckpoint();
    clearTimeout(updatePageControls.timer); updatePageControls.timer = setTimeout(() => drawCurrentPage(box, false), 100);
  }
  function wireMaskDrag(box, pageState) {
    const mask = box.querySelector('#activityMask'), wrap = box.querySelector('.activity-preview-wrap'); if (!mask || !wrap) return;
    const startDrag = (event, resize) => {
      event.preventDefault(); const rect = wrap.getBoundingClientRect(), startX = event.clientX, startY = event.clientY, initial = clone(pageState.mask);
      const move = moveEvent => {
        const dx = (moveEvent.clientX - startX) / rect.width, dy = (moveEvent.clientY - startY) / rect.height;
        if (resize) { pageState.mask.width = initial.width + dx; pageState.mask.height = initial.height + dy; }
        else { pageState.mask.x = initial.x + dx; pageState.mask.y = initial.y + dy; }
        pageState.mask = core.normalizedMask(pageState.mask); pageState.maskConfirmed = false; positionMask(box, pageState);
      };
      const stop = () => { global.removeEventListener('pointermove', move); global.removeEventListener('pointerup', stop); render(box); };
      global.addEventListener('pointermove', move); global.addEventListener('pointerup', stop);
    };
    mask.addEventListener('pointerdown', event => { if (event.target.tagName !== 'I') startDrag(event, false); });
    mask.querySelector('i')?.addEventListener('pointerdown', event => startDrag(event, true));
  }

  async function ensureOcrWorker(box) {
    if (state.ocrWorker) return state.ocrWorker;
    if (!global.Tesseract?.createWorker) throw new Error('No se ha cargado el motor OCR local.');
    state.ocrWorker = await global.Tesseract.createWorker('spa', global.Tesseract.OEM.LSTM_ONLY, {
      workerPath: new URL('vendor/activity/tesseract/worker.min.js', ACTIVITY_SCRIPT_BASE).href,
      langPath: new URL('vendor/activity/tesseract/lang', ACTIVITY_SCRIPT_BASE).href,
      corePath: new URL('vendor/activity/tesseract/core', ACTIVITY_SCRIPT_BASE).href,
      logger: message => { state.ocrProgress = message; if (state.wizard?.step === 'ocr') render(box); },
    });
    await state.ocrWorker.setParameters({
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
      // Las hojas PuTTY son tablas densas: el modo de bloque uniforme evita
      // que el autoanálisis descarte filas enteras entre las líneas de la tabla.
      tessedit_pageseg_mode: '6',
    });
    return state.ocrWorker;
  }
  async function releaseOcrWorker() {
    const worker = state.ocrWorker; state.ocrWorker = null; state.ocrProgress = null;
    if (worker?.terminate) { try { await worker.terminate(); } catch (_) {} }
  }
  async function runOcr(box) {
    const wizard = state.wizard; wizard.step = 'ocr'; wizard.running = true; wizard.error = ''; render(box);
    try {
      const worker = await ensureOcrWorker(box);
      for (const page of wizard.pages) {
        if (page.ocrStatus === 'completed') continue;
        page.ocrStatus = 'running'; render(box);
        // Aproximadamente 300 ppp para un A4, manteniendo una sola página en
        // memoria. Mejora dígitos y sufijos de prestación sin cargar el PDF entero.
        const canvas = await renderPageCanvas(page, true, 3);
        try {
          const result = await worker.recognize(canvas, {}, { text: true, tsv: true });
          const tsv = result.data.tsv || '';
          const parsed = core.parseOcrRows(tsv, { medico_id: wizard.doctorId, pagina: page.number, agenda_id: '' });
          page.agendaId = core.detectAgenda(result.data.text || '', state.catalogs);
          page.rows = parsed.rows.map(row => ({ ...row, reviewed: false, nregLengthConfirmed: false }));
          page.candidateCount = parsed.candidateCount;
          page.expectedCount = parsed.candidateCount;
          page.ocrTextHint = String(result.data.text || '').slice(0, 500).replace(/\d{6,}/g, '[NREG]');
          page.ocrDiagnostics = { tsvChars: tsv.length, words: core.parseTsv(tsv).length, bands: core.tsvRowBands(tsv).length };
          page.ocrStatus = 'completed';
          await saveCheckpoint();
        } finally { canvas.width = 0; canvas.height = 0; }
        render(box);
      }
      wizard.step = 'review'; wizard.running = false; await saveCheckpoint(); render(box);
    } catch (error) { wizard.running = false; wizard.error = error.message || String(error); wizard.step = 'protect'; await saveCheckpoint(); render(box); }
    finally { await releaseOcrWorker(); }
  }
  async function saveCheckpoint() {
    const wizard = state.wizard; if (!wizard?.fileHash) return;
    const pages = wizard.pages.map(page => ({
      number: page.number, mask: page.mask, rotation: page.rotation, deskew: page.deskew, contrast: page.contrast, threshold: page.threshold,
      maskConfirmed: page.maskConfirmed, ocrStatus: page.ocrStatus, rows: page.rows, expectedCount: page.expectedCount, candidateCount: page.candidateCount, agendaId: page.agendaId,
    }));
    await core.checkpointPut({ file_hash: wizard.fileHash, doctorId: wizard.doctorId, updated_at: new Date().toISOString(), step: wizard.step, prepared: wizard.prepared || null, duplicateConfirmed: wizard.duplicateConfirmed === true, pages });
  }

  function wireReview(box, wizard) {
    box.querySelectorAll('[data-page-agenda]').forEach(select => select.addEventListener('change', () => { wizard.pages[Number(select.dataset.pageAgenda) - 1].agendaId = select.value; saveCheckpoint(); render(box); }));
    box.querySelectorAll('[data-expected]').forEach(input => input.addEventListener('change', () => {
      const page = wizard.pages[Number(input.dataset.expected) - 1], expected = Math.max(page.candidateCount || 0, Math.min(200, Number(input.value) || 0));
      page.expectedCount = expected; while (page.rows.length < expected) page.rows.push({ fecha: '', hora: '', prestacion: '', realizada: '', nreg: '', alta: '', confidence: 0, fila: page.rows.length + 1, reviewed: false, nregLengthConfirmed: false });
      saveCheckpoint(); render(box);
    }));
    box.querySelectorAll('[data-review-row]').forEach(tr => {
      const [pageNumber, rowIndex] = tr.dataset.reviewRow.split(':').map(Number), row = wizard.pages[pageNumber - 1].rows[rowIndex];
      tr.querySelectorAll('[data-field]').forEach(input => {
        // Guardamos mientras se escribe para que un repintado posterior (por
        // ejemplo, al elegir SI/NO) no pueda perder la corrección manual.
        input.addEventListener('input', () => { row[input.dataset.field] = input.value; row.reviewed = false; saveCheckpoint(); });
        input.addEventListener('change', () => { row[input.dataset.field] = input.value; row.reviewed = false; saveCheckpoint(); render(box); });
      });
      tr.querySelector('[data-reviewed]')?.addEventListener('change', event => { row.reviewed = event.target.checked; saveCheckpoint(); render(box); });
      tr.querySelector('[data-nreg-confirm]')?.addEventListener('change', event => { row.nregLengthConfirmed = event.target.checked; saveCheckpoint(); render(box); });
    });
    box.querySelectorAll('[data-add-service]').forEach(button => button.addEventListener('click', () => addServiceFromReview(button.dataset.addService, box)));
    box.querySelectorAll('[data-add-row]').forEach(button => button.addEventListener('click', () => {
      const page = wizard.pages[Number(button.dataset.addRow) - 1]; page.expectedCount++; page.rows.push({ fecha: '', hora: '', prestacion: '', realizada: '', nreg: '', alta: '', confidence: 0, fila: page.rows.length + 1, reviewed: false, nregLengthConfirmed: false }); saveCheckpoint(); render(box);
    }));
    box.querySelectorAll('[data-check-page]').forEach(button => button.addEventListener('click', () => {
      const page = wizard.pages[Number(button.dataset.checkPage) - 1]; page.rows.forEach(row => { const normalized = normalizedReviewRow(row, page); if (core.rowIsValid(normalized) && state.catalogs.services.some(item => item.code === normalized.prestacion) && (!normalized.nreg_length_warning || row.nregLengthConfirmed)) row.reviewed = true; }); saveCheckpoint(); render(box);
    }));
  }

  async function addServiceFromReview(code, box) {
    const canonical = core.canonicalCode(code); if (!canonical) return;
    if (state.catalogs.services.some(item => item.code === canonical)) return render(box);
    const label = global.prompt(`Descripción de la prestación ${canonical}:`, canonical); if (!label) return;
    state.catalogs.services.push({ id: core.slug(canonical), code: canonical, label: String(label).trim(), active: true });
    if (!configured()) { toast('Prestación añadida localmente; configura GitHub antes de confirmar el lote.'); return render(box); }
    try { await persistCatalogs(); toast(`Prestación ${canonical} guardada en el catálogo`); render(box); }
    catch (error) { state.catalogs.services = state.catalogs.services.filter(item => item.code !== canonical); toast(`No se pudo guardar la prestación: ${error.message || error}`); render(box); }
  }

  async function prepareSave(box) {
    const wizard = state.wizard; wizard.error = '';
    try {
      const fresh = configured() ? await state.adapter.ghGetFile(PATHS.dedup) : null;
      if (fresh?.json) { state.dedup = { ...emptyDedup(), ...fresh.json, active: fresh.json.active || {} }; state.dedupSha = fresh.sha; }
      const rows = wizard.pages.flatMap(page => page.rows.map(row => {
        const normalized = normalizedReviewRow(row, page); delete normalized.raw_text; delete normalized.source_y; return normalized;
      }));
      const secret = core.getOrCreateHmacSecret();
      wizard.prepared = await core.prepareBatch({ rows, fileHash: wizard.fileHash, fileName: '', pages: wizard.pageCount, catalogsRevision: state.catalogs.revision, secret, existingHmacs: state.dedup.active });
      wizard.step = 'save'; await saveCheckpoint(); render(box);
    } catch (error) { wizard.error = error.message || String(error); render(box); }
  }

  async function commitBatch(box) {
    const wizard = state.wizard, prepared = wizard.prepared; if (!prepared) return;
    wizard.error = '';
    try {
      const freshIndex = await state.adapter.ghGetFile(PATHS.index), freshDedup = await state.adapter.ghGetFile(PATHS.dedup);
      const index = freshIndex?.json ? { ...emptyIndex(), ...freshIndex.json } : emptyIndex();
      const dedup = freshDedup?.json ? { ...emptyDedup(), ...freshDedup.json, active: freshDedup.json.active || {} } : emptyDedup();
      const sameSource = (index.active_batches || []).find(batch => batch.source_sha256 === wizard.fileHash);
      if (sameSource && sameSource.id !== prepared.batch.id) throw new Error('El PDF ya fue confirmado desde otra sesión.');
      const conflict = prepared.batch.dedup_hmacs.find(hmac => dedup.active[hmac] && dedup.active[hmac] !== prepared.batch.id);
      if (conflict) throw new Error('El índice de duplicados cambió durante la revisión. Vuelve a preparar la confirmación.');
      const path = `${PATHS.batches}/${prepared.batch.id}.json`;
      let readback = await state.adapter.ghGetFile(path);
      if (readback?.json) {
        if (await core.sha256Hex(JSON.stringify(readback.json)) !== await core.sha256Hex(JSON.stringify(prepared.batch))) throw new Error('Ya existe un lote con el mismo identificador y contenido distinto.');
      } else {
        await state.adapter.ghPutFile(path, prepared.batch, `activity: confirmar lote ${prepared.batch.id}`, null);
        readback = await state.adapter.ghGetFile(path);
      }
      if (!readback?.json || await core.sha256Hex(JSON.stringify(readback.json)) !== await core.sha256Hex(JSON.stringify(prepared.batch))) throw new Error('GitHub no devolvió el lote exactamente como fue guardado.');
      const dedupChanged = prepared.batch.dedup_hmacs.some(hmac => dedup.active[hmac] !== prepared.batch.id);
      prepared.batch.dedup_hmacs.forEach(hmac => { dedup.active[hmac] = prepared.batch.id; });
      if (dedupChanged) {
        dedup.revision = (Number(dedup.revision) || 0) + 1; dedup.updated_at = new Date().toISOString();
        await state.adapter.ghPutFile(PATHS.dedup, dedup, `activity: deduplicación ${prepared.batch.id}`, freshDedup?.sha || null);
      }
      const entry = { id: prepared.batch.id, created_at: prepared.batch.created_at, source_sha256: prepared.batch.source.sha256, pages: prepared.batch.source.pages, rows: prepared.batch.rows_included, duplicates_excluded: prepared.batch.duplicate_rows_excluded, summary: prepared.batch.summary };
      if (!(index.active_batches || []).some(batch => batch.id === prepared.batch.id)) {
        index.active_batches = [...(index.active_batches || []), entry];
        index.aggregates = core.mergeAggregateRows([...(index.aggregates || []), ...prepared.batch.aggregates]);
        index.summary = core.summarizeAggregates(index.aggregates); index.rebuilt_at = new Date().toISOString();
        await state.adapter.ghPutFile(PATHS.index, index, `activity: actualizar índice ${prepared.batch.id}`, freshIndex?.sha || null);
      }
      const verified = await state.adapter.ghGetFile(PATHS.index);
      const verifiedDedup = await state.adapter.ghGetFile(PATHS.dedup);
      if (!verified?.json?.active_batches?.some(batch => batch.id === prepared.batch.id) || prepared.batch.dedup_hmacs.some(hmac => verifiedDedup?.json?.active?.[hmac] !== prepared.batch.id)) throw new Error('El lote existe, pero los índices no superaron la lectura de verificación. Reintenta antes de importar otro PDF.');
      state.index = verified.json; state.dedup = dedup; cacheState(); await core.checkpointDelete(wizard.fileHash); await releasePdf();
      state.wizard = null; state.view = 'dashboard'; toast('Lote confirmado y verificado'); render(box);
    } catch (error) { wizard.error = `${error.message || error} El checkpoint local se conserva para reintentar.`; render(box); }
  }

  async function annulBatch(batchId, box) {
    if (!configured() || !global.confirm(`¿Anular el lote ${batchId}? El original quedará en el historial y sus NREG podrán importarse de nuevo.`)) return;
    try {
      const batchFile = await state.adapter.ghGetFile(`${PATHS.batches}/${batchId}.json`);
      if (!batchFile?.json) throw new Error('No se encuentra el lote original.');
      const event = { schema_version: 'ariadna-activity-audit-v1', id: `annul-${Date.now()}`, type: 'annul_batch', batch_id: batchId, created_at: new Date().toISOString(), reason: 'Importación errónea anulada manualmente' };
      await state.adapter.ghPutFile(`${PATHS.audit}/${event.id}.json`, event, `activity: anular ${batchId}`, null);
      const dedupFile = await state.adapter.ghGetFile(PATHS.dedup), dedup = dedupFile?.json ? { ...emptyDedup(), ...dedupFile.json, active: dedupFile.json.active || {} } : emptyDedup();
      for (const hmac of batchFile.json.dedup_hmacs || []) if (dedup.active[hmac] === batchId) delete dedup.active[hmac];
      dedup.revision = (Number(dedup.revision) || 0) + 1; dedup.updated_at = new Date().toISOString();
      await state.adapter.ghPutFile(PATHS.dedup, dedup, `activity: liberar deduplicación ${batchId}`, dedupFile?.sha || null);
      const remaining = (state.index.active_batches || []).filter(batch => batch.id !== batchId);
      const batches = [];
      for (const entry of remaining) { const file = await state.adapter.ghGetFile(`${PATHS.batches}/${entry.id}.json`); if (file?.json) batches.push(file.json); }
      const rebuilt = core.buildAggregateIndex(batches, [event]);
      const indexFile = await state.adapter.ghGetFile(PATHS.index);
      await state.adapter.ghPutFile(PATHS.index, rebuilt, `activity: reconstruir índice tras ${batchId}`, indexFile?.sha || null);
      state.index = (await state.adapter.ghGetFile(PATHS.index)).json || rebuilt; state.dedup = dedup; cacheState(); toast('Lote anulado; el histórico se conserva'); render(box);
    } catch (error) { toast(`No se pudo anular: ${error.message || error}`); }
  }

  function renderCatalogs(box) {
    box.innerHTML = `<div class="activity-shell"><div class="activity-head"><div><h2>Catálogos de actividad</h2><div class="dx-meta">Identificadores estables · los elementos usados se archivan, no se eliminan.</div></div><button class="btn ghost" data-cat="back">Volver</button></div>
      ${catalogEditor('doctors', 'Médicos')}${catalogEditor('agendas', 'Agendas')}${catalogEditor('services', 'Prestaciones')}
      <div class="activity-actions activity-end"><button class="btn primary" data-cat="save" ${configured() ? '' : 'disabled'}>Guardar catálogos en GitHub privado</button></div></div>`;
    box.querySelector('[data-cat="back"]')?.addEventListener('click', () => { state.view = 'dashboard'; render(box); });
    box.querySelectorAll('[data-cat-field]').forEach(input => input.addEventListener('change', () => {
      const [collection, index, field] = input.dataset.catField.split(':'); state.catalogs[collection][Number(index)][field] = field === 'active' ? input.checked : input.value;
    }));
    box.querySelectorAll('[data-cat-add]').forEach(button => button.addEventListener('click', () => {
      const collection = button.dataset.catAdd, code = global.prompt(`Código nuevo para ${collection}:`); if (!code) return;
      const canonical = core.canonicalCode(code); if (state.catalogs[collection].some(item => item.code === canonical)) return toast('Ese código ya existe');
      state.catalogs[collection].push({ id: core.slug(canonical), code: canonical, label: canonical, active: true }); render(box);
    }));
    box.querySelector('[data-cat="save"]')?.addEventListener('click', () => saveCatalogs(box));
  }
  function catalogEditor(collection, title) {
    return `<section class="activity-panel activity-wide"><div class="activity-head"><h3>${esc(title)}</h3><button class="btn ghost" data-cat-add="${collection}">Añadir</button></div><div class="activity-table-wrap"><table><thead><tr><th>ID estable</th><th>Código</th><th>Etiqueta</th><th>Activo</th></tr></thead><tbody>${state.catalogs[collection].map((item, index) => `<tr><td><code>${esc(item.id)}</code></td><td><input data-cat-field="${collection}:${index}:code" value="${esc(item.code)}"></td><td><input data-cat-field="${collection}:${index}:label" value="${esc(item.label)}"></td><td><input type="checkbox" data-cat-field="${collection}:${index}:active" ${item.active ? 'checked' : ''}></td></tr>`).join('')}</tbody></table></div></section>`;
  }
  async function persistCatalogs() {
    const fresh = await state.adapter.ghGetFile(PATHS.catalogs), currentRevision = Number(fresh?.json?.revision) || 0;
    if (state.catalogsSha && fresh?.sha && state.catalogsSha !== fresh.sha) throw new Error('Los catálogos cambiaron en otra sesión. Refresca antes de guardar.');
    const catalogs = core.normalizeCatalogs(state.catalogs); catalogs.revision = Math.max(currentRevision, Number(catalogs.revision) || 0) + 1; catalogs.updated_at = new Date().toISOString();
    await state.adapter.ghPutFile(PATHS.catalogs, catalogs, `activity: catálogos rev ${catalogs.revision}`, fresh?.sha || null);
    const verified = await state.adapter.ghGetFile(PATHS.catalogs);
    if (verified?.json?.revision !== catalogs.revision) throw new Error('La lectura de verificación no coincide.');
    state.catalogs = core.normalizeCatalogs(verified.json); state.catalogsSha = verified.sha; cacheState();
    return state.catalogs;
  }
  async function saveCatalogs(box) {
    try {
      await persistCatalogs(); toast('Catálogos guardados y verificados'); render(box);
    } catch (error) { toast(`No se guardaron: ${error.message || error}`); }
  }

  function exportSecret() {
    const payload = { schema_version: 'ariadna-activity-hmac-recovery-v1', created_at: new Date().toISOString(), secret: core.getOrCreateHmacSecret() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `ariadna-actividad-clave-hmac-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  async function importSecret(file) {
    if (!file) return;
    try { const payload = JSON.parse(await file.text()); if (payload.schema_version !== 'ariadna-activity-hmac-recovery-v1' || !payload.secret) throw new Error('Copia no válida.'); global.localStorage.setItem(SECRET_KEY, payload.secret); toast('Clave HMAC restaurada'); }
    catch (error) { toast(`No se pudo restaurar: ${error.message || error}`); }
  }

  function injectStyles() {
    if (document.getElementById('activityLocalStyles')) return;
    const style = document.createElement('style'); style.id = 'activityLocalStyles'; style.textContent = `
      .activity-shell{max-width:1500px;margin:0 auto;padding:18px 24px 60px}.activity-head{display:flex;justify-content:space-between;gap:18px;align-items:center;flex-wrap:wrap}.activity-head h2,.activity-head h3{margin:0}.activity-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.activity-end{justify-content:flex-end;margin-top:18px}.activity-privacy,.activity-warning,.activity-error{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:14px 0;background:var(--panel2)}.activity-privacy{border-color:var(--accent2)}.activity-warning{border-color:var(--major);color:#f3d49b}.activity-error{border-color:var(--danger);color:#ffb4a7}.activity-cards{display:grid;grid-template-columns:repeat(4,minmax(130px,1fr));gap:10px;margin:14px 0}.activity-metric{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}.activity-metric span{display:block;color:var(--ink2);font-size:13px}.activity-metric b{display:block;font-size:25px;margin-top:3px}.activity-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.activity-panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin:12px 0}.activity-panel h3{margin:0 0 10px}.activity-wide{grid-column:1/-1}.activity-bar-row{display:grid;grid-template-columns:minmax(140px,1fr) 2fr 50px;gap:8px;align-items:center;margin:7px 0;font-size:13px}.activity-bar-row>div{height:8px;background:var(--line);border-radius:5px;overflow:hidden}.activity-bar-row i{display:block;height:100%;background:var(--accent)}.activity-table-wrap{overflow:auto}.activity-table-wrap table{width:100%;border-collapse:collapse;font-size:13px}.activity-table-wrap th,.activity-table-wrap td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}.activity-table-wrap input,.activity-table-wrap select{min-width:95px;width:100%}.activity-filters{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:14px 0}.activity-filter-grid,.activity-form-grid,.activity-control-grid{display:grid;grid-template-columns:repeat(3,minmax(160px,1fr));gap:12px;margin:10px 0}.activity-filter-grid label,.activity-form-grid label,.activity-control-grid label{font-size:12px;color:var(--ink2)}.activity-filter-grid input,.activity-filter-grid select,.activity-form-grid input,.activity-form-grid select{display:block;width:100%;margin-top:4px}.activity-filter-grid select[multiple]{min-height:86px}.activity-technical{margin-top:16px;border-top:1px solid var(--line);padding-top:12px}.activity-file-label{cursor:pointer}.activity-steps{display:grid;grid-template-columns:repeat(5,1fr);list-style:none;padding:0;margin:20px 0;gap:8px}.activity-steps li{color:var(--ink3);font-size:12px;display:flex;gap:7px;align-items:center}.activity-steps b{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:50%;border:1px solid var(--line)}.activity-steps .active{color:var(--ink)}.activity-steps .active b{background:var(--accent);color:#081513}.activity-steps .done b{background:var(--ok);color:#07130c}.activity-page-nav{display:flex;gap:10px;align-items:center;margin-bottom:10px}.activity-page-nav span{margin-left:auto;color:var(--ink2)}.activity-preview-wrap{position:relative;width:min(100%,1200px);margin:auto;background:white;line-height:0;overflow:hidden;border-radius:8px;border:1px solid var(--line)}.activity-preview-wrap canvas{width:100%;height:auto}.activity-mask{position:absolute;background:rgba(224,96,74,.58);border:2px solid #ffdfd8;cursor:move;display:grid;place-items:center;color:white;line-height:1.2;font-weight:800;text-shadow:0 1px 3px #000}.activity-mask i{position:absolute;right:-7px;bottom:-7px;width:18px;height:18px;border-radius:50%;background:#fff;border:3px solid var(--danger);cursor:nwse-resize}.activity-control-grid{grid-template-columns:repeat(3,minmax(190px,1fr))}.activity-control-grid input{display:block;width:100%}.activity-control-grid output{float:right;color:var(--ink)}.activity-progress{height:12px;border-radius:8px;overflow:hidden;background:var(--line)}.activity-progress i{display:block;height:100%;background:var(--accent);transition:width .2s}.activity-review-page{border:1px solid var(--line);border-radius:10px;padding:9px 11px;margin:12px 0}.activity-review-page summary{cursor:pointer}.activity-ocr-hint{margin:10px 0;color:var(--ink2)}.activity-ocr-hint pre{white-space:pre-wrap;max-height:180px;overflow:auto;background:var(--panel2);border-radius:8px;padding:10px}.activity-review-table tr.has-issue{background:rgba(224,96,74,.08)}.activity-row-issues{font-size:10px;color:#ffab9d;min-width:150px}.activity-low{color:var(--major)}.activity-inline-check{display:block;font-size:11px;white-space:nowrap}.activity-inline-check input{width:auto}.activity-technical code,.activity-table-wrap code{font-size:11px}@media(max-width:850px){.activity-grid,.activity-cards,.activity-filter-grid,.activity-form-grid,.activity-control-grid{grid-template-columns:1fr}.activity-steps{grid-template-columns:1fr}.activity-shell{padding:12px}.activity-review-table{min-width:900px}}
    `; document.head.appendChild(style);
  }

  const api = Object.freeze({ configure, load, render, getState: () => state, PATHS });
  global.AriadnaActivity = api;
})(typeof window !== 'undefined' ? window : globalThis);
