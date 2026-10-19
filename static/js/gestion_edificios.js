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
let keySeq = 0;
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
    const w = {
      id: b.id,
      nombre: b.name || '',
      pisos: pisos.map(p => ({ key: ++keySeq, numero: p.numero, nombre: p.nombre, desde: p.numero })),
    };
    w.accesoKey = w.pisos.find(p => p.numero === acceso).key;
    work[b.id] = w;
    original[b.id] = serialize(w);
  });
  updateDirty();
}

// Forma comparable de un edificio (independiente de las claves internas)
function serialize(w) {
  return JSON.stringify({
    nombre: w.nombre.trim(),
    acceso: w.pisos.find(p => p.key === w.accesoKey)?.numero,
    pisos: [...w.pisos].sort((a, b) => a.numero - b.numero).map(p => [p.numero, (p.nombre || '').trim() || null, p.desde]),
  });
}

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

  // Pisos, de arriba hacia abajo
  const dupes = numerosRepetidos(w);
  const sorted = [...w.pisos].sort((a, b) => b.numero - a.numero);
  const table = document.createElement('div');
  table.className = 'floor-table';
  table.innerHTML = `
    <div class="floor-row floor-header">
      <span>Número</span><span>Nombre (opcional)</span><span>Acceso</span><span>Puntos</span><span></span>
    </div>`;
  sorted.forEach((p, i) => {
    const isExtreme = i === 0 || i === sorted.length - 1;
    const counts = p.desde === null ? { poi: 0, ruta: 0, total: 0 } : contarPuntos(nodosEn(w.id, p.desde));
    const row = document.createElement('div');
    row.className = 'floor-row';

    const num = document.createElement('input');
    num.type = 'number';
    num.step = '1';
    num.className = 'form-control form-control-sm floor-num' + (dupes.has(p.numero) ? ' is-invalid' : '');
    num.value = p.numero;
    num.title = dupes.has(p.numero) ? 'Número repetido' : pisoBase(p.numero);
    num.setAttribute('aria-label', 'Número de piso');
    num.addEventListener('change', () => {
      const v = parseInt(num.value, 10);
      if (Number.isNaN(v)) { num.value = p.numero; return; }
      p.numero = v;
      updateDirty();
      renderLista();
    });

    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = 100;
    name.className = 'form-control form-control-sm';
    name.placeholder = pisoBase(p.numero);
    name.value = p.nombre || '';
    name.setAttribute('aria-label', 'Nombre del piso');
    name.addEventListener('input', () => { p.nombre = name.value.trim() || null; updateDirty(); });

    const accesoWrap = document.createElement('label');
    accesoWrap.className = 'floor-acceso';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `acceso-${w.id}`;
    radio.checked = w.accesoKey === p.key;
    radio.title = 'Piso a nivel de la calle';
    radio.addEventListener('change', () => { w.accesoKey = p.key; updateDirty(); renderLista(); });
    accesoWrap.appendChild(radio);
    if (w.accesoKey === p.key) {
      const tag = document.createElement('span');
      tag.textContent = 'Acceso';
      accesoWrap.appendChild(tag);
    }

    const pts = document.createElement('span');
    pts.className = 'panel-meta';
    pts.textContent = p.desde === null ? 'Nuevo' : `${plural(counts.poi, 'punto', 'puntos')} - ${counts.ruta} de ruta`;
    pts.title = 'Puntos de interés - puntos de ruta';

    // Dos espacios fijos (Ver en el mapa | Eliminar): los botones quedan siempre en la misma columna,
    // aunque en esa fila no corresponda alguno de los dos
    const actions = document.createElement('span');
    actions.className = 'floor-actions';
    const verSlot = document.createElement('span');
    const delSlot = document.createElement('span');
    if (p.desde !== null) {
      const ver = document.createElement('button');
      ver.type = 'button';
      ver.className = 'btn btn-sm btn-outline-secondary';
      ver.textContent = 'Ver en el mapa';
      ver.addEventListener('click', () => verPiso(w, p));
      verSlot.appendChild(ver);
    }
    if (isExtreme && sorted.length > 1) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-sm btn-outline-danger';
      del.textContent = 'Eliminar';
      del.title = 'Solo se puede eliminar el piso superior o el inferior';
      del.addEventListener('click', () => eliminarPiso(w, p, counts));
      delSlot.appendChild(del);
    }
    actions.append(verSlot, delSlot);

    row.append(num, name, accesoWrap, pts, actions);
    table.appendChild(row);
  });
  body.appendChild(table);
  if (dupes.size) {
    const warn = document.createElement('div');
    warn.className = 'text-danger small mt-1';
    warn.textContent = 'Hay números de piso repetidos: corrígelos antes de guardar.';
    body.appendChild(warn);
  }

  // Agregar pisos y eliminar edificio
  const foot = document.createElement('div');
  foot.className = 'bld-foot';
  const addUp = document.createElement('button');
  addUp.type = 'button';
  addUp.className = 'btn btn-sm btn-outline-secondary';
  addUp.textContent = '+ Agregar piso arriba';
  addUp.addEventListener('click', () => agregarPiso(w, 'arriba'));
  const addDown = document.createElement('button');
  addDown.type = 'button';
  addDown.className = 'btn btn-sm btn-outline-secondary';
  addDown.textContent = '+ Agregar subterráneo';
  addDown.addEventListener('click', () => agregarPiso(w, 'abajo'));
  const spacer = document.createElement('span');
  spacer.className = 'flex-grow-1';
  const delB = document.createElement('button');
  delB.type = 'button';
  delB.className = 'btn btn-sm btn-outline-danger';
  delB.textContent = 'Eliminar edificio';
  delB.addEventListener('click', () => eliminarEdificio(w));
  foot.append(addUp, addDown, spacer, delB);
  body.appendChild(foot);
  return body;
}

