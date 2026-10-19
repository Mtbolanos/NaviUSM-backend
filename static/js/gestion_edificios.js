// =============================================================================
// Gestión de Edificios: nombre, pisos (número, nombre, acceso) y eliminación.
// Los cambios se envían a PATCH /admin/api/sedes/{id}/edificios, que los aplica
// sobre la última versión publicada (409 si alguien publicó entremedio).
// =============================================================================
const ROOT_PATH = window.GESTION_CONFIG.rootPath;
const sedesInfo = window.GESTION_CONFIG.sedesInfo;
const MAP_TILES = window.MAP_TILES || {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  max_zoom: 19,
};

let sedeId = sedesInfo.length > 0 ? sedesInfo[0].id : null;
let snapshot = null;        // último snapshot publicado
let snapshotVersion = null;
let original = {};          // id -> estado inicial serializado (para saber qué cambió)
let work = {};              // id -> { id, nombre, accesoKey, pisos: [{ key, numero, nombre, desde }] }
let deleted = new Set();    // edificios marcados para eliminar
let expanded = new Set();   // edificios desplegados
let saving = false;
let pisoMap = null, pisoLayer = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function normalizeText(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function pisoBase(numero) {
  return numero < 0 ? `Subterráneo ${-numero}` : `Piso ${numero}`;
}

function plural(n, uno, varios) {
  return `${n} ${n === 1 ? uno : varios}`;
}

// =============================================================================
// Carga
// =============================================================================
window.addEventListener('beforeunload', (e) => {
  if (!isDirty()) return;
  e.preventDefault();
  e.returnValue = '';
});

window.addEventListener('load', () => {
  // ?sede=...&edificio=... (enlace "Gestionar pisos" del editor)
  const params = new URLSearchParams(location.search);
  const sel = document.getElementById('sede-selector');
  if (params.get('sede') && sedesInfo.some(s => s.id === params.get('sede'))) {
    sedeId = params.get('sede');
    sel.value = sedeId;
  }
  if (params.get('edificio')) expanded.add(params.get('edificio'));
  cargarEdificios({ focus: params.get('edificio') });
});

async function cargarEdificios({ focus = null } = {}) {
  const list = document.getElementById('bld-list');
  if (!sedeId) {
    list.innerHTML = '<div class="panel-meta py-4 text-center">No hay sedes creadas.</div>';
    return;
  }
  list.innerHTML = '<div class="panel-meta py-4 text-center">Cargando datos...</div>';
  try {
    const res = await fetch(`${ROOT_PATH}/admin/api/sedes/${sedeId}/snapshot`);
    if (res.status === 404) {
      snapshot = null;
      list.innerHTML = '<div class="panel-meta py-4 text-center">Aún no hay un mapa publicado para esta sede. Ve a "Dibujar Mapa" primero.</div>';
      resetState();
      return;
    }
    if (!res.ok) throw new Error();
    snapshotVersion = parseInt(res.headers.get('X-Snapshot-Version'), 10);
    snapshot = await res.json();
  } catch (e) {
    list.innerHTML = '<div class="panel-meta py-4 text-center text-danger">No se pudo cargar el mapa de esta sede.</div>';
    return;
  }
  resetState();
  renderLista();
  if (focus) document.getElementById(`bld-${focus}`)?.scrollIntoView({ block: 'start' });
}

// Pisos del snapshot (formato 2.2, o min/max de versiones anteriores)
function pisosDe(b) {
  let pisos = Array.isArray(b.pisos) && b.pisos.length
    ? b.pisos.map(p => ({ numero: p.numero, nombre: p.nombre || null }))
    : Array.from({ length: Math.abs((b.max ?? 1) - (b.min ?? 1)) + 1 }, (_, i) => ({ numero: Math.min(b.min ?? 1, b.max ?? 1) + i, nombre: null }));
  pisos.sort((x, y) => x.numero - y.numero);
  const numeros = pisos.map(p => p.numero);
  const acceso = numeros.includes(b.acceso) ? b.acceso : (numeros.includes(1) ? 1 : numeros[0]);
  return { pisos, acceso };
}

function resetState() {
  work = {};
  original = {};
  deleted = new Set();
  (snapshot?.buildings || []).filter(b => b.id !== 'exterior').forEach(b => {
    const { pisos, acceso } = pisosDe(b);
    const w = { id: b.id, ...PisosUI.makeModel(b.name || '', pisos, acceso) };
    work[b.id] = w;
    original[b.id] = serialize(w);
  });
  updateDirty();
}

// Forma comparable de un edificio (independiente de las claves internas)
const serialize = PisosUI.serialize;

function changedIds() {
  return Object.keys(work).filter(id => !deleted.has(id) && serialize(work[id]) !== original[id]);
}

function isDirty() {
  return deleted.size > 0 || changedIds().length > 0;
}

function updateDirty() {
  const dirty = isDirty();
  const n = changedIds().length + deleted.size;
  document.getElementById('dirty-badge').hidden = !dirty;
  document.getElementById('footer-status').textContent = saving
    ? 'Guardando...'
    : (dirty ? `${plural(n, 'edificio modificado', 'edificios modificados')}` : 'Sin cambios');
  document.getElementById('btn-guardar').disabled = !dirty || saving;
  document.getElementById('btn-descartar').disabled = !dirty || saving;
}

async function descartarCambios() {
  if (!isDirty() || saving) return;
  if (!(await window.uiConfirm('Se descartarán todos los cambios sin guardar.\n¿Continuar?', 'Descartar cambios'))) return;
  resetState();
  renderLista();
}

// Nodos del snapshot por edificio y piso (con el número que tienen hoy, antes de guardar)
function nodosEn(bid, numero) {
  return (snapshot?.nodes || []).filter(n => n.building === bid && n.floor === numero);
}

function contarPuntos(nodos) {
  const poi = nodos.filter(n => n.type !== 'waypoint').length;
  return { poi, ruta: nodos.length - poi, total: nodos.length };
}

// =============================================================================
// Lista
// =============================================================================
function renderLista() {
  const list = document.getElementById('bld-list');
  if (!snapshot) return;
  const q = normalizeText(document.getElementById('bld-search').value);
  const ids = Object.keys(work)
    .filter(id => !q || normalizeText(work[id].nombre).includes(q))
    .sort((a, b) => work[a].nombre.localeCompare(work[b].nombre, 'es', { sensitivity: 'base', numeric: true }));

  list.innerHTML = '';
  if (!Object.keys(work).length) {
    list.innerHTML = '<div class="panel-meta py-4 text-center">No hay edificios en el mapa de esta sede.</div>';
    return;
  }
  if (!ids.length) {
    list.innerHTML = '<div class="panel-meta py-4 text-center">Ningún edificio coincide con la búsqueda.</div>';
    return;
  }
  ids.forEach(id => list.appendChild(renderEdificio(work[id])));
}

function renderEdificio(w) {
  const isDeleted = deleted.has(w.id);
  const isOpen = expanded.has(w.id) && !isDeleted;
  const totalPoi = w.pisos.reduce((acc, p) => acc + (p.desde === null ? 0 : contarPuntos(nodosEn(w.id, p.desde)).poi), 0);
  const changed = !isDeleted && serialize(w) !== original[w.id];

  const item = document.createElement('div');
  item.className = 'bld-item' + (isOpen ? ' open' : '') + (isDeleted ? ' deleted' : '');
  item.id = `bld-${w.id}`;

  const head = document.createElement('div');
  head.className = 'bld-head';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'bld-toggle';
  toggle.disabled = isDeleted;
  toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  toggle.innerHTML = `
    <svg class="ico bld-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
    <span class="bld-name"></span>
    <span class="bld-meta"></span>`;
  toggle.querySelector('.bld-name').textContent = w.nombre || 'Sin nombre';
  toggle.querySelector('.bld-meta').textContent = isDeleted
    ? 'Se eliminará al guardar'
    : `${plural(w.pisos.length, 'piso', 'pisos')} - ${plural(totalPoi, 'punto', 'puntos')}${changed ? ' - con cambios' : ''}`;
  toggle.addEventListener('click', () => {
    expanded.has(w.id) ? expanded.delete(w.id) : expanded.add(w.id);
    renderLista();
  });
  head.appendChild(toggle);

  if (!isDeleted) {
    const edit = document.createElement('a');
    edit.className = 'btn btn-sm btn-outline-secondary';
    edit.textContent = 'Editar';
    edit.title = 'Abrir el editor del interior de este edificio';
    edit.href = `${ROOT_PATH}/admin/edificios/editar?sede=${encodeURIComponent(sedeId)}&edificio=${encodeURIComponent(w.id)}`;
    edit.addEventListener('click', async (ev) => {
      if (!isDirty()) return;
      ev.preventDefault();
      if (await window.uiConfirm('Tienes cambios sin guardar en esta página. Si abres el editor se perderán.\n¿Continuar?', 'Cambios sin guardar')) {
        resetState();
        location.href = edit.href;
      }
    });
    head.appendChild(edit);
  }

  if (isDeleted) {
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'btn btn-sm btn-outline-secondary';
    restore.textContent = 'Restaurar';
    restore.addEventListener('click', () => { deleted.delete(w.id); updateDirty(); renderLista(); });
    head.appendChild(restore);
  }
  item.appendChild(head);
  if (isOpen) item.appendChild(renderDetalle(w));
  return item;
}

function renderDetalle(w) {
  const body = document.createElement('div');
  body.className = 'bld-body';

  // Nombre
  const nameRow = document.createElement('div');
  nameRow.className = 'bld-field';
  nameRow.innerHTML = '<label class="panel-label">Nombre del edificio</label>';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 255;
  nameInput.className = 'form-control form-control-sm';
  nameInput.value = w.nombre;
  nameInput.addEventListener('input', () => { w.nombre = nameInput.value; updateDirty(); });
  nameInput.addEventListener('change', renderLista);
  nameRow.appendChild(nameInput);
  body.appendChild(nameRow);

  // Pisos (componente compartido con el editor de edificio)
  const floors = document.createElement('div');
  floors.id = `pisos-${w.id}`;
  PisosUI.render(floors, w, {
    counts: (p) => contarPuntos(nodosEn(w.id, p.desde)),
    onChange: updateDirty,
    rerender: renderLista,
    onVer: (p) => verPiso(w, p),
  });
  body.appendChild(floors);

  // Eliminar edificio
  const foot = document.createElement('div');
  foot.className = 'bld-foot';
  const spacer = document.createElement('span');
  spacer.className = 'flex-grow-1';
  const delB = document.createElement('button');
  delB.type = 'button';
  delB.className = 'btn btn-sm btn-outline-danger';
  delB.textContent = 'Eliminar edificio';
  delB.addEventListener('click', () => eliminarEdificio(w));
  foot.append(spacer, delB);
  body.appendChild(foot);
  return body;
}

const numerosRepetidos = PisosUI.numerosRepetidos;

// =============================================================================
// Acciones
// =============================================================================
async function eliminarEdificio(w) {
  const nodos = (snapshot.nodes || []).filter(n => n.building === w.id);
  const { poi } = contarPuntos(nodos);
  const msg = poi > 0
    ? `${w.nombre || 'El edificio'} tiene ${plural(poi, 'punto de interés', 'puntos de interés')}.\nAl guardar se eliminarán el edificio, su contorno, sus puntos y sus conexiones.\n¿Continuar?`
    : `Al guardar se eliminarán ${w.nombre || 'el edificio'}, su contorno y sus puntos.\n¿Continuar?`;
  if (!(await window.uiConfirm(msg, 'Eliminar edificio'))) return;
  deleted.add(w.id);
  expanded.delete(w.id);
  updateDirty();
  renderLista();
}

async function cambiarSede() {
  const sel = document.getElementById('sede-selector');
  if (isDirty()) {
    const ok = await window.uiConfirm('Tienes cambios sin guardar. Si cambias de sede se perderán.\n¿Continuar?', 'Cambios sin guardar');
    if (!ok) { sel.value = sedeId; return; }
  }
  sedeId = sel.value;
  expanded = new Set();
  cargarEdificios();
}

async function guardarCambios() {
  if (saving || !isDirty()) return;
  const ids = changedIds();
  for (const id of ids) {
    const w = work[id];
    if (!w.nombre.trim()) { await window.uiAlert('Un edificio quedó sin nombre.', 'No se guardó'); return; }
    if (numerosRepetidos(w).size) { await window.uiAlert(`${w.nombre} tiene números de piso repetidos.`, 'No se guardó'); return; }
  }

  // Resumen de lo que se borra (lo demás se puede deshacer editando de nuevo)
  const borrados = [];
  ids.forEach(id => {
    const w = work[id];
    const actuales = new Set(w.pisos.map(p => p.desde).filter(d => d !== null));
    pisosDe(snapshot.buildings.find(b => b.id === id)).pisos.forEach(p => {
      if (!actuales.has(p.numero)) borrados.push(`- ${w.nombre}: ${pisoBase(p.numero)} (${nodosEn(id, p.numero).length} puntos)`);
    });
  });
  deleted.forEach(id => borrados.push(`- Edificio ${work[id].nombre}`));
  const msg = `Se guardarán los cambios de ${plural(ids.length + deleted.size, 'edificio', 'edificios')}.`
    + (borrados.length ? `\nSe eliminará:\n${borrados.join('\n')}` : '')
    + '\n¿Guardar?';
  if (!(await window.uiConfirm(msg, 'Guardar cambios'))) return;

  saving = true;
  updateDirty();
  try {
    // Si otra persona publicó entremedio (409), se combinan los cambios y se reintenta (hasta 3 veces)
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(`${ROOT_PATH}/admin/api/sedes/${sedeId}/edificios`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPatchBody()),
      });
      if (res.status === 409) {
        const conflictos = await rebaseOnLatest();
        if (conflictos === null) {
          await window.uiAlert('Otra persona guardó cambios y no se pudo descargar la versión actual. Recarga la página.', 'No se guardó');
          return;
        }
        if (conflictos.length) {
          await window.uiAlert(
            `Otra persona modificó estos edificios mientras editabas:\n${conflictos.map(n => `- ${n}`).join('\n')}\n`
            + 'Se cargó su versión de esos edificios. Tus cambios en los demás se conservaron: revisa y vuelve a guardar.',
            'Cambios combinados');
          return;
        }
        if (!isDirty()) { // lo que querías guardar ya estaba publicado
          await window.uiAlert('Tus cambios ya estaban publicados por otra persona.', 'Sin cambios que guardar');
          return;
        }
        continue;
      }
      if (res.status === 422) {
        const detail = (await res.json().catch(() => ({}))).detail;
        await window.uiAlert(`${typeof detail === 'string' ? detail : 'Datos inválidos'}.`, 'No se guardó');
        return;
      }
      if (!res.ok) throw new Error();
      break;
    }
    saving = false;
    await cargarEdificios();
    await window.uiAlert('Cambios guardados.', 'Listo');
  } catch (e) {
    await window.uiAlert('Error al guardar los cambios.', 'Error');
  } finally {
    saving = false;
    updateDirty();
  }
}

