// =============================================================================
// Editor de mapa (NaviUSM Studio)
// Modos: Ver (consultar), Crear (menú contextual en el punto del clic) y Modificar
// (seleccionar, mover y editar). Todo cambio pasa por commit(), que guarda el
// estado anterior para deshacer/rehacer. Además: trazado continuo de rutas,
// división de conexiones, búsqueda, revisión antes de publicar, borrador local
// y ayudas junto al cursor.
// =============================================================================

// ── Configuración ──
const BASE_URL = window.APP_CONFIG.rootPath;
const SEDES_INFO = window.APP_CONFIG.sedesInfo;
// Mapa base configurable desde el servidor (MAP_TILE_URL); por defecto, OpenStreetMap
const MAP_TILES = window.MAP_TILES || {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  max_zoom: 19,
};

// Íconos de datos: se guardan en el snapshot y los usa la app móvil
const SYSTEM_TYPES = {
  waypoint: { icon: '🔵', size: 22 },
  building: { icon: '🏛️', size: 30 },
  entrance: { icon: '🚪', size: 26 },
  'baño': { icon: '🚽', size: 26 },
  seguridad: { icon: '👮🏻', size: 26 },
  servicio: { icon: '🏥', size: 26 }
};
const NODE_TYPE_LABELS = {
  waypoint: 'Punto de ruta', building: 'Edificio', entrance: 'Entrada / Sala',
  'baño': 'Baño', seguridad: 'Puesto de seguridad', servicio: 'Servicio'
};
// Tipos que se crean o asignan desde el menú y el popup ("Edificio" se dibuja aparte, por su contorno)
const NODE_TYPES_MENU = ['waypoint', 'entrance', 'baño', 'seguridad', 'servicio'];
const ZONE_KINDS = {
  zonaseg: { tag: 'zona_segura', color: '#1f7a5c' },
  edificio: { tag: 'contorno_edificio', color: '#3b6e8f' },
};
const HISTORY_LIMIT = 100;
const STATUS_RESET_MS = 7000;

// ── Estado ──
let map;
let nodes = [], edges = [], zones = [];
let mode = 'view';              // 'view' | 'create' | 'modify'
let waypointMode = false;       // Crear: cada clic crea un punto de ruta conectado al anterior (trazado continuo)
let route = null;               // trazado en curso: { trail: [ids] }; el último existente es el ancla
let stairsMode = false;         // Crear: las conexiones nuevas son escaleras
let currentFloor = 1, currentBuilding = 'exterior';
let currentSedeId = null;       // sede cargada; para revertir el selector si se cancela el cambio
let snapshotVersion = null;     // versión publicada que se cargó; el servidor rechaza publicar sobre otra más nueva
let hasUnsavedChanges = false;
let cleanState = null;          // mapa serializado al cargar o publicar; si el actual es idéntico, no hay cambios
let dirtyCheckPending = false;
let originalNodes = new Set(), originalBuildings = new Set();
let activePopup = null;         // popup abierto según los eventos de Leaflet (el DOM tarda ~200 ms en desaparecer)
let ctx = null;                 // menú contextual de Crear: { latlng, popup, step, options }
let edgeFrom = null;            // nodo de origen de una conexión en curso
let selection = null;           // { kind: 'node'|'edge'|'zone', id }
let hover = null;               // elemento bajo el cursor: { kind, id } o { kind: 'vertex', remove }
let lastCreated = null;         // { kind: 'node', type } | { kind: 'zone' } | { kind: 'building' }
let draw = null;                // dibujo en curso: { kind: 'zone'|'building', access, accessMarker, vertices, preview }
let editingZoneId = null;       // zona cuyo contorno se está editando
let editingZoneBackup = null;   // coordenadas al empezar, para cancelar
let undoStack = [], redoStack = [];
let commitDepth = 0;            // commit() anidado: un solo paso de historial por acción
let publishing = false;
let rubber = null;              // línea guía desde el ancla de una conexión o ruta hasta el cursor
let searchResults = [], searchIndex = -1;
let reviewOpen = false;
let hintsOn = readPref('naviusm-editor-hints', '1') === '1';
let draftTimer = null;
const DRAFT_VERSION = 1;

// =============================================================================
// Utilidades
// =============================================================================
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function readPref(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch (_) { return fallback; }
}

function writePref(key, value) {
  try { localStorage.setItem(key, value); } catch (_) { /* sin almacenamiento: solo dura esta sesión */ }
}