function numerosRepetidos(w) {
  const seen = new Set(), dup = new Set();
  w.pisos.forEach(p => (seen.has(p.numero) ? dup.add(p.numero) : seen.add(p.numero)));
  return dup;
}

// =============================================================================
// Acciones
// =============================================================================
// El piso 0 no se agrega con estos botones: se salta (de -1 se pasa a 1 y viceversa)
function agregarPiso(w, donde) {
  const numeros = w.pisos.map(p => p.numero);
  let numero = donde === 'arriba' ? Math.max(...numeros) + 1 : Math.min(...numeros) - 1;
  if (numero === 0) numero = donde === 'arriba' ? 1 : -1;
  if (numeros.includes(numero)) numero = donde === 'arriba' ? Math.max(...numeros, numero) + 1 : Math.min(...numeros, numero) - 1;
  w.pisos.push({ key: ++keySeq, numero, nombre: null, desde: null });
  updateDirty();
  renderLista();
}

async function eliminarPiso(w, p, counts) {
  if (w.accesoKey === p.key) {
    await window.uiAlert('Es el piso de acceso. Marca otro piso como acceso antes de eliminarlo.', 'Eliminar piso');
    return;
  }
  if (counts.total > 0) {
    const ok = await window.uiConfirm(
      `${pisoBase(p.numero)} tiene ${plural(counts.poi, 'punto de interés', 'puntos de interés')} y ${plural(counts.ruta, 'punto de ruta', 'puntos de ruta')}.\nAl guardar se eliminarán junto con sus conexiones.\n¿Eliminar el piso?`,
      'Eliminar piso');
    if (!ok) return;
  }
  w.pisos = w.pisos.filter(x => x.key !== p.key);
  updateDirty();
  renderLista();
}

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

  const body = {
    base_version: snapshotVersion,
    edificios: ids.map(id => {
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

  saving = true;
  updateDirty();
  try {
    const res = await fetch(`${ROOT_PATH}/admin/api/sedes/${sedeId}/edificios`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 409 || res.status === 422) {
      const detail = (await res.json().catch(() => ({}))).detail;
      const text = typeof detail === 'string' ? detail : 'Datos inválidos';
      if (res.status === 409) {
        await window.uiAlert(`${text}.\nSe recargarán los edificios con la versión actual; vuelve a hacer tus cambios.`, 'No se guardó');
        saving = false;
        resetState();
        await cargarEdificios();
      } else {
        await window.uiAlert(`${text}.`, 'No se guardó');
      }
      return;
    }
    if (!res.ok) throw new Error();
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