function buildPatchBody() {
  return {
    base_version: snapshotVersion,
    edificios: changedIds().map(id => {
      const w = work[id];
      return {
        id,
        nombre: w.nombre.trim(),
        acceso: w.pisos.find(p => p.key === w.accesoKey).numero,
        pisos: w.pisos.map(p => ({ numero: p.numero, nombre: (p.nombre || '').trim() || null, desde: p.desde })),
      };
    }),
    eliminar: [...deleted],
  };
}

// Descarga la última versión y vuelve a aplicar encima los cambios de cada edificio que nadie más tocó.
// Devuelve los nombres de los edificios en conflicto (modificados también por otra persona), o null si falla.
async function rebaseOnLatest() {
  const prevWork = work, prevOriginal = original, prevDeleted = new Set(deleted);
  const mine = new Set([...changedIds(), ...prevDeleted]);
  try {
    const res = await fetch(`${ROOT_PATH}/admin/api/sedes/${sedeId}/snapshot`);
    if (!res.ok) return null;
    snapshotVersion = parseInt(res.headers.get('X-Snapshot-Version'), 10);
    snapshot = await res.json();
  } catch (e) {
    return null;
  }
  resetState();
  const conflictos = [];
  mine.forEach(id => {
    const nombre = prevWork[id].nombre || 'Sin nombre';
    if (!work[id]) {                                  // ya no existe en lo publicado
      if (!prevDeleted.has(id)) conflictos.push(`${nombre} (lo eliminó otra persona)`);
      return;
    }
    if (original[id] !== prevOriginal[id]) { conflictos.push(nombre); return; }
    if (prevDeleted.has(id)) deleted.add(id);
    else work[id] = prevWork[id];                     // nadie más lo tocó: se conserva lo mío
  });
  updateDirty();
  renderLista();
  return conflictos;
}