// Para buscar sin distinguir mayúsculas ni tildes
function normalizeText(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

// Huella corta de un texto (djb2), para saber si el mapa publicado cambió desde un borrador
function hashText(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

// Nombres que el editor pone solo (o vacíos): la revisión los marca como "sin nombre"
function hasAutoName(n) {
  const name = (n.name || '').trim();
  return !name || name === 'Sin nombre' || /^Nodo [0-9A-F]{8}$/.test(name);
}

function isPoiType(type) {
  return type !== 'waypoint' && type !== 'user';
}

function isEditableTarget(el) {
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

// Nombre de un piso: "Piso N" / "Subterráneo N", más su nombre si tiene ("Piso 2 - Mezzanine").
// En el exterior no hay pisos.
function floorLabel(numero, buildingId) {
  if (!buildingId || buildingId === 'exterior') return 'Exterior';
  const base = numero < 0 ? `Subterráneo ${-numero}` : `Piso ${numero}`;
  const piso = nodes.find(n => n.id === buildingId)?.pisos?.find(p => p.numero === numero);
  return piso?.nombre ? `${base} - ${piso.nombre}` : base;
}

// Pisos de un edificio desde el snapshot: formato 2.2 (pisos + acceso) o el anterior (min/max)
function pisosFromData(d) {
  let pisos;
  if (Array.isArray(d.pisos) && d.pisos.length) {
    pisos = d.pisos.map(p => ({ numero: parseInt(p.numero, 10), nombre: (p.nombre || '').trim() || null }));
  } else {
    const lo = parseInt(d.piso_min ?? d.min ?? 1, 10), hi = parseInt(d.piso_max ?? d.max ?? lo, 10);
    pisos = [];
    for (let i = Math.min(lo, hi); i <= Math.max(lo, hi); i++) pisos.push({ numero: i, nombre: null });
  }
  pisos.sort((a, b) => a.numero - b.numero);
  const numeros = pisos.map(p => p.numero);
  const acceso = numeros.includes(d.acceso) ? d.acceso : (numeros.includes(1) ? 1 : numeros[0]);
  return { pisos, acceso };
}

// Pisos válidos para un nodo del lugar indicado (el exterior tiene solo el 1)
function floorsOf(buildingId) {
  if (!buildingId || buildingId === 'exterior') return [1];
  const b = nodes.find(n => n.id === buildingId);
  return b ? b.pisos.map(p => p.numero) : [1];
}

// Edificios ordenados alfabéticamente (en selectores y listas, no por orden de creación)
function sortedBuildings() {
  return nodes.filter(n => n.type === 'building').sort((a, b) => (a.name || '').localeCompare(b.name || '', 'es', { sensitivity: 'base', numeric: true }));
}

function buildingName(id) {
  if (!id || id === 'exterior') return 'Campus (exterior)';
  const b = nodes.find(n => n.id === id);
  return b ? (b.name || 'Edificio') : 'Edificio';
}

function safeLinkHtml(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return `<a href="${escapeHtml(u.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
    }
  } catch (_) { /* no es una URL válida: se muestra como texto */ }
  return escapeHtml(url);
}

// Leaflet inserta el contenido string de un tooltip como HTML: siempre escapar el nombre
function setNodeTooltip(marker, name) {
  marker.bindTooltip(escapeHtml(name), { permanent: false, direction: 'top' });
}

// Ubica el popup dentro del mapa sin moverlo: por defecto arriba del punto; si no cabe, abajo
// (o donde haya más espacio), y lo corre hacia los lados dejando la punta sobre el punto.
// Se basa en Popup._updatePosition de Leaflet 1.9.4: bottom = -offset.y y left = -ancho/2 + offset.x.
const POPUP_MARGIN = 10;
const POPUP_TIP = 20;      // alto de la punta (.leaflet-popup-tip-container / margin-bottom de .leaflet-popup)
const POPUP_OFFSET_Y = 7;  // offset por defecto de L.Popup

function fitPopup(popup) {
  if (!popup || !popup.isOpen()) return;
  const el = popup.getElement();
  const tip = el.querySelector('.leaflet-popup-tip-container');
  popup.options.offset = [0, POPUP_OFFSET_Y];
  el.classList.remove('nv-below');
  if (tip) tip.style.left = '';
  popup.update(); // recalcula el ancho con el contenido actual

  const size = map.getSize();
  const p = map.latLngToContainerPoint(popup.getLatLng());
  const w = el.offsetWidth;
  const h = el.offsetHeight; // sin la punta: va en position:absolute fuera del flujo
  const spaceAbove = p.y - POPUP_TIP - POPUP_MARGIN;
  const spaceBelow = size.y - p.y - POPUP_TIP - POPUP_MARGIN;
  const below = h > spaceAbove && spaceBelow > spaceAbove;

  const idealLeft = p.x - w / 2;
  const clampLeft = (x) => Math.max(POPUP_MARGIN, Math.min(x, size.x - POPUP_MARGIN - w));
  let left = clampLeft(idealLeft);
  const top = below ? p.y + POPUP_TIP : p.y - POPUP_TIP + POPUP_OFFSET_Y - h;

  // El panel y el estado flotan sobre el mapa (por encima de los popups): si el popup queda debajo
  // de uno, se corre hacia el lado libre manteniendo la punta sobre el punto; si no se puede, se atenúa
  const overlaps = (r, l) => l < r.right && l + w > r.left && top < r.bottom && top + h > r.top;
  const tipFits = (l) => p.x >= l + 24 && p.x <= l + w - 24;
  document.querySelectorAll('.map-overlay.is-covered').forEach(o => o.classList.remove('is-covered'));
  mapOverlayRects().forEach(({ el: overlay, rect }) => {
    if (!overlaps(rect, left)) return;
    const alt = [rect.right + POPUP_MARGIN, rect.left - POPUP_MARGIN - w]
      .find(l => l === clampLeft(l) && tipFits(l) && !overlaps(rect, l));
    if (alt !== undefined) left = alt;
    else overlay.classList.add('is-covered');
  });
  const dx = Math.round(left - idealLeft);

  if (below) el.classList.add('nv-below');
  // Abajo: el borde inferior queda en p.y + punta + alto (bottom = -offset.y)
  popup.options.offset = [dx, below ? POPUP_TIP + h : POPUP_OFFSET_Y];
  popup.update();
  if (tip && dx) {
    const tipCenter = Math.max(24, Math.min(w - 24, w / 2 - dx));
    tip.style.left = tipCenter + 'px';
  }
}

// Rectángulos (relativos al mapa) de los elementos flotantes visibles sobre el mapa
function mapOverlayRects() {
  const m = map.getContainer().getBoundingClientRect();
  return [...document.querySelectorAll('.map-overlay')]
    .filter(el => !el.hidden && el.offsetParent !== null)
    .map(el => {
      const r = el.getBoundingClientRect();
      return { el, rect: { left: r.left - m.left, right: r.right - m.left, top: r.top - m.top, bottom: r.bottom - m.top } };
    });
}

// Aviso breve en el mapa, donde el usuario está mirando
function showMapHint(latlng, msg) {
  const hint = L.tooltip(latlng, { content: escapeHtml(msg), direction: 'top', offset: [0, -8], className: 'map-hint' });
  hint.openOn(map);
  setTimeout(() => hint.remove(), 2500);
}

function shadeColor(hex, p) {
  const num = parseInt(hex.replace('#', ''), 16);
  const blend = (c) => Math.round(p > 0 ? c + (255 - c) * p : c + c * p);
  return '#' + [blend((num >> 16) & 0xFF), blend((num >> 8) & 0xFF), blend(num & 0xFF)].map(c => Math.min(255, Math.max(0, c)).toString(16).padStart(2, '0')).join('');
}

function colorForZone(zone) {
  const k = Object.values(ZONE_KINDS).find(k => zone.tags.includes(k.tag));
  return k ? k.color : '#888888';
}

// Colores de dibujo según el tema (definidos en admin.css), para mantener el contraste sobre el mapa claro u oscuro
function themeVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function isLightTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light';
}

function edgeColor(e) {
  return themeVar(e.es_escalera ? '--map-stairs' : '--map-edge');
}

// =============================================================================
// Estado "con cambios" y píldora de estado
// =============================================================================
window.addEventListener('beforeunload', (e) => {
  if (!hasUnsavedChanges) return;
  e.preventDefault();  // forma estándar de pedir confirmación al salir
  e.returnValue = '';  // compatibilidad con navegadores antiguos
});

// Compara el mapa actual con el último cargado o publicado (una vez por cuadro, aunque se llame en cada arrastre)
function markDirty() {
  if (dirtyCheckPending) return;
  dirtyCheckPending = true;
  requestAnimationFrame(() => {
    dirtyCheckPending = false;
    const json = JSON.stringify(serializeState());
    setDirty(json !== cleanState);
    scheduleDraftSave(json);
    if (reviewOpen) renderReview();
  });
}

function markClean() {
  cleanState = JSON.stringify(serializeState());
  setDirty(false);
}

function setDirty(dirty) {
  hasUnsavedChanges = dirty;
  document.getElementById('dirty-badge').hidden = !dirty;
}

// =============================================================================
// Borrador local: copia de los cambios sin publicar en este navegador, por sede.
// Se ofrece recuperarla al volver a abrir la sede y se borra al publicar o descartar.
// =============================================================================
function draftKey(sedeId) {
  return `naviusm-draft:${sedeId}`;
}

// La clave y el contenido se fijan al programar el guardado, por si cambia la sede antes de escribir
function scheduleDraftSave(json) {
  clearTimeout(draftTimer);
  const sedeId = currentSedeId, dirty = hasUnsavedChanges, base = hashText(cleanState || '');
  if (!sedeId) return;
  draftTimer = setTimeout(() => {
    try {
      if (!dirty) { localStorage.removeItem(draftKey(sedeId)); return; }
      localStorage.setItem(draftKey(sedeId), `{"v":${DRAFT_VERSION},"savedAt":${Date.now()},"base":"${base}","state":${json}}`);
    } catch (_) { /* sin espacio o almacenamiento bloqueado: el borrador es solo una ayuda */ }
  }, 800);
}

function clearDraft(sedeId) {
  clearTimeout(draftTimer);
  try { localStorage.removeItem(draftKey(sedeId)); } catch (_) { /* nada que borrar */ }
}

async function offerDraftRecovery(sedeId) {
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(draftKey(sedeId)) || 'null'); } catch (_) { draft = null; }
  if (!draft || draft.v !== DRAFT_VERSION || !draft.state) return;
  if (JSON.stringify(draft.state) === cleanState) { clearDraft(sedeId); return; }

  const when = new Date(draft.savedAt).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' });
  const changed = draft.base !== hashText(cleanState || '');
  const msg = `Hay cambios sin publicar de esta sede guardados en este navegador (${when}).`
    + (changed ? '\nEl mapa publicado cambió después de ese borrador: si lo recuperas y publicas, reemplazará lo publicado.' : '')
    + '\n¿Recuperarlos? Si eliges Cancelar, el borrador se descarta.';
  if (!(await window.uiConfirm(msg, 'Recuperar cambios'))) { clearDraft(sedeId); return; }
  if (currentSedeId !== sedeId) return; // se cambió de sede mientras estaba abierto el diálogo
  pushHistory(); // deshacer vuelve al mapa publicado
  restoreState(draft.state);
  setStatus('Cambios recuperados del borrador', 'ok');
}

let baseStatus = { msg: 'Listo', state: 'ok' };
let statusTimer = null;

function renderStatus(msg, state) {
  document.getElementById('status-txt').textContent = msg;
  document.getElementById('sdot').className = 's-dot' + (state === 'warn' ? ' warn' : state === 'err' ? ' err' : '');
}

// base: estado de fondo al que se vuelve. sticky: se mantiene hasta el próximo setStatus.
// Por defecto el mensaje es temporal y a los 7 s vuelve al estado base.
function setStatus(msg, state, { base = false, sticky = false } = {}) {
  clearTimeout(statusTimer);
  renderStatus(msg, state);
  if (base) { baseStatus = { msg, state }; return; }
  if (!sticky) statusTimer = setTimeout(restoreBaseStatus, STATUS_RESET_MS);
}

function restoreBaseStatus() {
  clearTimeout(statusTimer);
  renderStatus(baseStatus.msg, baseStatus.state);
}

// =============================================================================
// Inicio
// =============================================================================
window.addEventListener('load', () => {
  // Renderizador Canvas: permite 'tolerance', que agrega margen de clic alrededor de líneas y polígonos
  map = L.map('map', { zoomControl: false, maxZoom: 22, renderer: L.canvas({ tolerance: 8 }) });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  // Más allá de max_zoom no se piden mosaicos: Leaflet amplía los del último nivel disponible
  L.tileLayer(MAP_TILES.url, {
    maxZoom: 22, maxNativeZoom: MAP_TILES.max_zoom, attribution: MAP_TILES.attribution
  }).addTo(map);

  map.on('click', onMapClick);
  map.on('mousemove', onMapMouseMove);
  map.on('mouseout', hideCursorHint);
  map.on('popupopen', (e) => { activePopup = e.popup; fitPopup(e.popup); });
  map.on('popupclose', (e) => {
    if (activePopup === e.popup) activePopup = null;
    document.querySelectorAll('.map-overlay.is-covered').forEach(o => o.classList.remove('is-covered'));
    if (ctx && ctx.popup === e.popup) ctx = null;
    if (e.popup.options.className?.includes('nv-edit')) clearSelection();
  });
  // Fase de captura: corre antes que el manejador de Esc de Leaflet, con el popup aún abierto
  document.addEventListener('keydown', onKeyDown, true);
  new MutationObserver(applyThemeToMap).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  initSearch();
  setToggle('btn-hints', hintsOn);

  centrarMapaEnSede();
  loadFromServer();
});

function centrarMapaEnSede() {
  const sedeId = document.getElementById('sede-selector')?.value;
  const info = SEDES_INFO.find(s => s.id === sedeId);
  if (info) map.setView([info.lat, info.lng], info.zoom);
}

// =============================================================================
// Modos y opciones de creación
// =============================================================================
function setMode(m, { force = false } = {}) {
  if (m === mode && !force) return;
  if (editingZoneId) finishVertexEditing();
  if (draw) cancelDrawing();
  cancelEdge();
  endRoute();
  clearSelection();
  if (map) map.closePopup();
  mode = m;

  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  document.getElementById('create-options').hidden = m !== 'create';
  const mapEl = document.getElementById('map');
  mapEl.classList.remove('mode-view', 'mode-create', 'mode-modify');
  mapEl.classList.add('mode-' + m);
  applyMarkerDragging();
}

function setToggle(id, on) {
  const b = document.getElementById(id);
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function toggleWaypointMode() {
  waypointMode = !waypointMode;
  setToggle('btn-waypoints', waypointMode);
  cancelEdge();
  if (!waypointMode) endRoute();
  setStatus(waypointMode ? 'Puntos de ruta: cada clic crea un punto conectado al anterior' : 'Puntos de ruta desactivado', 'ok');
}

function toggleHints() {
  hintsOn = !hintsOn;
  writePref('naviusm-editor-hints', hintsOn ? '1' : '0');
  setToggle('btn-hints', hintsOn);
  if (!hintsOn) hideCursorHint();
  setStatus(hintsOn ? 'Ayudas junto al cursor activadas' : 'Ayudas junto al cursor desactivadas', 'ok');
}

function toggleStairsMode() {
  stairsMode = !stairsMode;
  setToggle('btn-stairs', stairsMode);
  setStatus(stairsMode ? 'Las conexiones nuevas serán escaleras' : 'Las conexiones nuevas serán normales', 'ok');
}

function toggleLegend() {
  const legend = document.getElementById('map-legend');
  legend.hidden = !legend.hidden;
  document.getElementById('btn-legend').setAttribute('aria-expanded', legend.hidden ? 'false' : 'true');
}

function openHelp() {
  bootstrap.Modal.getOrCreateInstance(document.getElementById('helpModal')).show();
}

function setMarkerDraggable(marker, enabled) {
  // options.draggable se respeta si el marcador aún no está en el mapa (otro piso);
  // dragging existe solo después de agregarlo por primera vez
  marker.options.draggable = enabled;
  if (marker.dragging) enabled ? marker.dragging.enable() : marker.dragging.disable();
}

function applyMarkerDragging() {
  nodes.forEach(n => setMarkerDraggable(n.marker, mode === 'modify'));
}

// =============================================================================
// Teclado
// =============================================================================
function onKeyDown(ev) {
  if (document.querySelector('.modal.show')) return; // diálogo o ayuda abiertos
  const key = ev.key || '';
  const lower = key.toLowerCase();
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && !ev.altKey && lower === 'f') { ev.preventDefault(); focusSearch(); return; }
  // El buscador maneja sus propias teclas (flechas, Enter, Esc)
  if (ev.target.id === 'map-search') return;
  const inField = isEditableTarget(ev.target);
  const inPopup = !!ev.target.closest?.('.leaflet-popup');
  const inBar = !!ev.target.closest?.('.map-bar');

  if (key === 'Escape') {
    // Esc en un campo fuera del mapa (p. ej. el selector de sede): solo sale del campo
    if (inField && !inPopup && !inBar) { ev.target.blur(); return; }
    handleEscape();
    return;
  }
  if (key === 'Enter' && !ev.shiftKey && ev.target.tagName !== 'TEXTAREA' && ev.target.tagName !== 'SELECT') {
    if (handleEnter(ev)) ev.preventDefault();
    return;
  }
  if (mod && !ev.altKey && lower === 's') { ev.preventDefault(); publishToServer(); return; }
  if (inField) return;
  if (mod && !ev.altKey && lower === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
  if (mod && !ev.altKey && lower === 'y') { ev.preventDefault(); redo(); return; }
  if (mod || ev.altKey) return;

  if (key === 'Delete' || key === 'Backspace') {
    if (deleteHoveredOrSelected()) ev.preventDefault();
    return;
  }
  if (key === '?') { ev.preventDefault(); openHelp(); return; }
  if (key === '/') { ev.preventDefault(); focusSearch(); return; }
  if (/^[0-9]$/.test(key) && ctx && ctx.step === 'menu') {
    const opt = ctx.options.find(o => o.key === key);
    if (opt) { ev.preventDefault(); opt.action(); }
    return;
  }
  const shortcuts = {
    v: () => setMode('view'),
    c: () => setMode('create'),
    m: () => setMode('modify'),
    l: () => toggleLegend(),
    h: () => toggleHints(),
    r: () => (reviewOpen ? closeReview() : openReview()),
    w: () => { if (mode === 'create') toggleWaypointMode(); },
    e: () => { if (mode === 'create') toggleStairsMode(); },
  };
  if (shortcuts[lower]) { ev.preventDefault(); shortcuts[lower](); }
}

// Enter: guarda el formulario abierto, termina la edición de contorno o guarda el dibujo
function handleEnter(ev) {
  const popupEl = ev.target.closest?.('.leaflet-popup') || activePopup?.getElement();
  const primary = popupEl?.querySelector('[data-primary]');
  if (primary) { primary.click(); return true; }
  if (editingZoneId) { finishVertexEditing(); return true; }
  if (draw) { saveDrawing(); return true; }
  if (route) { endRoute(); return true; }
  return false;
}

// Esc deshace un nivel por vez: popup, edición de contorno, dibujo, ruta, conexión, revisión, selección y por último vuelve a Ver
function handleEscape() {
  if (activePopup) { map.closePopup(); return; }
  if (editingZoneId) { cancelVertexEditing(); return; }
  if (draw) { cancelDrawing(); return; }
  if (route) { endRoute(); return; }
  if (edgeFrom) { cancelEdge(); return; }
  if (reviewOpen) { closeReview(); return; }
  if (selection) { clearSelection(); return; }
  if (mode !== 'view') setMode('view');
}

// =============================================================================
// Historial (deshacer / rehacer)
// Antes de cada cambio se guarda una copia serializable del mapa; deshacer la restaura.
// =============================================================================
function serializeState() {
  return {
    nodes: nodes.map(n => ({
      id: n.id, type: n.type, name: n.name, icon: n.icon, lat: n.latlng.lat, lng: n.latlng.lng,
      floor: n.floor, building: n.building,
      pisos: n.pisos ? n.pisos.map(p => ({ ...p })) : undefined, acceso: n.acceso,
      horario: n.horario, descripcion: n.descripcion, link_derivacion: n.link_derivacion,
    })),
    edges: edges.map(e => ({ id: e.id, from: e.from, to: e.to, weight: e.weight, es_escalera: !!e.es_escalera })),
    zones: zones.map(z => ({ id: z.id, building: z.building, name: z.name, tags: [...z.tags], color: z.color, geojson: JSON.parse(JSON.stringify(z.geojson)) })),
  };
}

function pushHistory() {
  undoStack.push(serializeState());
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  updateHistoryButtons();
}

function updateHistoryButtons() {
  document.getElementById('btn-undo').disabled = undoStack.length === 0;
  document.getElementById('btn-redo').disabled = redoStack.length === 0;
}

// Aplica un cambio guardando antes el estado para poder deshacerlo
function commit(fn) {
  if (commitDepth === 0) pushHistory();
  commitDepth++;
  try { fn(); } finally { commitDepth--; }
  if (commitDepth > 0) return;
  syncAnchors();
  markDirty();
  renderMapNodes();
}

function undo() {
  if (editingZoneId) { setStatus('Termina o cancela la edición del contorno', 'warn'); return; }
  if (draw) { removeLastDrawVertex(); return; }
  const prev = undoStack.pop();
  if (!prev) { setStatus('Nada que deshacer', 'ok'); return; }
  redoStack.push(serializeState());
  restoreState(prev);
  setStatus('Cambio deshecho', 'ok');
}

function redo() {
  if (editingZoneId || draw) { setStatus('Termina o cancela lo que estás dibujando', 'warn'); return; }
  const next = redoStack.pop();
  if (!next) { setStatus('Nada que rehacer', 'ok'); return; }
  undoStack.push(serializeState());
  restoreState(next);
  setStatus('Cambio rehecho', 'ok');
}

function restoreState(state) {
  if (map) map.closePopup();
  cancelEdge();
  selection = null;
  hover = null;
  clearLayers();
  buildFromState(state);
  updateBuildingSelector();
  syncAnchors(); // al deshacer durante una ruta, el ancla vuelve al punto anterior que siga existiendo
  renderMapNodes();
  markDirty();
  updateHistoryButtons();
}

function resetHistory() {
  undoStack = [];
  redoStack = [];
  updateHistoryButtons();
}

// =============================================================================
// Construcción de nodos, conexiones y zonas
// =============================================================================
function clearLayers() {
  nodes.forEach(n => n.marker.removeFrom(map));
  edges.forEach(e => e.line.removeFrom(map));
  zones.forEach(z => z.polygon && z.polygon.removeFrom(map));
  nodes = []; edges = []; zones = [];
}

function buildFromState(state) {
  state.nodes.forEach(createNodeObject);
  state.edges.forEach(createEdgeObject);
  state.zones.forEach(createZoneObject);
}

function createNodeObject(d) {
  const sys = SYSTEM_TYPES[d.type] || SYSTEM_TYPES.waypoint;
  const el = document.createElement('div');
  el.className = `graph-node type-${d.type}`;
  el.style.width = sys.size + 'px';
  el.style.height = sys.size + 'px';
  const icon = d.icon || sys.icon;
  el.textContent = icon;

  const latlng = L.latLng(d.lat, d.lng);
  const marker = L.marker(latlng, {
    icon: L.divIcon({ html: el, iconSize: [sys.size, sys.size], className: '' }),
    draggable: mode === 'modify',
    keyboard: false,
  });
  setNodeTooltip(marker, d.name);

  const node = { id: d.id, type: d.type, name: d.name, icon, latlng, floor: d.floor, building: d.building || 'exterior', marker, el };
  if (d.type === 'building') Object.assign(node, pisosFromData(d));
  if (isPoiType(d.type)) {
    node.horario = d.horario || '';
    node.descripcion = d.descripcion || '';
    node.link_derivacion = d.link_derivacion || '';
  }

  marker.on('click', (ev) => { L.DomEvent.stopPropagation(ev); onNodeClick(node.id, ev); });
  marker.on('contextmenu', (ev) => {
    L.DomEvent.stopPropagation(ev);
    L.DomEvent.preventDefault(ev.originalEvent);
    if (mode !== 'view' && !draw && !editingZoneId) deleteElement('node', node.id);
  });
  marker.on('mouseover', () => { hover = { kind: 'node', id: node.id }; });
  marker.on('mouseout', () => { if (hover?.kind === 'node' && hover.id === node.id) hover = null; });
  marker.on('dragstart', () => pushHistory());
  // Durante el arrastre las conexiones siguen al nodo; al soltar se recalcula su peso (lo usa la app para las rutas)
  marker.on('drag', () => { node.latlng = marker.getLatLng(); updateNodeLines(node.id); });
  marker.on('dragend', () => {
    node.latlng = marker.getLatLng();
    updateNodeLines(node.id, { reweigh: true });
    markDirty();
  });

  nodes.push(node);
  return node;
}

function createEdgeObject(d) {
  const fn = nodes.find(x => x.id === d.from), tn = nodes.find(x => x.id === d.to);
  if (!fn || !tn) return null;
  const line = L.polyline([fn.latlng, tn.latlng], { color: edgeColor(d), weight: 3 });
  const edge = { id: d.id, from: d.from, to: d.to, weight: d.weight, es_escalera: !!d.es_escalera, line };

  line.on('click', (ev) => onEdgeClick(edge.id, ev));
  line.on('contextmenu', (ev) => {
    L.DomEvent.stopPropagation(ev);
    L.DomEvent.preventDefault(ev.originalEvent);
    if (mode !== 'view' && !draw && !editingZoneId) deleteElement('edge', edge.id);
  });
  line.on('mouseover', () => { hover = { kind: 'edge', id: edge.id }; });
  line.on('mouseout', () => { if (hover?.kind === 'edge' && hover.id === edge.id) hover = null; });

  edges.push(edge);
  return edge;
}

// El color guardado es dato del snapshot; aquí solo se ajusta cómo se dibuja según el tema
function zoneStyle(zone, selected = false) {
  const base = zone.color || colorForZone(zone);
  const light = isLightTheme();
  return {
    color: shadeColor(base, light ? -0.4 : -0.25),
    fillColor: shadeColor(base, light ? 0.1 : 0.45),
    fillOpacity: light ? 0.35 : 0.45,
    weight: selected ? 4 : (light ? 2.5 : 2),
    dashArray: null,
  };
}

// Al cambiar el tema se vuelven a pintar conexiones y zonas con los colores del tema nuevo
function applyThemeToMap() {
  zones.forEach(z => { if (z.id !== editingZoneId) z.polygon.setStyle(zoneStyle(z, selection?.id === z.id)); });
  renderMapNodes();
}

function createZoneObject(d) {
  const zone = { id: d.id, building: d.building || null, name: d.name, tags: d.tags || [], color: d.color, geojson: d.geojson, polygon: null };
  zone.polygon = L.geoJSON(zone.geojson, { style: zoneStyle(zone) }).addTo(map);
  // Las zonas van bajo las conexiones: en el canvas recibe el clic la figura de más arriba,
  // y una zona dibujada después taparía las conexiones que están dentro de ella
  zone.polygon.bringToBack();
  zone.polygon.on('click', (ev) => onZoneClick(zone.id, ev));
  zone.polygon.on('contextmenu', (ev) => {
    L.DomEvent.stopPropagation(ev);
    L.DomEvent.preventDefault(ev.originalEvent);
    if (mode !== 'view' && !draw && !editingZoneId) deleteElement('zone', zone.id);
  });
  zone.polygon.on('mouseover', () => { hover = { kind: 'zone', id: zone.id }; });
  zone.polygon.on('mouseout', () => { if (hover?.kind === 'zone' && hover.id === zone.id) hover = null; });
  zones.push(zone);
  return zone;
}

// Peso de una conexión: distancia en metros + 15 por piso de diferencia
function edgeWeight(f, t) {
  return map.distance(f.latlng, t.latlng) + Math.abs(f.floor - t.floor) * 15;
}

// Redibuja (y si se pide, vuelve a pesar) solo las conexiones de un nodo
function updateNodeLines(id, { reweigh = false } = {}) {
  edges.forEach(e => {
    if (e.from !== id && e.to !== id) return;
    const fn = nodes.find(n => n.id === e.from), tn = nodes.find(n => n.id === e.to);
    if (!fn || !tn) return;
    e.line.setLatLngs([fn.latlng, tn.latlng]);
    if (reweigh) e.weight = edgeWeight(fn, tn);
  });
}

// Funciones de borrado sin historial (las llama commit)
function removeNode(id) {
  const n = nodes.find(x => x.id === id);
  if (!n) return;
  n.marker.removeFrom(map);
  edges.filter(e => e.from === id || e.to === id).forEach(e => e.line.removeFrom(map));
  edges = edges.filter(e => e.from !== id && e.to !== id);
  nodes = nodes.filter(x => x.id !== id);
  if (n.type === 'building') updateBuildingSelector();
}

function removeEdge(id) {
  const e = edges.find(x => x.id === id);
  if (!e) return;
  e.line.removeFrom(map);
  edges = edges.filter(x => x.id !== id);
}

function removeZone(id) {
  const z = zones.find(x => x.id === id);
  if (!z) return;
  if (z.polygon) z.polygon.removeFrom(map);
  zones = zones.filter(x => x.id !== id);
}

// =============================================================================
// Selección, eliminación
// =============================================================================
function applySelectionStyle(sel, on) {
  if (!sel) return;
  if (sel.kind === 'node') nodes.find(n => n.id === sel.id)?.el.classList.toggle('is-selected', on);
  if (sel.kind === 'edge') edges.find(e => e.id === sel.id)?.line.setStyle({ weight: on ? 6 : 3 });
  if (sel.kind === 'zone') { const z = zones.find(x => x.id === sel.id); if (z) z.polygon.setStyle(zoneStyle(z, on)); }
}

function select(kind, id) {
  clearSelection();
  selection = { kind, id };
  applySelectionStyle(selection, true);
}

function clearSelection() {
  if (!selection) return;
  applySelectionStyle(selection, false);
  selection = null;
}

function deleteHoveredOrSelected() {
  if (mode === 'view') return false;
  const target = hover || selection;
  if (!target) return false;
  if (target.kind === 'vertex') { target.remove(); return true; }
  if (draw || editingZoneId) return false;
  deleteElement(target.kind, target.id);
  return true;
}

function deleteElement(kind, id) {
  if (mode === 'view') return;
  if (map) map.closePopup();
  if (kind === 'node') {
    const n = nodes.find(x => x.id === id);
    if (!n) return;
    if (n.type === 'building') { attemptDeleteBuilding(id); return; }
    commit(() => removeNode(id));
  } else if (kind === 'edge') {
    commit(() => removeEdge(id));
  } else if (kind === 'zone') {
    const z = zones.find(x => x.id === id);
    if (!z) return;
    if (z.building && z.tags.includes('contorno_edificio')) { attemptDeleteBuilding(z.building); return; }
    commit(() => removeZone(id));
  }
  if (selection?.id === id) selection = null;
  if (hover?.id === id) hover = null;
}

async function attemptDeleteBuilding(nodeId) {
  const childNodes = nodes.filter(n => n.building === nodeId);
  const salasCount = childNodes.filter(n => isPoiType(n.type) && n.type !== 'building').length;
  const confirmMsg = salasCount > 0
    ? `ADVERTENCIA: estás a punto de borrar un edificio con ${salasCount} salas/puntos.\n¿Estás seguro?`
    : '¿Eliminar este edificio y su contorno?';
  if (!(await window.uiConfirm(confirmMsg, 'Eliminar edificio'))) return;

  commit(() => {
    zones.filter(z => z.building === nodeId).forEach(z => {
      if (z.tags.includes('contorno_edificio')) removeZone(z.id);
      else z.building = null; // las zonas seguras asociadas se conservan, ahora en el exterior
    });
    childNodes.forEach(c => removeNode(c.id));
    removeNode(nodeId);
  });
  if (selection?.id === nodeId) selection = null;
}

// =============================================================================
// Clics en el mapa y en sus elementos
// =============================================================================
function onMapClick(e) {
  if (editingZoneId) { insertVertexIntoEditingZone(e.latlng); return; }
  if (draw) { addDrawVertex(e.latlng); return; }
  if (mode !== 'create') { clearSelection(); return; }
  if (waypointMode) { routeClickAt(e.latlng); return; }
  if (edgeFrom) { cancelEdge(); return; }
  if (e.originalEvent?.shiftKey && lastCreated) { repeatLast(e.latlng); return; }
  openCreateMenu(e.latlng);
}

function onNodeClick(id, ev) {
  if (editingZoneId) return;
  const n = nodes.find(x => x.id === id);
  if (!n) return;
  if (draw) { addDrawVertex(n.latlng); return; } // dibujar un contorno usando nodos como esquinas
  if (mode === 'view') { openInfoPopup('node', id, ev.latlng); return; }
  if (mode === 'create') {
    if (waypointMode) { routeToNode(id); return; }
    if (!edgeFrom) startEdge(id);
    else if (edgeFrom !== id) { createEdge(edgeFrom, id); cancelEdge(); }
    else cancelEdge();
    return;
  }
  select('node', id);
  openEditPopup('node', id, ev.latlng);
}

function onEdgeClick(id, ev) {
  // Al dibujar, el clic sigue hacia el mapa (agrega una esquina junto a la conexión)
  if (editingZoneId || draw) return;
  L.DomEvent.stopPropagation(ev);
  if (mode === 'create') { splitEdgeAt(id, ev.latlng); return; }
  if (mode === 'view') { openInfoPopup('edge', id, ev.latlng); return; }
  select('edge', id);
  openEditPopup('edge', id, ev.latlng);
}

function onZoneClick(id, ev) {
  if (editingZoneId) { L.DomEvent.stopPropagation(ev); insertVertexIntoEditingZone(ev.latlng); return; }
  // En Crear y al dibujar, el clic sigue hacia el mapa (permite crear dentro de una zona)
  if (draw || mode === 'create') return;
  L.DomEvent.stopPropagation(ev);
  if (mode === 'view') { openInfoPopup('zone', id, ev.latlng); return; }
  select('zone', id);
  openEditPopup('zone', id, ev.latlng);
}

// =============================================================================
// Crear: menú contextual
// =============================================================================
function labelForLast(last) {
  if (last.kind === 'node') return NODE_TYPE_LABELS[last.type] || last.type;
  return last.kind === 'building' ? 'Edificio' : 'Zona segura';
}

function openCreateMenu(latlng) {
  const popup = L.popup({ className: 'nv-popup nv-menu', closeButton: false, autoPan: false, minWidth: 220, maxWidth: 300 }).setLatLng(latlng);
  ctx = { latlng, popup, step: 'menu', options: [] };
  showMenuStep(rootMenuOptions(), 'Crear aquí');
  popup.openOn(map);
}

// Teclas fijas: 1 Nodo, 2 Edificio, 3 Zona segura y 0 Repetir (solo si ya se creó algo).
// Cada acción lee la posición antes de cerrar el popup (al cerrarse, ctx se limpia).
function rootMenuOptions() {
  const opts = [];
  if (lastCreated) {
    opts.push({ key: '0', label: `Repetir: ${labelForLast(lastCreated)}`, hint: 'Shift + clic', action: () => repeatLast(ctx.latlng) });
  }
  opts.push({ key: '1', label: 'Nodo', hint: 'Elegir tipo', action: () => showMenuStep(nodeTypeOptions(), 'Tipo de nodo', true) });
  opts.push({ key: '2', label: 'Edificio', hint: 'Datos y contorno', action: () => showNodeForm('building') });
  opts.push({ key: '3', label: 'Zona segura', hint: 'Dibujar contorno', action: () => { const ll = ctx.latlng; map.closePopup(); startDrawing('zone', ll); } });
  return opts;
}

function nodeTypeOptions() {
  return NODE_TYPES_MENU.map((type, i) => ({
    key: String(i + 1),
    label: NODE_TYPE_LABELS[type],
    dotClass: `type-dot type-${type}`,
    action: () => {
      if (type === 'waypoint') { const ll = ctx.latlng; map.closePopup(); createNode('waypoint', ll); }
      else showNodeForm(type);
    },
  }));
}

function showMenuStep(options, title, withBack = false) {
  ctx.step = 'menu';
  ctx.options = options;
  const root = document.createElement('div');
  const h = document.createElement('div');
  h.className = 'ctx-title';
  h.textContent = title;
  root.appendChild(h);

  options.forEach((o) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item';
    const k = document.createElement('kbd');
    k.textContent = o.key;
    b.appendChild(k);
    if (o.dotClass) { const dot = document.createElement('span'); dot.className = o.dotClass; b.appendChild(dot); }
    const label = document.createElement('span');
    label.textContent = o.label;
    b.appendChild(label);
    if (o.hint) { const s = document.createElement('small'); s.textContent = o.hint; b.appendChild(s); }
    b.addEventListener('click', (ev) => { L.DomEvent.stop(ev); o.action(); });
    root.appendChild(b);
  });

  if (withBack) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'ctx-item ctx-back';
    back.textContent = '< Volver';
    back.addEventListener('click', (ev) => { L.DomEvent.stop(ev); showMenuStep(rootMenuOptions(), 'Crear aquí'); });
    root.appendChild(back);
  }
  ctx.popup.setContent(root);
  fitPopup(ctx.popup);
}

// Formulario de un nodo nuevo con datos (POI o edificio). En el edificio, al enviarlo empieza el dibujo del contorno.
function showNodeForm(type) {
  ctx.step = 'form';
  const isBld = type === 'building';
  const form = document.createElement('form');
  form.className = 'pop-edit';
  form.innerHTML = `
    <div class="ctx-title">Nuevo: ${escapeHtml(NODE_TYPE_LABELS[type])}</div>
    <label>Nombre</label>
    <input name="name" type="text" class="form-control form-control-sm mb-2" maxlength="255" placeholder="${isBld ? 'Ej: Edificio A' : 'Ej: Sala C-304'}">
    <label>Ícono en la app</label>
    <input name="icon" type="text" class="form-control form-control-sm mb-2" maxlength="4" value="${escapeHtml(SYSTEM_TYPES[type].icon)}">
    <label>Horario</label>
    <input name="horario" type="text" class="form-control form-control-sm mb-2" placeholder="Ej: Lun a Vie, 8:30 - 17:00">
    <label>Descripción</label>
    <textarea name="descripcion" class="form-control form-control-sm mb-2" rows="2"></textarea>
    <label>Link</label>
    <input name="link" type="url" class="form-control form-control-sm mb-2" placeholder="https://...">
    <div class="pop-actions">
      <span class="spacer"></span>
      <button type="button" class="btn btn-sm btn-secondary" data-cancel>Cancelar</button>
      <button type="submit" class="btn btn-sm btn-accent" data-primary>${isBld ? 'Dibujar contorno' : 'Crear'}</button>
    </div>
    ${isBld ? '<div class="panel-meta mt-2">Este punto queda como acceso del edificio.</div>' : ''}`;
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const fields = Object.fromEntries(new FormData(form));
    const ll = ctx.latlng;
    map.closePopup();
    if (isBld) startDrawing('building', ll, fields);
    else createNode(type, ll, fields);
  });
  form.querySelector('[data-cancel]').addEventListener('click', () => map.closePopup());
  ctx.popup.setContent(form);
  fitPopup(ctx.popup);
  setTimeout(() => form.querySelector('input[name="name"]').focus(), 0);
}

// Repetir: el punto de ruta y la zona empiezan de inmediato; los nodos con datos y el edificio abren su formulario
function repeatLast(latlng) {
  if (!lastCreated) return;
  const { kind, type } = lastCreated;
  if (kind === 'zone' || (kind === 'node' && type === 'waypoint')) {
    map.closePopup();
    if (kind === 'zone') startDrawing('zone', latlng);
    else createNode('waypoint', latlng);
    return;
  }
  if (!ctx || !ctx.popup.isOpen()) openCreateMenu(latlng);
  showNodeForm(kind === 'building' ? 'building' : type);
}

// Nodo existente a menos de medio metro en el piso visible (evita duplicados por doble clic)
function nodeAtPoint(latlng, floor = currentFloor) {
  return nodes.find(n => n.floor === floor && n.latlng.distanceTo(latlng) < 0.5) || null;
}

// Crea el nodo sin historial (lo llama commit)
function addNodeRaw(type, latlng, fields = {}, { floor = currentFloor, building = currentBuilding } = {}) {
  const id = crypto.randomUUID();
  const shortId = id.split('-')[0].toUpperCase();
  const sys = SYSTEM_TYPES[type];
  return createNodeObject({
    id, type,
    name: (fields.name || '').trim() || (type === 'waypoint' ? `WP-${shortId}` : `Nodo ${shortId}`),
    icon: (isPoiType(type) && (fields.icon || '').trim()) || sys.icon,
    lat: latlng.lat, lng: latlng.lng, floor, building,
    horario: (fields.horario || '').trim(), descripcion: (fields.descripcion || '').trim(), link_derivacion: (fields.link || '').trim(),
  });
}

function createNode(type, latlng, fields = {}) {
  if (nodeAtPoint(latlng)) return null;
  let node = null;
  commit(() => { node = addNodeRaw(type, latlng, fields); });
  lastCreated = { kind: 'node', type };
  return node;
}

// =============================================================================
// Crear: conexiones
// =============================================================================
function startEdge(id) {
  edgeFrom = id;
  markAnchor(id);
  setStatus('Elige el nodo de destino (Esc cancela)', 'warn', { sticky: true });
}

function cancelEdge() {
  if (!edgeFrom) return;
  edgeFrom = null;
  markAnchor(routeAnchor());
  updateRubber(null);
  restoreBaseStatus();
}

function edgeExists(a, b) {
  return edges.some(e => (e.from === a && e.to === b) || (e.from === b && e.to === a));
}

// Crea la conexión sin historial (lo llama commit). Peso: distancia en metros + 15 por piso de diferencia
function addEdgeRaw(from, to, esEscalera = stairsMode) {
  if (from === to || edgeExists(from, to)) return null;
  const f = nodes.find(n => n.id === from), t = nodes.find(n => n.id === to);
  if (!f || !t) return null;
  return createEdgeObject({ id: crypto.randomUUID(), from, to, weight: edgeWeight(f, t), es_escalera: esEscalera });
}

function createEdge(from, to) {
  if (edgeExists(from, to)) {
    showMapHint(nodes.find(n => n.id === to).latlng, 'Esos nodos ya están conectados');
    return;
  }
  commit(() => addEdgeRaw(from, to));
}

// =============================================================================
// Crear: trazado continuo de rutas (con "Puntos de ruta" activo)
// Cada clic crea un punto conectado al anterior; un clic en un nodo existente lo conecta
// y la ruta sigue desde él. Enter, Esc o "Terminar" cierran la ruta.
// =============================================================================
function routeAnchor() {
  return route ? route.trail.at(-1) : null;
}

function setRouteAnchor(id) {
  if (!route) route = { trail: [] };
  if (route.trail.at(-1) !== id) route.trail.push(id);
  document.getElementById('route-bar').hidden = false;
  markAnchor(id);
}

function endRoute() {
  if (!route) return;
  route = null;
  document.getElementById('route-bar').hidden = true;
  markAnchor(edgeFrom);
  updateRubber(null);
}

function routeClickAt(latlng) {
  const existing = nodeAtPoint(latlng);
  if (existing) { routeToNode(existing.id); return; }
  const from = routeAnchor();
  let wp = null;
  commit(() => {
    wp = addNodeRaw('waypoint', latlng);
    if (from) addEdgeRaw(from, wp.id);
  });
  lastCreated = { kind: 'node', type: 'waypoint' };
  setRouteAnchor(wp.id);
}

function routeToNode(id) {
  const from = routeAnchor();
  if (from === id) { endRoute(); return; } // clic de nuevo en el último punto: termina
  if (from && !edgeExists(from, id)) commit(() => addEdgeRaw(from, id));
  setRouteAnchor(id);
}

// Resalta el nodo desde el que sale la próxima conexión (ruta o conexión simple)
function markAnchor(id) {
  nodes.forEach(n => n.el.classList.toggle('is-edge-source', n.id === id));
}

// Tras cambios o deshacer: el ancla debe seguir existiendo (y los nodos recreados pierden su clase)
function syncAnchors() {
  if (edgeFrom && !nodes.some(n => n.id === edgeFrom)) cancelEdge();
  if (route) {
    route.trail = route.trail.filter(id => nodes.some(n => n.id === id));
    if (!route.trail.length) { endRoute(); return; }
  }
  markAnchor(routeAnchor() || edgeFrom);
}

// Línea guía del ancla al cursor
function updateRubber(latlng) {
  const fromId = mode === 'create' ? (routeAnchor() || edgeFrom) : null;
  const from = fromId && nodes.find(n => n.id === fromId);
  if (!from || !latlng || from.floor !== currentFloor) {
    if (rubber) { rubber.removeFrom(map); rubber = null; }
    return;
  }
  if (!rubber) {
    rubber = L.polyline([from.latlng, latlng], { color: themeVar('--map-draft'), weight: 2, dashArray: '4,6', interactive: false }).addTo(map);
  } else {
    rubber.setLatLngs([from.latlng, latlng]);
  }
}

// =============================================================================
// Crear: dividir una conexión con un clic
// Inserta un punto de ruta en el lugar del clic y reemplaza A-B por A-P y P-B (conservan
// el tipo escalera). Si hay una ruta o una conexión en curso, además conecta con el punto nuevo.
// =============================================================================
function splitEdgeAt(id, latlng) {
  const e = edges.find(x => x.id === id);
  if (!e) return;
  const fn = nodes.find(n => n.id === e.from), tn = nodes.find(n => n.id === e.to);
  if (!fn || !tn) return;
  if (fn.floor !== tn.floor) { showMapHint(latlng, 'No se puede dividir una conexión entre pisos'); return; }

  // Punto sobre la línea más cercano al clic (en píxeles de pantalla)
  const a = map.latLngToLayerPoint(fn.latlng), b = map.latLngToLayerPoint(tn.latlng);
  const q = L.LineUtil.closestPointOnSegment(map.latLngToLayerPoint(latlng), a, b);
  const at = map.layerPointToLatLng(q);
  // Muy cerca de un extremo: se usa ese nodo en vez de dividir
  const near = [fn, tn].find(n => map.latLngToLayerPoint(n.latlng).distanceTo(q) < 8);
  if (near) { onNodeClick(near.id, { latlng: near.latlng }); return; }

  const from = waypointMode ? routeAnchor() : edgeFrom;
  let wp = null;
  commit(() => {
    removeEdge(id);
    wp = addNodeRaw('waypoint', at, {}, { floor: fn.floor, building: fn.building === tn.building ? fn.building : currentBuilding });
    addEdgeRaw(e.from, wp.id, e.es_escalera);
    addEdgeRaw(wp.id, e.to, e.es_escalera);
    if (from) addEdgeRaw(from, wp.id); // si el ancla era un extremo, esa conexión ya existe y se omite
  });
  if (waypointMode) setRouteAnchor(wp.id);
  else if (edgeFrom) cancelEdge();
  else setStatus('Conexión dividida', 'ok');
}

// =============================================================================
// Crear: dibujo de edificios y zonas
// =============================================================================
// Marcador de vértice reutilizable: arrastrable, sin propagar el clic al mapa,
// con clic derecho o Supr (pasando el mouse) para quitarlo
function makeVertexMarker(latlng, { onDrag, onRemove }) {
  const marker = L.marker(latlng, { draggable: true, keyboard: false, icon: L.divIcon({ className: 'zone-vertex', iconSize: [12, 12] }) }).addTo(map);
  const remove = () => { if (hover?.marker === marker) hover = null; onRemove(marker); };
  marker.on('drag', onDrag);
  marker.on('click', (ev) => L.DomEvent.stopPropagation(ev));
  marker.on('contextmenu', (ev) => {
    L.DomEvent.stopPropagation(ev);
    L.DomEvent.preventDefault(ev.originalEvent);
    remove();
  });
  marker.on('mouseover', () => { hover = { kind: 'vertex', marker, remove }; });
  marker.on('mouseout', () => { if (hover?.marker === marker) hover = null; });
  return marker;
}

function populateBuildingSelect(sel, selected = 'exterior') {
  sel.innerHTML = '';
  const ext = document.createElement('option');
  ext.value = 'exterior';
  ext.textContent = 'Exterior / campus';
  sel.appendChild(ext);
  sortedBuildings().forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.name || 'Edificio';
    sel.appendChild(opt);
  });
  sel.value = selected;
}

function startDrawing(kind, latlng, fields = {}) {
  cancelEdge();
  clearSelection();
  draw = { kind, fields, access: null, accessMarker: null, vertices: [], preview: null };
  document.getElementById('map').classList.add('is-drawing');

  const bar = document.getElementById('draw-bar');
  document.getElementById('draw-title').textContent = kind === 'building' ? 'Nuevo edificio' : 'Nueva zona segura';
  document.getElementById('draw-name').value = fields.name || '';
  const bsel = document.getElementById('draw-building');
  bsel.hidden = kind !== 'zone';
  if (kind === 'zone') populateBuildingSelect(bsel, currentBuilding);
  document.getElementById('draw-hint').textContent = kind === 'building'
    ? 'El primer clic marcó el acceso. Ahora haz clic en las esquinas - Clic derecho o Supr sobre una esquina la quita - Ctrl/Cmd+Z quita la última - Enter guarda - Esc cancela'
    : 'Clic: agregar punto - Clic derecho o Supr sobre un punto lo quita - Ctrl/Cmd+Z quita el último - Enter guarda - Esc cancela';
  bar.hidden = false;

  if (kind === 'building') {
    draw.access = latlng;
    draw.accessMarker = L.marker(latlng, {
      interactive: false,
      icon: L.divIcon({ className: 'graph-node type-building', html: escapeHtml((fields.icon || '').trim() || SYSTEM_TYPES.building.icon), iconSize: [30, 30] }),
    }).addTo(map);
  } else {
    addDrawVertex(latlng);
  }
  syncDraw();
  lastCreated = { kind };
  if (kind === 'zone') setTimeout(() => document.getElementById('draw-name').focus(), 0);
}

function syncDraw() {
  if (!draw) return;
  if (draw.preview) { draw.preview.removeFrom(map); draw.preview = null; }
  const pts = draw.vertices.map(m => m.getLatLng());
  if (pts.length === 2) draw.preview = L.polyline(pts, { color: themeVar('--map-draft'), weight: 2, dashArray: '4,4', interactive: false }).addTo(map);
  else if (pts.length >= 3) draw.preview = L.polygon(pts, { color: themeVar('--map-draft'), weight: 2, dashArray: '4,4', fillOpacity: 0.12, interactive: false }).addTo(map);
  document.getElementById('draw-save').disabled = pts.length < 3;
}

function addDrawVertex(latlng) {
  const marker = makeVertexMarker(latlng, {
    onDrag: syncDraw,
    onRemove: (m) => {
      m.removeFrom(map);
      draw.vertices.splice(draw.vertices.indexOf(m), 1);
      syncDraw();
    },
  });
  draw.vertices.push(marker);
  syncDraw();
}

function removeLastDrawVertex() {
  const m = draw?.vertices.pop();
  if (!m) { setStatus('No hay puntos que quitar', 'ok'); return; }
  m.removeFrom(map);
  syncDraw();
}

function cancelDrawing() {
  if (!draw) return;
  draw.vertices.forEach(m => m.removeFrom(map));
  if (draw.preview) draw.preview.removeFrom(map);
  if (draw.accessMarker) draw.accessMarker.removeFrom(map);
  draw = null;
  hover = null;
  document.getElementById('draw-bar').hidden = true;
  document.getElementById('map').classList.remove('is-drawing');
}

function saveDrawing() {
  if (!draw) return;
  if (draw.vertices.length < 3) {
    const ll = draw.vertices.at(-1)?.getLatLng() || draw.access;
    if (ll) showMapHint(ll, 'Se necesitan al menos 3 puntos');
    return;
  }
  const kind = draw.kind;
  const access = draw.access;
  const fields = draw.fields || {};
  const name = document.getElementById('draw-name').value.trim() || 'Sin nombre';
  const buildingSel = document.getElementById('draw-building').value;
  const pts = draw.vertices.map(m => m.getLatLng());
  const geojson = { type: 'Polygon', coordinates: [[...pts, pts[0]].map(ll => [ll.lng, ll.lat])] };
  cancelDrawing();

  commit(() => {
    if (kind === 'building') {
      const nodeId = crypto.randomUUID();
      createNodeObject({
        id: nodeId, type: 'building', name, icon: (fields.icon || '').trim() || SYSTEM_TYPES.building.icon,
        // El nodo del edificio está en el exterior; el edificio parte con un piso (el 1, que es el acceso)
        lat: access.lat, lng: access.lng, floor: 1, building: 'exterior', pisos: [{ numero: 1, nombre: null }], acceso: 1,
        horario: (fields.horario || '').trim(), descripcion: (fields.descripcion || '').trim(), link_derivacion: (fields.link || '').trim(),
      });
      createZoneObject({ id: crypto.randomUUID(), building: nodeId, name, tags: [ZONE_KINDS.edificio.tag], color: ZONE_KINDS.edificio.color, geojson });
      updateBuildingSelector();
    } else {
      createZoneObject({
        id: crypto.randomUUID(), building: buildingSel === 'exterior' ? null : buildingSel,
        name, tags: [ZONE_KINDS.zonaseg.tag], color: ZONE_KINDS.zonaseg.color, geojson,
      });
    }
  });
}

// =============================================================================
// Modificar: edición de contornos
// =============================================================================
function enableZoneVertexEditing(id) {
  map.closePopup();
  if (draw) cancelDrawing();
  const zone = zones.find(z => z.id === id);
  if (!zone) return;
  pushHistory(); // estado previo: "Terminar" queda deshacible; "Cancelar" lo descarta
  editingZoneId = id;
  editingZoneBackup = JSON.parse(JSON.stringify(zone.geojson.coordinates));
  zone.polygon.setStyle({ weight: 4, color: '#22d07a', dashArray: '5, 5' });
  draw = null;
  editingVertices = zone.geojson.coordinates[0].slice(0, -1).map(([lng, lat]) => makeEditVertexMarker(zone, L.latLng(lat, lng)));
  document.getElementById('vertex-bar').hidden = false;
  document.getElementById('map').classList.add('is-drawing');
}

let editingVertices = [];

function makeEditVertexMarker(zone, latlng) {
  return makeVertexMarker(latlng, {
    onDrag: () => syncEditingZoneFromMarkers(zone),
    onRemove: (m) => {
      if (editingVertices.length <= 3) { showMapHint(m.getLatLng(), 'El contorno necesita al menos 3 puntos'); return; }
      m.removeFrom(map);
      editingVertices.splice(editingVertices.indexOf(m), 1);
      syncEditingZoneFromMarkers(zone);
    },
  });
}

// El anillo del polígono se reconstruye desde los marcadores, en su orden
function syncEditingZoneFromMarkers(zone) {
  const ring = editingVertices.map(m => { const ll = m.getLatLng(); return [ll.lng, ll.lat]; });
  zone.geojson.coordinates[0] = [...ring, ring[0]];
  const leafletCoords = ring.map(([lng, lat]) => [lat, lng]);
  zone.polygon.eachLayer(layer => layer.setLatLngs(leafletCoords));
  markDirty();
}

// Inserta el punto en el lado del polígono más cercano al clic (distancia medida en píxeles de pantalla)
function insertVertexIntoEditingZone(latlng) {
  const zone = zones.find(z => z.id === editingZoneId);
  if (!zone) return;
  const p = map.latLngToLayerPoint(latlng);
  const pts = editingVertices.map(m => map.latLngToLayerPoint(m.getLatLng()));
  let bestIdx = 0, bestDist = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = L.LineUtil.pointToSegmentDistance(p, pts[i], pts[(i + 1) % pts.length]);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  editingVertices.splice(bestIdx + 1, 0, makeEditVertexMarker(zone, latlng));
  syncEditingZoneFromMarkers(zone);
}

function endVertexEditing() {
  editingVertices.forEach(m => m.removeFrom(map));
  editingVertices = [];
  const zone = zones.find(z => z.id === editingZoneId);
  if (zone) zone.polygon.setStyle(zoneStyle(zone, selection?.id === zone.id));
  editingZoneId = null;
  editingZoneBackup = null;
  hover = null;
  document.getElementById('vertex-bar').hidden = true;
  document.getElementById('map').classList.remove('is-drawing');
}

function finishVertexEditing() {
  if (!editingZoneId) return;
  endVertexEditing();
  setStatus('Contorno modificado', 'ok');
}

// Esc o "Cancelar": descarta los cambios y devuelve el contorno a la forma que tenía al empezar
function cancelVertexEditing() {
  if (!editingZoneId) return;
  const zone = zones.find(z => z.id === editingZoneId);
  if (zone && editingZoneBackup) {
    zone.geojson.coordinates = editingZoneBackup;
    const leafletCoords = zone.geojson.coordinates[0].slice(0, -1).map(([lng, lat]) => [lat, lng]);
    zone.polygon.eachLayer(layer => layer.setLatLngs(leafletCoords));
  }
  endVertexEditing();
  undoStack.pop(); // la entrada guardada al empezar ya no corresponde a ningún cambio
  updateHistoryButtons();
  markDirty(); // vuelve a comparar: si el contorno quedó como al cargar, desaparece el aviso
}

// =============================================================================
// Popups: ficha de solo lectura (Ver) y edición (Modificar)
// =============================================================================
function openInfoPopup(type, id, latlng) {
  let title = '';
  const rows = []; // [etiqueta, valor, esHtmlSeguro]

  if (type === 'node') {
    const n = nodes.find(x => x.id === id);
    if (!n) return;
    title = n.name;
    rows.push(['Tipo', NODE_TYPE_LABELS[n.type] || n.type]);
    if (n.type === 'building') {
      rows.push(['Pisos', [...n.pisos].reverse().map(p => floorLabel(p.numero, n.id)).join(', ')]);
      rows.push(['Acceso', floorLabel(n.acceso, n.id)]);
    } else {
      rows.push(['Edificio', buildingName(n.building)]);
      if (n.building !== 'exterior') rows.push(['Piso', floorLabel(n.floor, n.building)]);
    }
    if (isPoiType(n.type) && n.type !== 'building') {
      rows.push(['Horario', n.horario]);
      rows.push(['Descripción', n.descripcion]);
      if (n.link_derivacion) rows.push(['Link', safeLinkHtml(n.link_derivacion), true]);
    }
  } else if (type === 'edge') {
    const e = edges.find(x => x.id === id);
    if (!e) return;
    const fn = nodes.find(x => x.id === e.from), tn = nodes.find(x => x.id === e.to);
    if (!fn || !tn) return;
    title = 'Conexión';
    rows.push(['Desde', `${fn.name} (${floorLabel(fn.floor, fn.building)})`]);
    rows.push(['Hasta', `${tn.name} (${floorLabel(tn.floor, tn.building)})`]);
    rows.push(['Tipo', e.es_escalera ? 'Escalera' : 'Normal']);
    rows.push(['Distancia', `${Math.round(map.distance(fn.latlng, tn.latlng))} m`]);
  } else if (type === 'zone') {
    const z = zones.find(x => x.id === id);
    if (!z) return;
    title = z.name;
    rows.push(['Tipo', z.tags.includes('contorno_edificio') ? 'Contorno de edificio' : 'Zona segura']);
    rows.push(['Edificio', buildingName(z.building)]);
  }

  const body = rows
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v, isHtml]) => `<dt>${escapeHtml(k)}</dt><dd>${isHtml ? v : escapeHtml(v)}</dd>`)
    .join('');
  const html = `
    <div class="pop-info">
      <h6 style="margin-bottom:10px; font-weight:bold; color:var(--naviusm-text-strong);">${escapeHtml(title)}</h6>
      <dl>${body}</dl>
    </div>`;
  L.popup({ className: 'nv-popup', autoPan: false, maxWidth: 280 }).setLatLng(latlng).setContent(html).openOn(map);
}

function popupActions(kind, id) {
  return `
    <div class="pop-actions">
      <button type="button" class="btn btn-sm btn-outline-danger" onclick="deleteElement('${kind}', '${id}')" title="Eliminar (Supr)">Eliminar</button>
      <span class="spacer"></span>
      <button type="button" class="btn btn-sm btn-secondary" onclick="map.closePopup()">Cancelar</button>
      <button type="button" class="btn btn-sm btn-accent" data-primary onclick="save${kind === 'node' ? 'Node' : kind === 'edge' ? 'Edge' : 'Zone'}Edit('${id}')" title="Guardar (Enter)">Guardar</button>
    </div>`;
}

function openEditPopup(type, id, latlng) {
  let html = '';
  if (type === 'node') {
    const n = nodes.find(x => x.id === id);
    const isBld = n.type === 'building';
    const isSrv = isPoiType(n.type);
    const bOptions = sortedBuildings()
      .map(b => `<option value="${escapeHtml(b.id)}" ${b.id === n.building ? 'selected' : ''}>${escapeHtml(b.name)}</option>`).join('');
    // Si el nodo tiene un tipo fuera de la lista (datos antiguos), se agrega para no cambiarlo sin querer
    const types = NODE_TYPES_MENU.includes(n.type) ? NODE_TYPES_MENU : [n.type, ...NODE_TYPES_MENU];
    const typeOptions = types.map(t => `<option value="${escapeHtml(t)}" ${t === n.type ? 'selected' : ''}>${escapeHtml(NODE_TYPE_LABELS[t] || t)}</option>`).join('');

    html = `
      <div class="pop-edit">
        <div class="ctx-title">Editar ${isBld ? 'edificio' : 'nodo'}</div>
        <label>Nombre</label>
        <input type="text" id="pop-name" class="form-control form-control-sm mb-2" value="${escapeHtml(n.name)}">
        ${!isBld ? `
        <label>Tipo</label>
        <select id="pop-type" class="form-select form-select-sm mb-2" data-prev="${escapeHtml(n.type)}" onchange="onPopTypeChange(this)">
          ${typeOptions}
        </select>
        <label>Edificio asignado</label>
        <select id="pop-building" class="form-select form-select-sm mb-2">
          <option value="exterior" ${n.building === 'exterior' ? 'selected' : ''}>Campus (exterior)</option>
          ${bOptions}
        </select>` : ''}
        ${isBld ? `<a class="pop-link" href="${BASE_URL}/admin/edificios?sede=${encodeURIComponent(currentSedeId || '')}&edificio=${encodeURIComponent(n.id)}">Gestionar pisos (${n.pisos.length})</a>` : ''}
        <div id="pop-srv-fields" style="display:${isSrv ? 'block' : 'none'};">
          <label>Ícono en la app</label>
          <input type="text" id="pop-icon" class="form-control form-control-sm mb-2" value="${escapeHtml(isSrv ? n.icon : '')}" maxlength="4">
          <label>Horario</label>
          <input type="text" id="pop-horario" class="form-control form-control-sm mb-2" value="${escapeHtml(n.horario)}">
          <label>Descripción</label>
          <textarea id="pop-desc" class="form-control form-control-sm mb-2" rows="2">${escapeHtml(n.descripcion)}</textarea>
          <label>Link</label>
          <input type="url" id="pop-link" class="form-control form-control-sm mb-2" value="${escapeHtml(n.link_derivacion)}">
        </div>
        ${popupActions('node', id)}
      </div>`;
  } else if (type === 'edge') {
    const e = edges.find(x => x.id === id);
    html = `
      <div class="pop-edit">
        <div class="ctx-title">Editar conexión</div>
        <label class="pop-check">
          <input type="checkbox" id="pop-es-escalera" ${e.es_escalera ? 'checked' : ''} style="width:16px; height:16px;">
          Esta conexión es una escalera
        </label>
        ${popupActions('edge', id)}
      </div>`;
  } else if (type === 'zone') {
    const z = zones.find(x => x.id === id);
    html = `
      <div class="pop-edit">
        <div class="ctx-title">Editar ${z.tags.includes('contorno_edificio') ? 'contorno de edificio' : 'zona'}</div>
        <label>Nombre</label>
        <input type="text" id="pop-zone-name" class="form-control form-control-sm mb-2" value="${escapeHtml(z.name)}">
        <button type="button" class="btn btn-sm btn-outline-secondary w-100" onclick="enableZoneVertexEditing('${id}')">Modificar contorno</button>
        ${popupActions('zone', id)}
      </div>`;
  }
  L.popup({ className: 'nv-popup nv-edit', autoPan: false, maxWidth: 300, minWidth: 240 }).setLatLng(latlng).setContent(html).openOn(map);
}

// Al cambiar el tipo en el popup: mostrar u ocultar los campos de POI y proponer el ícono del nuevo tipo
window.onPopTypeChange = function (sel) {
  document.getElementById('pop-srv-fields').style.display = isPoiType(sel.value) ? 'block' : 'none';
  const iconInp = document.getElementById('pop-icon');
  const prevDefault = SYSTEM_TYPES[sel.dataset.prev]?.icon;
  // Solo se reemplaza si estaba vacío o era el ícono por defecto del tipo anterior (respeta íconos personalizados)
  if (!iconInp.value.trim() || iconInp.value === prevDefault) iconInp.value = SYSTEM_TYPES[sel.value]?.icon || '';
  sel.dataset.prev = sel.value;
};

function setNodeType(n, newType) {
  const sys = SYSTEM_TYPES[newType] || SYSTEM_TYPES.waypoint;
  n.type = newType;
  n.el.className = `graph-node type-${newType}`;
  n.el.style.width = sys.size + 'px';
  n.el.style.height = sys.size + 'px';
  // Cambia el tamaño del ícono; Leaflet recrea el elemento y conserva el estado de arrastre
  n.marker.setIcon(L.divIcon({ html: n.el, iconSize: [sys.size, sys.size], className: '' }));
}

window.saveNodeEdit = async function (id) {
  const n = nodes.find(x => x.id === id);
  const val = (elId) => document.getElementById(elId)?.value;
  // Leer el formulario antes de cualquier diálogo
  const form = {
    type: val('pop-type') || n.type,
    name: val('pop-name'),
    building: val('pop-building'),
    icon: (val('pop-icon') || '').trim(),
    horario: val('pop-horario'),
    descripcion: val('pop-desc'),
    link: val('pop-link'),
  };
  const isPoi = isPoiType(form.type);

  if (!isPoi && n.type !== form.type && (n.horario || n.descripcion || n.link_derivacion)) {
    const ok = await window.uiConfirm(
      "Al convertirlo en punto de ruta se descartarán el horario, la descripción y el link.\n¿Continuar?",
      "Cambiar tipo de nodo");
    if (!ok) return;
  }

  commit(() => {
    n.name = form.name;
    if (n.type !== 'building' && form.building !== undefined && form.building !== n.building) {
      n.building = form.building;
      // Si el piso no existe en el lugar nuevo, pasa al piso de acceso (o al exterior)
      const floors = floorsOf(n.building);
      if (!floors.includes(n.floor)) {
        n.floor = n.building === 'exterior' ? 1 : nodes.find(b => b.id === n.building).acceso;
        setTimeout(() => setStatus(`El nodo pasó a ${floorLabel(n.floor, n.building)}`, 'ok'), 0);
      }
    }
    if (form.type !== n.type) setNodeType(n, form.type);
    if (isPoi) {
      n.icon = form.icon || SYSTEM_TYPES[n.type]?.icon || '';
      n.horario = form.horario;
      n.descripcion = form.descripcion;
      n.link_derivacion = form.link;
    } else {
      n.icon = SYSTEM_TYPES.waypoint.icon;
      delete n.horario; delete n.descripcion; delete n.link_derivacion;
    }
    n.el.textContent = n.icon;
    setNodeTooltip(n.marker, n.name);
    if (n.type === 'building') {
      const z = zones.find(z => z.building === id && z.tags.includes('contorno_edificio'));
      if (z) z.name = n.name;
      updateBuildingSelector();
    }
  });
  map.closePopup();
};

window.saveEdgeEdit = function (id) {
  const e = edges.find(x => x.id === id);
  const esEscalera = document.getElementById('pop-es-escalera').checked;
  commit(() => {
    e.es_escalera = esEscalera;
    e.line.setStyle({ color: edgeColor(e) });
  });
  map.closePopup();
};

window.saveZoneEdit = function (id) {
  const z = zones.find(x => x.id === id);
  const name = document.getElementById('pop-zone-name').value;
  commit(() => {
    z.name = name;
    if (z.building && z.tags.includes('contorno_edificio')) {
      const n = nodes.find(n => n.id === z.building);
      if (n) { n.name = z.name; setNodeTooltip(n.marker, n.name); }
      updateBuildingSelector();
    }
  });
  map.closePopup();
};

// =============================================================================
// Edificio y piso visibles
// =============================================================================
function updateBuildingSelector() {
  const sel = document.getElementById('building-selector');
  sel.innerHTML = '';
  const ext = document.createElement('option');
  ext.value = 'exterior';
  ext.textContent = 'Campus (exterior)';
  sel.appendChild(ext);
  const blds = sortedBuildings();
  blds.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.name || 'Edificio';
    sel.appendChild(opt);
  });
  if (currentBuilding !== 'exterior' && !blds.find(b => b.id === currentBuilding)) currentBuilding = 'exterior';
  sel.value = currentBuilding;
  updateFloorSelector();
}

function changeBuilding() {
  currentBuilding = document.getElementById('building-selector').value;
  updateFloorSelector();
  changeFloor();
}

// Pisos reales del edificio, de arriba hacia abajo; en el exterior, solo "Exterior"
function updateFloorSelector() {
  const floorSel = document.getElementById('floor-selector');
  floorSel.innerHTML = '';
  const b = currentBuilding !== 'exterior' ? nodes.find(n => n.id === currentBuilding) : null;
  const numeros = b ? b.pisos.map(p => p.numero).reverse() : [1];
  numeros.forEach(numero => {
    const opt = document.createElement('option');
    opt.value = numero;
    opt.textContent = floorLabel(numero, currentBuilding);
    floorSel.appendChild(opt);
  });
  if (!numeros.includes(currentFloor)) currentFloor = b ? b.acceso : 1;
  floorSel.value = currentFloor;
  floorSel.disabled = !b;
  const link = document.getElementById('manage-floors');
  link.hidden = !b;
  if (b) link.href = `${BASE_URL}/admin/edificios?sede=${encodeURIComponent(currentSedeId || '')}&edificio=${encodeURIComponent(b.id)}`;
}

function changeFloor() {
  const floorVal = document.getElementById('floor-selector').value;
  currentFloor = floorVal ? parseInt(floorVal, 10) : 1;
  cancelEdge();
  endRoute();
  renderMapNodes();
}

function renderMapNodes() {
  nodes.forEach(n => {
    if (n.floor === currentFloor) n.marker.addTo(map);
    else n.marker.removeFrom(map);
  });
  edges.forEach(e => {
    const fn = nodes.find(x => x.id === e.from);
    const tn = nodes.find(x => x.id === e.to);
    if (fn && tn && (fn.floor === currentFloor || tn.floor === currentFloor)) {
      e.line.addTo(map);
      e.line.setStyle({
        color: edgeColor(e),
        dashArray: fn.floor !== tn.floor ? '5, 10' : null,
        weight: selection?.kind === 'edge' && selection.id === e.id ? 6 : 3,
      });
    } else {
      e.line.removeFrom(map);
    }
  });
  // Solo los nodos del lugar visible: este edificio y piso (o el exterior)
  document.getElementById('st-nodes').textContent = nodes.filter(n => n.floor === currentFloor && (n.building || 'exterior') === currentBuilding).length;
}

// =============================================================================
// Ubicar elementos (búsqueda y revisión): cambia a su edificio y piso, centra y resalta
// =============================================================================
function locateNodes(ids, { open = false } = {}) {
  const list = ids.map(id => nodes.find(n => n.id === id)).filter(Boolean);
  if (!list.length) return;
  const first = list[0];
  if (map) map.closePopup();
  cancelEdge();
  endRoute();
  currentBuilding = first.type === 'building' ? 'exterior' : (first.building || 'exterior');
  currentFloor = first.floor;
  updateBuildingSelector();
  renderMapNodes();

  const sameFloor = list.filter(n => n.floor === first.floor);
  if (sameFloor.length > 1) {
    map.fitBounds(L.latLngBounds(sameFloor.map(n => n.latlng)), { padding: [80, 80], maxZoom: 20, animate: false });
  } else {
    map.setView(first.latlng, Math.max(map.getZoom(), 19), { animate: false });
  }
  sameFloor.forEach(flashNode);

  if (!open) return;
  if (mode === 'view') openInfoPopup('node', first.id, first.latlng);
  else if (mode === 'modify') { select('node', first.id); openEditPopup('node', first.id, first.latlng); }
}

function flashNode(n) {
  n.el.classList.remove('is-found');
  void n.el.offsetWidth; // reinicia la animación si ya estaba
  n.el.classList.add('is-found');
  setTimeout(() => n.el.classList.remove('is-found'), 1800);
}

// =============================================================================
// Búsqueda de nodos y edificios (/ o Ctrl/Cmd+F)
// =============================================================================
function initSearch() {
  const input = document.getElementById('map-search');
  input.addEventListener('input', runSearch);
  input.addEventListener('focus', runSearch);
  input.addEventListener('blur', () => setTimeout(hideSearchResults, 150));
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!searchResults.length) return;
      const step = ev.key === 'ArrowDown' ? 1 : -1;
      searchIndex = (searchIndex + step + searchResults.length) % searchResults.length;
      renderSearchResults();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const pick = searchResults[Math.max(0, searchIndex)];
      if (pick) chooseSearchResult(pick);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      input.value = '';
      hideSearchResults();
      input.blur();
    }
  });
}

function focusSearch() {
  const input = document.getElementById('map-search');
  input.focus();
  input.select();
}

function runSearch() {
  const q = normalizeText(document.getElementById('map-search').value);
  if (!q) { hideSearchResults(); return; }
  const scored = [];
  nodes.forEach(n => {
    if (n.type === 'waypoint') return;
    const name = normalizeText(n.name);
    const pos = name.indexOf(q);
    if (pos === -1) return;
    scored.push({ n, score: pos === 0 ? 0 : (name.includes(' ' + q) ? 1 : 2) });
  });
  scored.sort((a, b) => a.score - b.score || a.n.name.localeCompare(b.n.name, 'es'));
  searchResults = scored.slice(0, 8).map(x => x.n);
  searchIndex = searchResults.length ? 0 : -1;
  renderSearchResults();
}

function renderSearchResults() {
  const box = document.getElementById('search-results');
  box.innerHTML = '';
  if (!searchResults.length) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = 'Sin resultados';
    box.appendChild(empty);
  }
  searchResults.forEach((n, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'search-item' + (i === searchIndex ? ' active' : '');
    b.setAttribute('role', 'option');
    const title = document.createElement('span');
    title.textContent = n.name || 'Sin nombre';
    const meta = document.createElement('small');
    meta.textContent = n.type === 'building'
      ? 'Edificio'
      : `${NODE_TYPE_LABELS[n.type] || n.type} - ${buildingName(n.building)}${n.building === 'exterior' ? '' : ' - ' + floorLabel(n.floor, n.building)}`;
    b.append(title, meta);
    // mousedown: ocurre antes del blur del campo, que esconde la lista
    b.addEventListener('mousedown', (ev) => { ev.preventDefault(); chooseSearchResult(n); });
    box.appendChild(b);
  });
  box.hidden = false;
}

function hideSearchResults() {
  document.getElementById('search-results').hidden = true;
}

function chooseSearchResult(n) {
  const input = document.getElementById('map-search');
  hideSearchResults();
  input.blur();
  locateNodes([n.id], { open: true });
}

// =============================================================================
// Revisión antes de publicar (R): avisos que conviene corregir, con clic para ubicarlos
// =============================================================================
function collectIssues() {
  const degree = new Map(nodes.map(n => [n.id, 0]));
  edges.forEach(e => { degree.set(e.from, (degree.get(e.from) || 0) + 1); degree.set(e.to, (degree.get(e.to) || 0) + 1); });

  const isolated = nodes.filter(n => degree.get(n.id) === 0);

  // Componentes conexas entre los nodos que tienen alguna conexión (unión-búsqueda)
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  nodes.forEach(n => { if (degree.get(n.id) > 0) parent.set(n.id, n.id); });
  edges.forEach(e => { if (parent.has(e.from) && parent.has(e.to)) parent.set(find(e.from), find(e.to)); });
  const groups = new Map();
  parent.forEach((_, id) => { const r = find(id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(id); });
  const components = [...groups.values()].sort((a, b) => b.length - a.length).slice(1); // la mayor es la red principal

  const unnamed = nodes.filter(n => isPoiType(n.type) && hasAutoName(n));
  return { isolated, components, unnamed, total: isolated.length + components.length + unnamed.length };
}

function openReview() {
  reviewOpen = true;
  document.getElementById('review-panel').hidden = false;
  setToggle('btn-review', true);
  renderReview();
}

function closeReview() {
  reviewOpen = false;
  document.getElementById('review-panel').hidden = true;
  setToggle('btn-review', false);
}

function renderReview() {
  const issues = collectIssues();
  const body = document.getElementById('review-body');
  body.innerHTML = '';
  document.getElementById('review-summary').textContent = issues.total
    ? `${issues.total} ${issues.total === 1 ? 'aviso' : 'avisos'}. Haz clic en uno para ubicarlo.`
    : 'Sin avisos. El mapa está listo para publicar.';
  document.getElementById('review-publish').textContent = issues.total ? 'Publicar de todos modos' : 'Publicar';

  const placeLabel = (n) => n.type === 'building' ? 'Edificio'
    : (n.building === 'exterior' ? 'Exterior' : `${buildingName(n.building)}, ${floorLabel(n.floor, n.building)}`);
  const nodeLabel = (n) => `${n.name || 'Sin nombre'} - ${placeLabel(n)}`;
  const section = (title, help, items) => {
    if (!items.length) return;
    const h = document.createElement('div');
    h.className = 'review-title';
    h.textContent = `${title} (${items.length})`;
    const p = document.createElement('div');
    p.className = 'review-help';
    p.textContent = help;
    body.append(h, p);
    items.forEach(({ label, ids }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'review-item';
      b.textContent = label;
      b.addEventListener('click', () => locateNodes(ids));
      body.appendChild(b);
    });
  };
  section('Sin conexiones', 'La app no puede llegar a estos puntos.',
    issues.isolated.map(n => ({ label: nodeLabel(n), ids: [n.id] })));
  section('Grupos desconectados', 'Redes separadas de la principal: desde ellas no se llega al resto.',
    issues.components.map(ids => {
      const named = ids.map(id => nodes.find(n => n.id === id)).find(n => n && n.type !== 'waypoint');
      return { label: `Grupo de ${ids.length} puntos${named ? ` (incluye ${named.name})` : ''}`, ids };
    }));
  section('Sin nombre', 'En la app se mostrarían con un nombre automático.',
    issues.unnamed.map(n => ({ label: `${NODE_TYPE_LABELS[n.type] || n.type} - ${placeLabel(n)}`, ids: [n.id] })));
}

// =============================================================================
// Ayudas junto al cursor (H)
// =============================================================================
function onMapMouseMove(e) {
  updateRubber(e.latlng);
  if (!hintsOn) return;
  const overPopup = e.originalEvent?.target?.closest?.('.leaflet-popup');
  const text = overPopup ? null : cursorHintText();
  const el = document.getElementById('cursor-hint');
  if (!text) { el.hidden = true; return; }
  el.textContent = text;
  el.hidden = false;
  const size = map.getSize();
  const x = e.containerPoint.x, y = e.containerPoint.y;
  // A la derecha y abajo del cursor; cerca de los bordes, al otro lado
  const left = x + 16 + el.offsetWidth > size.x ? x - 12 - el.offsetWidth : x + 16;
  const top = y + 20 + el.offsetHeight > size.y ? y - 12 - el.offsetHeight : y + 20;
  el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function hideCursorHint() {
  document.getElementById('cursor-hint').hidden = true;
  updateRubber(null);
}

function cursorHintText() {
  const h = hover;
  const vertexHint = 'Arrastrar: mover - Clic derecho o Supr: quitar';
  if (editingZoneId) return h?.kind === 'vertex' ? vertexHint : 'Clic: agregar punto al contorno';
  if (draw) {
    if (h?.kind === 'vertex') return vertexHint;
    return draw.vertices.length >= 3 ? 'Clic: agregar esquina - Enter: guardar' : 'Clic: agregar esquina';
  }
  if (mode === 'view') return h ? 'Clic: ver detalles' : null;
  if (mode === 'modify') {
    if (!h) return null;
    return h.kind === 'node' ? 'Clic: editar - Arrastrar: mover - Supr: eliminar' : 'Clic: editar - Supr: eliminar';
  }
  // Crear
  const del = ' - Clic derecho: eliminar';
  if (waypointMode) {
    if (h?.kind === 'node') return (route ? 'Clic: conectar y seguir' : 'Clic: empezar ruta aquí') + del;
    if (h?.kind === 'edge') return (route ? 'Clic: dividir y conectar' : 'Clic: dividir conexión') + del;
    return route ? 'Clic: siguiente punto - Enter o Esc: terminar' : 'Clic: primer punto de la ruta';
  }
  if (edgeFrom) {
    if (h?.kind === 'node') return 'Clic: conectar';
    if (h?.kind === 'edge') return 'Clic: dividir y conectar';
    return 'Clic en un nodo: conectar - Esc: cancelar';
  }
  if (h?.kind === 'node') return 'Clic: conectar con otro nodo' + del;
  if (h?.kind === 'edge') return 'Clic: dividir conexión' + del;
  return lastCreated ? 'Clic: crear - Shift + clic: repetir' : 'Clic: crear';
}

// =============================================================================
// Carga y publicación
// =============================================================================
// Cambio de sede desde el selector: pedir confirmación si hay cambios sin publicar
async function onSedeChange() {
  const sel = document.getElementById('sede-selector');
  if (hasUnsavedChanges) {
    const proceed = await window.uiConfirm(
      "Tienes cambios sin publicar en esta sede. Si cambias de sede se perderán.\n¿Continuar de todos modos?",
      "Cambios sin publicar");
    if (!proceed) { sel.value = currentSedeId; return; }
    clearDraft(currentSedeId); // aceptó perder los cambios: no se ofrecerán al volver
  }
  loadFromServer();
}

async function loadFromServer() {
  setMode('view', { force: true }); // al cargar o cambiar de sede siempre se parte en modo Ver
  const sedeId = document.getElementById('sede-selector')?.value;
  if (!sedeId) return;
  clearTimeout(draftTimer);
  currentSedeId = sedeId;
  setStatus('Cargando...', 'warn', { sticky: true });
  centrarMapaEnSede();

  try {
    const res = await fetch(BASE_URL + `/admin/api/sedes/${sedeId}/snapshot`);
    snapshotVersion = res.headers.has('X-Snapshot-Version') ? parseInt(res.headers.get('X-Snapshot-Version'), 10) : null;
    if (res.status === 404) {
      hardClearMap();
      markClean();
      setStatus('Mapa nuevo', 'ok', { base: true });
      await offerDraftRecovery(sedeId);
      return;
    }
    if (!res.ok) throw new Error();
    loadGraph(await res.json());
    markClean();
    setStatus('Grafo cargado', 'ok', { base: true });
    await offerDraftRecovery(sedeId);
  } catch (err) {
    console.error(err);
    setStatus('Error cargando el mapa', 'err', { base: true });
  }
}

function hardClearMap() {
  map.closePopup();
  if (draw) cancelDrawing();
  closeReview();
  clearLayers();
  resetHistory();
  originalNodes = new Set();
  originalBuildings = new Set();
  currentBuilding = 'exterior';
  updateBuildingSelector();
  renderMapNodes();
}

// Convierte el snapshot publicado al estado del editor (con las correcciones de datos antiguos)
function loadGraph(data) {
  map.closePopup();
  closeReview();
  clearLayers();
  resetHistory();
  lastCreated = null;

  const isUUID = (str) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
  const idMap = {};
  const seenCoords = new Set();
  const rawNodes = (data.nodes || []).filter(n => {
    // Descarta nodos duplicados exactos (misma posición, piso y tipo)
    const key = `${n.lat.toFixed(6)},${n.lng.toFixed(6)},${n.floor},${n.type}`;
    if (seenCoords.has(key)) return false;
    seenCoords.add(key);
    return true;
  });

  originalNodes = new Set(rawNodes.filter(n => isPoiType(n.type) && n.type !== 'building').map(n => n.id));
  originalBuildings = new Set((data.buildings || []).filter(b => b.id !== 'exterior').map(b => b.id));

  const buildings = (data.buildings || []).map(b => {
    if (b.id !== 'exterior' && !isUUID(b.id)) { const newId = crypto.randomUUID(); idMap[b.id] = newId; return { ...b, id: newId }; }
    return b;
  });
  const stateNodes = rawNodes.map(n => {
    let id = n.id;
    if (!isUUID(id)) { id = crypto.randomUUID(); idMap[n.id] = id; }
    const bData = n.type === 'building' ? buildings.find(b => b.id === (idMap[n.id] || n.id)) : null;
    return {
      ...n, id,
      building: n.building && idMap[n.building] ? idMap[n.building] : (n.building || 'exterior'),
      floor: parseInt(n.floor, 10) || 1,
      ...(bData ? pisosFromData(bData) : {}),
    };
  });
  const stateEdges = (data.edges || []).map(e => ({
    ...e,
    id: isUUID(e.id) ? e.id : crypto.randomUUID(),
    from: idMap[e.from] || e.from,
    to: idMap[e.to] || e.to,
  }));
  const stateZones = (data.zonas || []).map(z => ({ id: z.id, building: z.building, name: z.name, tags: z.tags || [], color: z.color, geojson: z.geojson }));

  currentBuilding = 'exterior';
  buildFromState({ nodes: stateNodes, edges: stateEdges, zones: stateZones });
  updateBuildingSelector();
  renderMapNodes();
}

// Si hay avisos, primero se muestra la revisión; "Publicar de todos modos" llama con skipReview
async function publishToServer({ skipReview = false } = {}) {
  if (publishing) return;
  const sedeId = document.getElementById('sede-selector')?.value;
  if (!sedeId) return;
  if (editingZoneId) finishVertexEditing();
  if (draw) { setStatus('Guarda o cancela el dibujo antes de publicar', 'warn'); return; }
  endRoute();
  if (!skipReview && collectIssues().total > 0) {
    openReview();
    setStatus('Revisa los avisos antes de publicar', 'warn');
    return;
  }
  closeReview();
  publishing = true;
  try {

    const currentNodes = new Set(nodes.filter(n => isPoiType(n.type) && n.type !== 'building').map(n => n.id));
    const currentBuildings = new Set(nodes.filter(n => n.type === 'building').map(n => n.id));
    let nodosNuevos = 0, nodosEliminados = 0, edificiosNuevos = 0, edificiosEliminados = 0;
    currentNodes.forEach(id => { if (!originalNodes.has(id)) nodosNuevos++; });
    originalNodes.forEach(id => { if (!currentNodes.has(id)) nodosEliminados++; });
    currentBuildings.forEach(id => { if (!originalBuildings.has(id)) edificiosNuevos++; });
    originalBuildings.forEach(id => { if (!currentBuildings.has(id)) edificiosEliminados++; });

    const promptMsg = `Has realizado los siguientes cambios (excluyendo puntos de ruta/aristas):\n- Nodos (POIs) nuevos: ${nodosNuevos}\n- Nodos (POIs) eliminados: ${nodosEliminados}\n- Edificios nuevos: ${edificiosNuevos}\n- Edificios eliminados: ${edificiosEliminados}\n\n¿Estás seguro de publicar el mapa?`;
    if (!(await window.uiConfirm(promptMsg, "Publicar mapa"))) return;

    setStatus('Publicando...', 'warn', { sticky: true });
    const payload = {
      meta: { campus: sedeId, version: '2.2' },
      buildings: nodes.filter(n => n.type === 'building').map(n => ({ id: n.id, name: n.name, acceso: n.acceso, pisos: n.pisos.map(p => ({ ...p })) })),
      nodes: nodes.map(n => ({
        id: n.id, type: n.type, name: n.name, icon: n.icon, lat: n.latlng.lat, lng: n.latlng.lng, floor: parseInt(n.floor, 10), building: n.building,
        ...(isPoiType(n.type) ? { horario: n.horario, descripcion: n.descripcion, link_derivacion: n.link_derivacion } : {})
      })),
      edges: edges.map(e => ({ id: e.id, from: e.from, to: e.to, weight: e.weight, es_escalera: e.es_escalera || false })),
      zonas: zones.map(z => ({ id: z.id, building: z.building, name: z.name, geojson: z.geojson, tags: z.tags, color: z.color })),
    };

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (snapshotVersion !== null) headers['X-Base-Version'] = String(snapshotVersion);
      const res = await fetch(BASE_URL + `/admin/api/sedes/${sedeId}/publish`, { method: 'POST', headers, body: JSON.stringify(payload) });
      if (res.status === 409 || res.status === 422) {
        const detail = (await res.json().catch(() => ({}))).detail || '';
        setStatus(res.status === 409 ? 'El mapa cambió: no se publicó' : 'Datos inválidos: no se publicó', 'err');
        await window.uiAlert(res.status === 409
          ? `${detail}.\nTus cambios siguen guardados en este navegador. Recarga la sede para ver la versión actual; al abrirla podrás recuperar tus cambios desde el borrador (reemplazarán a los publicados).`
          : `${detail}.`, 'No se publicó');
        return;
      }
      if (!res.ok) throw new Error();
      snapshotVersion = (await res.json()).version;
      markClean();
      clearDraft(sedeId);
      originalNodes = new Set(currentNodes);
      originalBuildings = new Set(currentBuildings);
      baseStatus = { msg: 'Grafo cargado', state: 'ok' }; // tras publicar, un "Mapa nuevo" ya tiene grafo
      setStatus('Mapa guardado', 'ok');
      await window.uiAlert("El mapa ha sido publicado exitosamente.", "Éxito");
    } catch (err) {
      setStatus('Error al publicar', 'err');
      await window.uiAlert("Hubo un error al publicar el mapa.", "Error");
    }
  } finally {
    publishing = false;
  }
}