// =============================================================================
// Ver un piso en el mapa (ventana flotante, solo lectura)
// =============================================================================
function verPiso(w, p) {
  const modalEl = document.getElementById('pisoMapModal');
  document.getElementById('pisoMapTitle').textContent = `${w.nombre} - ${p.nombre ? `${pisoBase(p.desde)} - ${p.nombre}` : pisoBase(p.desde)}`;
  const nodos = nodosEn(w.id, p.desde);
  const counts = contarPuntos(nodos);
  document.getElementById('piso-map-meta').textContent =
    `${plural(counts.poi, 'punto de interés', 'puntos de interés')} - ${plural(counts.ruta, 'punto de ruta', 'puntos de ruta')}`;

  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  modalEl.addEventListener('shown.bs.modal', () => dibujarPiso(w.id, nodos), { once: true });
  modal.show();
}

function dibujarPiso(bid, nodos) {
  if (!pisoMap) {
    pisoMap = L.map('piso-map', { zoomControl: true, maxZoom: 22 });
    L.tileLayer(MAP_TILES.url, { maxZoom: 22, maxNativeZoom: MAP_TILES.max_zoom, attribution: MAP_TILES.attribution }).addTo(pisoMap);
  }
  pisoMap.invalidateSize();
  if (pisoLayer) pisoLayer.remove();
  pisoLayer = L.featureGroup().addTo(pisoMap);

  const css = getComputedStyle(document.documentElement);
  const edgeColor = css.getPropertyValue('--map-edge').trim() || '#4a9eff';
  const stairsColor = css.getPropertyValue('--map-stairs').trim() || '#f5a623';

  (snapshot.zonas || [])
    .filter(z => z.building === bid && (z.tags || []).includes('contorno_edificio'))
    .forEach(z => L.geoJSON(z.geojson, { interactive: false, style: { color: '#3b6e8f', weight: 2, fillOpacity: 0.15 } }).addTo(pisoLayer));

  const ids = new Set(nodos.map(n => n.id));
  const byId = Object.fromEntries((snapshot.nodes || []).map(n => [n.id, n]));
  (snapshot.edges || [])
    .filter(e => ids.has(e.from) && ids.has(e.to))
    .forEach(e => L.polyline([[byId[e.from].lat, byId[e.from].lng], [byId[e.to].lat, byId[e.to].lng]],
      { color: e.es_escalera ? stairsColor : edgeColor, weight: 3, interactive: false }).addTo(pisoLayer));

  nodos.forEach(n => {
    const poi = n.type !== 'waypoint';
    const m = L.circleMarker([n.lat, n.lng], {
      radius: poi ? 7 : 4, weight: 2, color: '#ffffff', fillColor: poi ? '#7c3aed' : '#2563eb', fillOpacity: 1,
    }).addTo(pisoLayer);
    if (poi) m.bindTooltip(escapeHtml(n.name || 'Sin nombre'), { direction: 'top' });
  });

  const bounds = pisoLayer.getBounds();
  if (bounds.isValid()) pisoMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 20 });
  else {
    const b = byId[bid];
    if (b) pisoMap.setView([b.lat, b.lng], 19);
  }
}
