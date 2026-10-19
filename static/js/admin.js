// =============================================================================
// Editor de mapa (NaviUSM Studio)
// Modos: Ver (consultar), Crear (menú contextual en el punto del clic) y Modificar
// (seleccionar, mover y editar). Todo cambio pasa por commit(), que guarda el
// estado anterior para deshacer/rehacer. Además: trazado continuo de rutas,
// división de conexiones, búsqueda, revisión antes de publicar, borrador local
// y ayudas junto al cursor.
//
// Dos alcances con el mismo código:
//   campus   (Dibujar Mapa): caminos exteriores, edificios (contorno y nodo) y zonas.
//   building (Editor de edificio): el interior de un edificio, piso por piso, con el mapa
//            limitado a su área, conectores verticales y el exterior visible en el acceso.
// Ambos cargan y publican el mapa completo de la sede.
// =============================================================================

// ── Configuración ──
const BASE_URL = NV.site().rootPath;
const SEDES_INFO = NV.page().sedesInfo;
const SCOPE = NV.page().scope === 'building' ? 'building' : 'campus';
const IS_BUILDING = SCOPE === 'building';
const CONNECTOR_TYPES = { escalera: 'Escalera', ascensor: 'Ascensor', rampa: 'Rampa' };
const CONNECTOR_LETTER = { escalera: 'E', ascensor: 'A', rampa: 'R' };

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
let connectors = [];             // conectores verticales: { id, tipo, nombre, building } (sus paradas son nodos)
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
const DRAFT_VERSION = 2;        // v2 guarda también la base (el mapa publicado sobre el que se hicieron los cambios)
let mergeSession = null;        // combinación en curso tras un 409: conflictos por resolver
let placement = null;           // colocación guiada de las paradas de un conector
let pendingLocate = null;       // nodo a ubicar al terminar de cargar (?nodo=...)

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
// Un borrador por sede y por editor: el del campus y el del editor de edificios no se pisan
function draftKey(sedeId) {
  return IS_BUILDING ? `naviusm-draft:${sedeId}:edificios` : `naviusm-draft:${sedeId}`;
}

// La clave y el contenido se fijan al programar el guardado, por si cambia la sede antes de escribir
// El borrador guarda los cambios y la base sobre la que se hicieron, para poder combinarlos después
// con lo que otros publiquen. Durante una combinación no se toca: conserva "lo mío" original.
function scheduleDraftSave(json) {
  clearTimeout(draftTimer);
  if (mergeSession) return;
  const sedeId = currentSedeId, dirty = hasUnsavedChanges, base = cleanState || 'null', baseVersion = snapshotVersion ?? 'null';
  if (!sedeId) return;
  draftTimer = setTimeout(() => {
    try {
      if (!dirty) { localStorage.removeItem(draftKey(sedeId)); return; }
      localStorage.setItem(draftKey(sedeId),
        `{"v":${DRAFT_VERSION},"savedAt":${Date.now()},"baseVersion":${baseVersion},"base":${base},"state":${json}}`);
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
  if (!draft || ![1, 2].includes(draft.v) || !draft.state) return;
  const draftState = canonState(draft.state);
  if (JSON.stringify(draftState) === cleanState) { clearDraft(sedeId); return; }

  const when = new Date(draft.savedAt).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' });
  // v2 con base: si después se publicó otra versión, los cambios se combinan con ella en vez de reemplazarla
  const canMerge = draft.v === 2 && draft.base;
  const changed = canMerge ? draft.baseVersion !== snapshotVersion : draft.base !== hashText(cleanState || '');
  const msg = `Hay cambios sin publicar de esta sede guardados en este navegador (${when}).`
    + (changed && canMerge ? '\nEl mapa se publicó de nuevo después de ese borrador: tus cambios se combinarán con la versión actual.' : '')
    + (changed && !canMerge ? '\nEl mapa publicado cambió después de ese borrador: si lo recuperas y publicas, reemplazará lo publicado.' : '')
    + '\n¿Recuperarlos? Si eliges Cancelar, el borrador se descarta.';
  if (!(await window.uiConfirm(msg, 'Recuperar cambios'))) { clearDraft(sedeId); return; }
  if (currentSedeId !== sedeId) return; // se cambió de sede mientras estaba abierto el diálogo

  if (changed && canMerge) {
    const result = startMerge(canonState(draft.base), draftState, JSON.parse(cleanState), snapshotVersion, { keepHistory: true });
    if (result === 'merged') setStatus('Cambios recuperados y combinados con la versión publicada', 'ok');
    return;
  }
  pushHistory(); // deshacer vuelve al mapa publicado
  restoreState(draftState);
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
  // En el editor de edificio, maxBoundsViscosity 1: el borde del área es firme (no se arrastra afuera)
  // Zoom máximo según el mapa base (vectorial: 24, nítido; raster: 22)
  const maxZoom = NV.mapMaxZoom();
  map = L.map('map', { zoomControl: false, maxZoom, maxBoundsViscosity: IS_BUILDING ? 1.0 : 0, renderer: L.canvas({ tolerance: 8 }) });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  NV.baseLayer(map);

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

  // ?sede=...&edificio=...&nodo=... (enlaces entre el campus, el editor de edificio y Gestión de Edificios)
  const params = new URLSearchParams(location.search);
  const sel = document.getElementById('sede-selector');
  if (!IS_BUILDING && params.get('sede') && SEDES_INFO.some(x => x.id === params.get('sede'))) sel.value = params.get('sede');
  if (IS_BUILDING) currentBuilding = params.get('edificio') || NV.page().initialBuilding || null;
  pendingLocate = params.get('nodo');

  centrarMapaEnSede();
  loadFromServer();
});

function centrarMapaEnSede() {
  if (IS_BUILDING && currentBuildingNode()) { applyBuildingLock(); return; }
  const info = currentSedeInfo();
  if (!info) return;
  if (!IS_BUILDING) { applyCampusLock(info); return; }
  map.setView([info.lat, info.lng], info.zoom);
}

function currentSedeInfo() {
  const sedeId = document.getElementById('sede-selector')?.value;
  return SEDES_INFO.find(s => s.id === sedeId) || null;
}

// Contorno de la sede (opcional, se define en Gestión de Sedes): [[lng, lat], ...] o null
function sedeRing() {
  return currentSedeInfo()?.contorno || null;
}

// Campus con contorno: el mapa queda limitado a esa área (con margen) y se dibuja el borde.
// Sin contorno, el mapa es libre como antes.
let sedeOutline = null;
function applyCampusLock(info) {
  const ring = info.contorno;
  if (sedeOutline) { sedeOutline.remove(); sedeOutline = null; }
  map.setMaxBounds(null);
  map.setMinZoom(0);
  map.options.maxBoundsViscosity = 0;
  map.setView([info.lat, info.lng], info.zoom, { animate: false });
  if (!ring) return;
  const latlngs = ring.map(([lng, lat]) => [lat, lng]);
  sedeOutline = L.polygon(latlngs, {
    color: themeVar('--naviusm-accent'), weight: 2, dashArray: '8,6', fill: false, interactive: false,
  }).addTo(map);
  const bounds = sedeOutline.getBounds();
  const fitZoom = map.getBoundsZoom(bounds, false, L.point(60, 60));
  map.setMinZoom(Math.max(fitZoom - 1, 0));
  map.options.maxBoundsViscosity = 1.0;
  map.setMaxBounds(bounds.pad(0.25));
}

function outsideScopeMsg() {
  return IS_BUILDING ? 'Fuera del edificio' : 'Fuera del contorno de la sede';
}

// =============================================================================
// Modos y opciones de creación
// =============================================================================
function setMode(m, { force = false } = {}) {
  if (m === mode && !force) return;
  if (mergeSession && m !== 'view') { setStatus('Primero resuelve los cambios combinados', 'warn'); return; }
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
  nodes.forEach(n => setMarkerDraggable(n.marker, mode === 'modify' && !n.ctx));
}

// =============================================================================
// Teclado
// =============================================================================
function onKeyDown(ev) {
  const openModal = document.querySelector('.modal.show');
  if (openModal) {
    // En la ventana de pisos, deshacer/rehacer actúa sobre la ventana (salvo mientras se escribe en un campo de texto)
    const k = (ev.key || '').toLowerCase(), mod = ev.ctrlKey || ev.metaKey;
    const typing = ev.target.tagName === 'INPUT' && ev.target.type === 'text';
    if (openModal.id === 'floorsModal' && mod && !ev.altKey && !typing && (k === 'z' || k === 'y')) {
      ev.preventDefault();
      floorsModalUndo(k === 'y' || ev.shiftKey);
    }
    return; // diálogo o ayuda abiertos
  }
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
  if (IS_BUILDING && (key === 'PageUp' || key === 'PageDown')) { ev.preventDefault(); stepFloor(key === 'PageUp' ? 1 : -1); return; }
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
    g: () => { if (IS_BUILDING) openFloorsModal(); },
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
  if (placement) { cancelConnectorPlacement(); return; }
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
// Forma canónica de cada elemento: siempre las mismas claves, en el mismo orden y con los mismos valores
// por defecto. Así dos copias del mismo elemento se comparan como texto (deshacer, cambios, combinación).
function canonNode(d) {
  const sys = SYSTEM_TYPES[d.type] || SYSTEM_TYPES.waypoint;
  const c = {
    id: d.id, type: d.type, name: d.name ?? '', icon: d.icon || sys.icon,
    lat: Number(d.lat), lng: Number(d.lng), floor: parseInt(d.floor, 10) || 1, building: d.building || 'exterior',
  };
  if (d.type === 'building') Object.assign(c, pisosFromData(d));
  if (isPoiType(d.type)) {
    c.horario = d.horario || '';
    c.descripcion = d.descripcion || '';
    c.link_derivacion = d.link_derivacion || '';
  }
  if (d.conector_id) c.conector_id = d.conector_id;
  return c;
}

function canonConnector(d) {
  return { id: d.id, tipo: d.tipo, nombre: (d.nombre || '').trim() || null, building: d.building };
}

function canonEdge(d) {
  return { id: d.id, from: d.from, to: d.to, weight: Number(d.weight), es_escalera: !!d.es_escalera };
}

function canonZone(d) {
  return {
    id: d.id, building: d.building || null, name: d.name ?? '', tags: [...(d.tags || [])],
    color: d.color ?? null, geojson: JSON.parse(JSON.stringify(d.geojson)),
  };
}

function canonState(st) {
  return {
    nodes: st.nodes.map(canonNode), edges: st.edges.map(canonEdge), zones: st.zones.map(canonZone),
    connectors: (st.connectors || []).map(canonConnector),
  };
}

function serializeState() {
  return {
    nodes: nodes.map(n => canonNode({ ...n, lat: n.latlng.lat, lng: n.latlng.lng })),
    edges: edges.map(canonEdge),
    zones: zones.map(canonZone),
    connectors: connectors.map(canonConnector),
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
  syncConnectors();
  syncAnchors();
  markDirty();
  renderMapNodes();
}

function undo() {
  if (mergeSession) { setStatus('Primero resuelve los cambios combinados', 'warn'); return; }
  if (editingZoneId) { setStatus('Termina o cancela la edición del contorno', 'warn'); return; }
  if (draw) { removeLastDrawVertex(); return; }
  const prev = undoStack.pop();
  if (!prev) { setStatus('Nada que deshacer', 'ok'); return; }
  redoStack.push(serializeState());
  restoreState(prev);
  setStatus('Cambio deshecho', 'ok');
}

function redo() {
  if (mergeSession) { setStatus('Primero resuelve los cambios combinados', 'warn'); return; }
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
  nodes = []; edges = []; zones = []; connectors = [];
}

function buildFromState(state) {
  connectors = (state.connectors || []).map(canonConnector);
  state.nodes.forEach(createNodeObject);
  state.edges.forEach(createEdgeObject);
  state.zones.forEach(createZoneObject);
}

function createNodeObject(raw) {
  const d = canonNode(raw);
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

  const node = { id: d.id, type: d.type, name: d.name, icon, latlng, floor: d.floor, building: d.building, marker, el };
  if (d.conector_id) node.conector_id = d.conector_id;
  if (d.type === 'building') { node.pisos = d.pisos; node.acceso = d.acceso; }
  if (isPoiType(d.type)) {
    node.horario = d.horario;
    node.descripcion = d.descripcion;
    node.link_derivacion = d.link_derivacion;
  }

  marker.on('click', (ev) => { L.DomEvent.stopPropagation(ev); onNodeClick(node.id, ev); });
  marker.on('contextmenu', (ev) => {
    L.DomEvent.stopPropagation(ev);
    L.DomEvent.preventDefault(ev.originalEvent);
    if (node.ctx) return; // los nodos de contexto se editan en su propio alcance
    if (mode !== 'view' && !draw && !editingZoneId) deleteElement('node', node.id);
  });
  marker.on('mouseover', () => { hover = { kind: 'node', id: node.id }; });
  marker.on('mouseout', () => { if (hover?.kind === 'node' && hover.id === node.id) hover = null; });
  marker.on('dragstart', () => { node.dragFrom = marker.getLatLng(); pushHistory(); });
  // Durante el arrastre las conexiones siguen al nodo; al soltar se recalcula su peso (lo usa la app para las rutas)
  marker.on('drag', () => { node.latlng = marker.getLatLng(); updateNodeLines(node.id); });
  marker.on('dragend', () => {
    // En el editor de edificio, un nodo no puede quedar fuera del contorno
    if (!insideScope(marker.getLatLng())) {
      marker.setLatLng(node.dragFrom);
      showMapHint(node.dragFrom, outsideScopeMsg());
      undoStack.pop();
      updateHistoryButtons();
    }
    node.latlng = marker.getLatLng();
    updateNodeLines(node.id, { reweigh: true });
    markDirty();
  });

  applyNodeVisual(node);
  nodes.push(node);
  return node;
}

function connectorOf(n) {
  return n?.conector_id ? connectors.find(c => c.id === n.conector_id) || null : null;
}

// Ícono, clase y tooltip según tipo, conector y si es contexto (el ícono de datos no cambia)
function applyNodeVisual(n) {
  const c = connectorOf(n);
  n.el.classList.toggle('is-connector', !!c);
  n.el.textContent = c ? CONNECTOR_LETTER[c.tipo] : n.icon;
  const label = c
    ? `${c.nombre || CONNECTOR_TYPES[c.tipo]} - ${floorLabel(n.floor, n.building)}`
    : n.name;
  setNodeTooltip(n.marker, label);
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

function createZoneObject(raw) {
  const d = canonZone(raw);
  const zone = { id: d.id, building: d.building, name: d.name, tags: d.tags, color: d.color, geojson: d.geojson, polygon: null };
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
// Pisos de diferencia entre dos nodos. El exterior y el piso de acceso de un edificio están al mismo
// nivel (la calle): una entrada no suma costo de piso aunque el acceso no sea el piso 1.
function floorDiff(a, b) {
  const acceso = (bid) => nodes.find(n => n.id === bid)?.acceso;
  if (a.building === 'exterior' && b.building !== 'exterior' && b.floor === acceso(b.building)) return 0;
  if (b.building === 'exterior' && a.building !== 'exterior' && a.floor === acceso(a.building)) return 0;
  return Math.abs(a.floor - b.floor);
}

// Peso de una conexión: distancia en metros + 15 por piso de diferencia
function edgeWeight(f, t) {
  return map.distance(f.latlng, t.latlng) + floorDiff(f, t) * 15;
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
  if (draw || editingZoneId || placement) return false;
  if (target.kind === 'node' && nodes.find(n => n.id === target.id)?.ctx) return false;
  deleteElement(target.kind, target.id);
  return true;
}

function deleteElement(kind, id) {
  if (mode === 'view' || mergeSession) return;
  if (map) map.closePopup();
  if (kind === 'node') {
    const n = nodes.find(x => x.id === id);
    if (!n) return;
    if (n.ctx) return;
    if (n.type === 'building') { attemptDeleteBuilding(id); return; }
    if (n.conector_id) { removeConnectorStop(id); return; }
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
  if (placement) { placeConnectorStop(e.latlng); return; }
  if (editingZoneId) { insertVertexIntoEditingZone(e.latlng); return; }
  if (draw) { addDrawVertex(e.latlng); return; }
  if (mode !== 'create') { clearSelection(); return; }
  if (IS_BUILDING && !currentBuilding) return;
  if (!insideScope(e.latlng) && !edgeFrom) { showMapHint(e.latlng, outsideScopeMsg()); return; }
  if (waypointMode) { routeClickAt(e.latlng); return; }
  if (edgeFrom) { cancelEdge(); return; }
  if (e.originalEvent?.shiftKey && lastCreated) { repeatLast(e.latlng); return; }
  openCreateMenu(e.latlng);
}

function onNodeClick(id, ev) {
  if (editingZoneId) return;
  const n = nodes.find(x => x.id === id);
  if (!n) return;
  if (placement) { if (!n.ctx) placeConnectorStop(n.latlng, n); return; }
  if (draw) { addDrawVertex(n.latlng); return; } // dibujar un contorno usando nodos como esquinas
  if (mode === 'view') { openInfoPopup('node', id, ev.latlng); return; }
  // Nodos de contexto: en el edificio, el exterior solo se conecta (entradas); en el campus, los interiores no se tocan
  if (n.ctx && !(IS_BUILDING && mode === 'create')) {
    showMapHint(n.latlng, IS_BUILDING ? 'Se edita en Dibujar Mapa' : 'Se edita en el editor del edificio');
    return;
  }
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
  if (last.kind === 'connector') return 'Conector entre pisos';
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
  if (IS_BUILDING) {
    opts.push({ key: '2', label: 'Conector entre pisos', hint: 'Escalera, ascensor, rampa', action: () => showConnectorForm() });
  } else {
    opts.push({ key: '2', label: 'Edificio', hint: 'Datos y contorno', action: () => showNodeForm('building') });
  }
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
  if (kind === 'connector') { showConnectorForm(); return; }
  showNodeForm(kind === 'building' ? 'building' : type);
}

// Nodo existente a menos de medio metro en el piso visible (evita duplicados por doble clic)
function nodeAtPoint(latlng, floor = currentFloor) {
  return nodes.find(n => n.floor === floor && n.latlng.distanceTo(latlng) < 0.5) || null;
}

// Crea el nodo sin historial (lo llama commit)
function addNodeRaw(type, latlng, fields = {}, { floor = currentFloor, building = currentBuilding, conector_id = null } = {}) {
  const id = crypto.randomUUID();
  const shortId = id.split('-')[0].toUpperCase();
  const sys = SYSTEM_TYPES[type];
  return createNodeObject({
    id, type,
    name: (fields.name || '').trim() || (type === 'waypoint' ? `WP-${shortId}` : `Nodo ${shortId}`),
    icon: (isPoiType(type) && (fields.icon || '').trim()) || sys.icon,
    lat: latlng.lat, lng: latlng.lng, floor, building,
    horario: (fields.horario || '').trim(), descripcion: (fields.descripcion || '').trim(), link_derivacion: (fields.link || '').trim(),
    conector_id,
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
  if (!insideScope(latlng)) { showMapHint(latlng, outsideScopeMsg()); return; }
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
  if (floorDiff(fn, tn) !== 0) { showMapHint(latlng, 'No se puede dividir una conexión entre pisos'); return; }

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
    // Entre el exterior y una entrada: el punto nuevo queda donde cae (dentro del contorno o afuera)
    let building = fn.building, floor = fn.floor;
    if (fn.building !== tn.building) {
      const inner = fn.building === 'exterior' ? tn : fn;
      building = insideBuilding(at, inner.building) ? inner.building : 'exterior';
      floor = building === 'exterior' ? 1 : inner.floor;
    }
    wp = addNodeRaw('waypoint', at, {}, { floor, building });
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
  // En el editor de edificio la zona es de ese edificio; en el campus se elige
  bsel.hidden = kind !== 'zone' || IS_BUILDING;
  if (kind === 'zone' && !IS_BUILDING) populateBuildingSelect(bsel, currentBuilding);
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
        id: crypto.randomUUID(), building: IS_BUILDING ? currentBuilding : (buildingSel === 'exterior' ? null : buildingSel),
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
    const c = connectorOf(n);
    if (c) {
      title = c.nombre || CONNECTOR_TYPES[c.tipo];
      rows[0] = ['Tipo', `Conector: ${CONNECTOR_TYPES[c.tipo]}`];
      rows.push(['Paradas', connectorStops(c.id).map(st => floorLabel(st.floor, st.building)).join(', ')]);
    } else if (n.type === 'building') {
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
  // En el campus: el nodo de un edificio y su contorno llevan a editar el interior
  let bldId = null;
  if (!IS_BUILDING && type === 'node' && nodes.some(x => x.id === id && x.type === 'building')) bldId = id;
  if (!IS_BUILDING && type === 'zone') {
    const z = zones.find(x => x.id === id);
    if (z.building && z.tags.includes('contorno_edificio') && nodes.some(x => x.id === z.building)) bldId = z.building;
  }
  const html = `
    <div class="pop-info">
      <h6 class="pop-title">${escapeHtml(title)}</h6>
      <dl>${body}</dl>
      ${bldId ? `<button type="button" class="btn btn-sm btn-secondary w-100 mt-2" onclick="openBuildingEditor('${bldId}')">Editar interior</button>` : ''}
    </div>`;
  L.popup({ className: 'nv-popup', autoPan: false, maxWidth: 280 }).setLatLng(latlng).setContent(html).openOn(map);
}

function popupActions(kind, id) {
  return `
    <div class="pop-actions">
      <button type="button" class="btn btn-sm btn-danger" onclick="deleteElement('${kind}', '${id}')" title="Eliminar (Supr)">Eliminar</button>
      <span class="spacer"></span>
      <button type="button" class="btn btn-sm btn-secondary" onclick="map.closePopup()">Cancelar</button>
      <button type="button" class="btn btn-sm btn-accent" data-primary onclick="save${kind === 'node' ? 'Node' : kind === 'edge' ? 'Edge' : 'Zone'}Edit('${id}')" title="Guardar (Enter)">Guardar</button>
    </div>`;
}

function openEditPopup(type, id, latlng) {
  let html = '';
  if (type === 'node') {
    const n = nodes.find(x => x.id === id);
    if (n.conector_id) { openConnectorPopup(n, latlng); return; }
    const isBld = n.type === 'building';
    const isSrv = isPoiType(n.type);
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
        </select>` : ''}
        ${isBld ? `<button type="button" class="btn btn-sm btn-secondary w-100 mb-2" onclick="openBuildingEditor('${id}')">Editar interior (${n.pisos.length} ${n.pisos.length === 1 ? 'piso' : 'pisos'})</button>` : ''}
        ${IS_BUILDING && n.type === 'waypoint' && n.building !== 'exterior' ? `<button type="button" class="btn btn-sm btn-secondary w-100 mb-2" onclick="startConnectorFromNode('${id}')">Conectar a otro piso</button>` : ''}
        <div id="pop-srv-fields" ${isSrv ? '' : 'hidden'}>
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
          <input type="checkbox" id="pop-es-escalera" ${e.es_escalera ? 'checked' : ''}>
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
        <button type="button" class="btn btn-sm btn-secondary w-100" onclick="enableZoneVertexEditing('${id}')">Modificar contorno</button>
        ${!IS_BUILDING && z.building && z.tags.includes('contorno_edificio') && nodes.some(x => x.id === z.building)
          ? `<button type="button" class="btn btn-sm btn-secondary w-100 mt-2" onclick="openBuildingEditor('${z.building}')">Editar interior</button>` : ''}
        ${popupActions('zone', id)}
      </div>`;
  }
  L.popup({ className: 'nv-popup nv-edit', autoPan: false, maxWidth: 300, minWidth: 240 }).setLatLng(latlng).setContent(html).openOn(map);
}

// Al cambiar el tipo en el popup: mostrar u ocultar los campos de POI y proponer el ícono del nuevo tipo
window.onPopTypeChange = function (sel) {
  document.getElementById('pop-srv-fields').hidden = !isPoiType(sel.value);
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
// =============================================================================
// Alcance: qué se ve y qué se puede editar
// =============================================================================
function contourOf(bid) {
  return zones.find(z => z.building === bid && z.tags.includes('contorno_edificio')) || null;
}

// Punto dentro de un polígono GeoJSON (anillo exterior), por paridad de cruces
function pointInRing(latlng, ring) {
  const x = latlng.lng, y = latlng.lat;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function insideBuilding(latlng, bid) {
  const z = contourOf(bid);
  const ring = z?.geojson?.coordinates?.[0];
  return ring ? pointInRing(latlng, ring) : true; // sin contorno no se puede validar: se permite
}

// En el editor de edificio no se crea ni se deja nada fuera de su contorno; en el campus, fuera del
// contorno de la sede (si la sede tiene uno)
function insideScope(latlng) {
  if (!IS_BUILDING) {
    const ring = sedeRing();
    return !ring || pointInRing(latlng, ring);
  }
  return !currentBuilding || insideBuilding(latlng, currentBuilding);
}

function currentBuildingNode() {
  return IS_BUILDING && currentBuilding ? nodes.find(n => n.id === currentBuilding) || null : null;
}

// 'main' (se edita aquí), 'ctx' (contexto atenuado) o null (no se muestra)
function nodeView(n, ctxInterior) {
  if (!IS_BUILDING) {
    if (n.building === 'exterior') return 'main';
    return ctxInterior.has(n.id) ? 'ctx' : null;
  }
  const b = currentBuildingNode();
  if (!b) return null;
  if (n.building === b.id && n.floor === currentFloor) return 'main';
  if (n.building === 'exterior' && currentFloor === b.acceso) return 'ctx';
  return null;
}

// Mapa limitado al área del edificio: no se puede arrastrar fuera ni alejar más allá de verlo completo
function applyBuildingLock() {
  const b = currentBuildingNode();
  if (!map || !b) return;
  const z = contourOf(b.id);
  const bounds = z ? z.polygon.getBounds() : b.latlng.toBounds(150);
  map.setMaxBounds(null);
  map.setMinZoom(0);
  map.fitBounds(bounds, { padding: [60, 60], animate: false, maxZoom: map.getMaxZoom() });
  map.setMinZoom(Math.max(map.getZoom() - 1, 0));
  map.setMaxBounds(bounds.pad(0.6));
}

// =============================================================================
// Edificio y piso visibles
// =============================================================================
function updateBuildingSelector() {
  if (!IS_BUILDING) {
    currentBuilding = 'exterior';
    currentFloor = 1;
    return;
  }
  const sel = document.getElementById('building-selector');
  const blds = sortedBuildings();
  sel.innerHTML = '';
  if (!blds.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Sin edificios';
    sel.appendChild(opt);
    sel.disabled = true;
    currentBuilding = null;
    renderFloorList();
    return;
  }
  sel.disabled = false;
  blds.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.name || 'Edificio';
    sel.appendChild(opt);
  });
  if (!blds.some(b => b.id === currentBuilding)) {
    selectBuilding(blds[0].id);
    return;
  }
  sel.value = currentBuilding;
  updateFloorSelector();
}

// Cambiar de edificio no pierde cambios: el mapa completo sigue en memoria hasta publicar
function changeBuilding() {
  const id = document.getElementById('building-selector').value;
  if (id && id !== currentBuilding) selectBuilding(id);
}

function selectBuilding(id) {
  if (map) map.closePopup();
  if (placement) cancelConnectorPlacement();
  if (editingZoneId) finishVertexEditing();
  if (draw) cancelDrawing();
  cancelEdge();
  endRoute();
  clearSelection();
  currentBuilding = id;
  const b = currentBuildingNode();
  currentFloor = b ? b.acceso : 1;
  document.getElementById('building-selector').value = id;
  updateFloorSelector();
  applyBuildingLock();
  renderMapNodes();
  updateLocationUrl();
}

function updateLocationUrl() {
  try {
    const url = new URL(location.href);
    url.searchParams.set('sede', currentSedeId || '');
    if (IS_BUILDING && currentBuilding) url.searchParams.set('edificio', currentBuilding);
    url.searchParams.delete('nodo');
    history.replaceState(null, '', url);
  } catch (_) { /* sin History API: solo no se actualiza la dirección */ }
  const campus = document.getElementById('campus-link');
  if (campus && currentBuilding) campus.href = `${BASE_URL}/admin?sede=${encodeURIComponent(currentSedeId || '')}&nodo=${encodeURIComponent(currentBuilding)}`;
}

// Lista de pisos del edificio (de arriba hacia abajo), con el acceso marcado
function updateFloorSelector() {
  if (!IS_BUILDING) return;
  const b = currentBuildingNode();
  if (b && !b.pisos.some(p => p.numero === currentFloor)) currentFloor = b.acceso;
  renderFloorList();
}

function renderFloorList() {
  const list = document.getElementById('floor-list');
  if (!list) return;
  list.innerHTML = '';
  const b = currentBuildingNode();
  if (!b) {
    list.innerHTML = '<div class="panel-meta">Esta sede no tiene edificios. Créalos en Dibujar Mapa.</div>';
    return;
  }
  [...b.pisos].reverse().forEach(p => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'floor-item' + (p.numero === currentFloor ? ' active' : '');
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', p.numero === currentFloor ? 'true' : 'false');
    const label = document.createElement('span');
    label.textContent = floorLabel(p.numero, b.id);
    btn.appendChild(label);
    if (p.numero === b.acceso) {
      const tag = document.createElement('small');
      tag.className = 'floor-tag';
      tag.textContent = 'Acceso';
      btn.appendChild(tag);
    }
    const count = document.createElement('small');
    count.className = 'floor-count';
    count.textContent = nodes.filter(n => n.building === b.id && n.floor === p.numero).length;
    btn.appendChild(count);
    btn.addEventListener('click', () => setFloor(p.numero));
    list.appendChild(btn);
  });
}

function setFloor(numero, { keepPlacement = false } = {}) {
  if (!keepPlacement && placement) cancelConnectorPlacement();
  currentFloor = numero;
  cancelEdge();
  endRoute();
  if (map) map.closePopup();
  renderFloorList();
  renderMapNodes();
}

// Re Pág / Av Pág: piso de arriba / de abajo
function stepFloor(delta) {
  const b = currentBuildingNode();
  if (!b) return;
  const nums = b.pisos.map(p => p.numero);
  const i = nums.indexOf(currentFloor);
  const next = nums[i + delta];
  if (next !== undefined) setFloor(next);
}

function changeFloor() {
  renderMapNodes();
}

function edgeStyleFor(e, fn, tn, view) {
  const selected = selection?.kind === 'edge' && selection.id === e.id;
  if (view === 'main') {
    return { color: edgeColor(e), weight: selected ? 6 : 3, opacity: 1, dashArray: floorDiff(fn, tn) ? '5, 10' : null };
  }
  // contexto: conexiones del exterior (o hacia un interior) finas y tenues, sin interacción
  return { color: edgeColor(e), weight: 1.5, opacity: 0.4, dashArray: view === 'link' ? '4, 6' : null };
}

function renderMapNodes() {
  // En el campus se muestran, atenuados, los nodos interiores conectados al exterior
  const ctxInterior = new Set();
  if (!IS_BUILDING) {
    const ext = new Set(nodes.filter(n => n.building === 'exterior').map(n => n.id));
    edges.forEach(e => {
      if (ext.has(e.from) && !ext.has(e.to)) ctxInterior.add(e.to);
      if (ext.has(e.to) && !ext.has(e.from)) ctxInterior.add(e.from);
    });
  }
  const views = new Map();
  nodes.forEach(n => {
    const v = nodeView(n, ctxInterior);
    views.set(n.id, v);
    n.ctx = v === 'ctx';
    n.el.classList.toggle('is-context', n.ctx);
    setMarkerDraggable(n.marker, mode === 'modify' && v === 'main');
    if (v) n.marker.addTo(map); else n.marker.removeFrom(map);
  });

  const b = currentBuildingNode();
  edges.forEach(e => {
    const fn = nodes.find(x => x.id === e.from), tn = nodes.find(x => x.id === e.to);
    const vf = views.get(e.from), vt = views.get(e.to);
    let view = null;
    if (fn && tn) {
      if (vf === 'main' || vt === 'main') {
        // incluye las paradas de un conector hacia otro piso (el otro extremo no se ve en este piso)
        view = (vf && vt) || (IS_BUILDING && fn.building === tn.building) || (!IS_BUILDING && (vf || vt)) ? 'main' : null;
      } else if (!IS_BUILDING && (vf === 'ctx' || vt === 'ctx')) {
        view = null;
      } else if (IS_BUILDING && b && fn.building === 'exterior' && tn.building === 'exterior') {
        view = 'faint'; // el exterior como referencia (en el acceso, además, sus nodos)
      }
    }
    e.view = view;
    if (!view) { e.line.removeFrom(map); return; }
    e.line.options.interactive = view === 'main';
    e.line.addTo(map);
    e.line.setStyle(edgeStyleFor(e, fn, tn, view));
  });
  if (!IS_BUILDING) {
    // conexiones exterior-interior: el extremo interior se muestra atenuado
    edges.forEach(e => {
      if (e.view !== 'main') return;
      const fn = nodes.find(x => x.id === e.from), tn = nodes.find(x => x.id === e.to);
      if (views.get(e.from) === 'ctx' || views.get(e.to) === 'ctx') {
        e.line.options.interactive = false;
        e.line.setStyle(edgeStyleFor(e, fn, tn, 'link'));
      }
    });
  }
  renderZonesForScope();

  const count = IS_BUILDING
    ? nodes.filter(n => b && n.building === b.id && n.floor === currentFloor).length
    : nodes.filter(n => n.building === 'exterior').length;
  document.getElementById('st-nodes').textContent = count;
  if (IS_BUILDING) renderFloorList();
}

// Zonas: en el campus todas se editan. En un edificio se editan sus zonas seguras; su contorno
// y lo demás se ven como referencia, sin interacción.
function renderZonesForScope() {
  zones.forEach(z => {
    const editable = !IS_BUILDING || (z.building === currentBuilding && !z.tags.includes('contorno_edificio'));
    const own = IS_BUILDING && z.building === currentBuilding;
    z.polygon.eachLayer(layer => { layer.options.interactive = editable; });
    if (z.id === editingZoneId) return;
    const style = zoneStyle(z, selection?.kind === 'zone' && selection.id === z.id);
    if (!editable) {
      // el contorno del edificio que se edita se ve claro; lo demás, tenue
      style.fillOpacity = own ? 0.22 : 0.05;
      style.opacity = own ? 1 : 0.35;
      style.weight = own ? 3 : 1.5;
    }
    z.polygon.setStyle(style);
  });
}

// =============================================================================
// Ir al otro editor (campus / edificio). Ambos publican el mapa completo, así que antes de
// salir hay que publicar: los cambios sin publicar de esta página no viajan a la otra.
// =============================================================================
async function leaveTo(url) {
  if (hasUnsavedChanges) {
    await window.uiAlert('Tienes cambios sin publicar. Publícalos antes de abrir el otro editor (o descártalos recargando la página).', 'Cambios sin publicar');
    return;
  }
  location.href = url;
}

window.openBuildingEditor = function (buildingId, nodeId = null) {
  if (IS_BUILDING) { selectBuilding(buildingId); if (nodeId) locateNodes([nodeId]); return; }
  const url = `${BASE_URL}/admin/edificios/editar?sede=${encodeURIComponent(currentSedeId || '')}&edificio=${encodeURIComponent(buildingId)}`
    + (nodeId ? `&nodo=${encodeURIComponent(nodeId)}` : '');
  leaveTo(url);
};

function openCampusEditor(nodeId = null) {
  leaveTo(`${BASE_URL}/admin?sede=${encodeURIComponent(currentSedeId || '')}` + (nodeId ? `&nodo=${encodeURIComponent(nodeId)}` : ''));
}

// =============================================================================
// Pisos del edificio (ventana "Gestionar pisos", mismo componente que Gestión de Edificios).
// Al aplicar: los nodos se mueven con su piso, los pisos eliminados se llevan sus nodos, y todo
// queda en un solo paso de deshacer.
// =============================================================================
let floorsModel = null;
let floorsUndo = [], floorsRedo = []; // deshacer / rehacer dentro de la ventana (antes de Aplicar)

window.openFloorsModal = function () {
  const b = currentBuildingNode();
  if (!b || mergeSession) return;
  floorsModel = PisosUI.makeModel(b.name, b.pisos, b.acceso);
  floorsUndo = [];
  floorsRedo = [];
  document.getElementById('floorsTitle').textContent = `Pisos de ${b.name || 'Edificio'}`;
  renderFloorsModal();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('floorsModal')).show();
};

function renderFloorsModal() {
  const b = currentBuildingNode();
  const counts = (p) => {
    const list = nodes.filter(n => n.building === b.id && n.floor === p.desde);
    const poi = list.filter(n => n.type !== 'waypoint').length;
    return { poi, ruta: list.length - poi, total: list.length };
  };
  PisosUI.render(document.getElementById('floors-editor'), floorsModel, {
    counts, onChange: () => {}, rerender: renderFloorsModal,
    beforeChange: () => { floorsUndo.push(PisosUI.cloneModel(floorsModel)); floorsRedo = []; },
  });
  // al redibujar se pierde el foco (el botón usado ya no existe): se devuelve a la ventana para que sigan
  // funcionando Esc y los atajos
  const modal = document.getElementById('floorsModal');
  if (modal.classList.contains('show') && !modal.contains(document.activeElement)) modal.focus();
}

// Ctrl/Cmd+Z con la ventana de pisos abierta deshace lo hecho en la ventana
function floorsModalUndo(redo = false) {
  const from = redo ? floorsRedo : floorsUndo, to = redo ? floorsUndo : floorsRedo;
  const prev = from.pop();
  if (!prev) return;
  to.push(PisosUI.cloneModel(floorsModel));
  floorsModel = prev;
  renderFloorsModal();
}

window.applyFloorsModal = async function () {
  const b = currentBuildingNode();
  if (!b || !floorsModel) return;
  if (PisosUI.numerosRepetidos(floorsModel).size) { await window.uiAlert('Hay números de piso repetidos.', 'Pisos'); return; }
  const model = floorsModel;
  const mapping = new Map(model.pisos.filter(p => p.desde !== null).map(p => [p.desde, p.numero]));
  commit(() => {
    // pisos eliminados: sus nodos (y conexiones) se van; los conectores afectados se vuelven a unir
    const gone = nodes.filter(n => n.building === b.id && !mapping.has(n.floor));
    const touched = new Set(gone.map(n => n.conector_id).filter(Boolean));
    gone.forEach(n => removeNode(n.id));
    touched.forEach(rebuildConnectorEdges);
    nodes.filter(n => n.building === b.id).forEach(n => { n.floor = mapping.get(n.floor); });
    b.pisos = [...model.pisos].sort((x, y) => x.numero - y.numero).map(p => ({ numero: p.numero, nombre: (p.nombre || '').trim() || null }));
    b.acceso = PisosUI.accesoNumero(model);
    // los desniveles cambiaron: se recalculan los pesos de las conexiones del edificio
    edges.forEach(e => {
      const fn = nodes.find(n => n.id === e.from), tn = nodes.find(n => n.id === e.to);
      if (fn && tn && (fn.building === b.id || tn.building === b.id)) e.weight = edgeWeight(fn, tn);
    });
    nodes.filter(n => n.building === b.id).forEach(applyNodeVisual);
  });
  const mapped = mapping.get(currentFloor);
  currentFloor = mapped !== undefined ? mapped : b.acceso;
  bootstrap.Modal.getInstance(document.getElementById('floorsModal'))?.hide();
  updateFloorSelector();
  renderMapNodes();
  setStatus('Pisos actualizados', 'ok');
};

// =============================================================================
// Conectores verticales.
//   Ascensor: una parada (nodo) por piso, normalmente en la misma posición; se unen de piso en piso.
//   Escalera / rampa: tramos. Cada tramo empieza en un punto de un piso y termina en otro punto del
//   piso siguiente. En un piso intermedio hay una llegada (fin del tramo de abajo) y una salida (inicio
//   del tramo de arriba); si son el mismo nodo, la escalera sigue recta. Si son distintos, no se unen
//   solos: el camino entre ellas (recto, en L, etc.) lo dibuja el usuario.
// Las aristas de los tramos de una escalera llevan es_escalera (la ruta accesible las evita).
// =============================================================================
function isFlightType(tipo) {
  return tipo === 'escalera' || tipo === 'rampa';
}

function connectorStops(cid) {
  return nodes.filter(n => n.conector_id === cid).sort((a, b) => a.floor - b.floor);
}

// Ascensor: une las paradas de piso en piso (sin commit propio: se llama dentro de commit)
function rebuildConnectorEdges(cid) {
  const c = connectors.find(x => x.id === cid);
  if (!c || isFlightType(c.tipo)) return; // los tramos de escaleras y rampas se definen al crearlos
  const stops = connectorStops(cid);
  const ids = new Set(stops.map(n => n.id));
  edges.filter(e => ids.has(e.from) && ids.has(e.to)).forEach(e => removeEdge(e.id));
  for (let i = 0; i + 1 < stops.length; i++) addEdgeRaw(stops[i].id, stops[i + 1].id, false);
}

// Conectores sin paradas se eliminan; paradas de conectores inexistentes vuelven a ser puntos de ruta
function syncConnectors() {
  connectors = connectors.filter(c => nodes.some(n => n.conector_id === c.id));
  nodes.forEach(n => {
    if (n.conector_id && !connectors.some(c => c.id === n.conector_id)) { delete n.conector_id; applyNodeVisual(n); }
  });
}

// Pisos del edificio en orden (de abajo hacia arriba), entre dos números incluidos
function floorsBetween(b, desde, hasta) {
  const lo = Math.min(desde, hasta), hi = Math.max(desde, hasta);
  return b.pisos.map(p => p.numero).filter(n => n >= lo && n <= hi);
}

function connectorFormElement({ title, fixedFloor = null, onSubmit, onCancel }) {
  const b = currentBuildingNode();
  const nums = b.pisos.map(p => p.numero);
  const startFloor = fixedFloor ?? (nums.includes(currentFloor) ? currentFloor : nums[0]);
  const above = nums.filter(n => n > startFloor);
  const opt = (n, sel) => `<option value="${n}" ${n === sel ? 'selected' : ''}>${escapeHtml(floorLabel(n, b.id))}</option>`;
  const floorChecks = [...b.pisos].reverse().map(p => `
    <label class="pop-check"><input type="checkbox" name="piso" value="${p.numero}" checked> ${escapeHtml(floorLabel(p.numero, b.id))}</label>`).join('');
  const form = document.createElement('form');
  form.className = 'pop-edit';
  form.innerHTML = `
    <div class="ctx-title">${escapeHtml(title)}</div>
    <label>Tipo</label>
    <select name="tipo" class="form-select form-select-sm mb-2">
      <option value="escalera">Escalera</option>
      <option value="rampa">Rampa</option>
      <option value="ascensor">Ascensor</option>
    </select>
    <label>Nombre (opcional)</label>
    <input name="nombre" type="text" class="form-control form-control-sm mb-2" maxlength="255" placeholder="Ej: Escalera norte">
    <div data-flights>
      <div class="d-flex gap-2">
        <div class="flex-fill"><label>Desde</label>
          <select name="desde" class="form-select form-select-sm mb-2" ${fixedFloor !== null ? 'disabled' : ''}>${nums.map(n => opt(n, startFloor)).join('')}</select></div>
        <div class="flex-fill"><label>Hasta</label>
          <select name="hasta" class="form-select form-select-sm mb-2">${nums.map(n => opt(n, above[0] ?? startFloor)).join('')}</select></div>
      </div>
      <label class="pop-check mb-1"><input type="checkbox" name="pattern" checked> Todos los tramos en la misma ubicación</label>
      <div class="panel-meta mb-2">Marcas dónde empieza el primer tramo y dónde termina en el piso siguiente; los demás tramos se repiten en esos puntos. Sin marcar, eliges cada tramo.</div>
    </div>
    <div data-elevator hidden>
      <label>Pisos donde para</label>
      <div class="connector-floors mb-2">${floorChecks}</div>
      <label class="pop-check mb-1"><input type="checkbox" name="same" checked> Misma posición en todos los pisos</label>
      <div class="panel-meta mb-2">Si no, en cada piso haces clic donde está la parada (o en un punto de ruta existente).</div>
    </div>
    <div class="pop-actions">
      <span class="spacer"></span>
      <button type="button" class="btn btn-sm btn-secondary" data-cancel>Cancelar</button>
      <button type="submit" class="btn btn-sm btn-accent" data-primary>Continuar</button>
    </div>`;
  const tipo = form.querySelector('[name="tipo"]');
  const syncKind = () => {
    form.querySelector('[data-flights]').hidden = !isFlightType(tipo.value);
    form.querySelector('[data-elevator]').hidden = isFlightType(tipo.value);
    fitPopup(activePopup);
  };
  tipo.addEventListener('change', syncKind);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const nombre = form.querySelector('[name="nombre"]').value.trim();
    if (isFlightType(tipo.value)) {
      const desde = parseInt(form.querySelector('[name="desde"]').value, 10);
      const hasta = parseInt(form.querySelector('[name="hasta"]').value, 10);
      const floors = floorsBetween(b, desde, hasta);
      if (floors.length < 2) { showMapHint(map.getCenter(), 'Elige dos pisos distintos'); return; }
      onSubmit({ tipo: tipo.value, nombre, floors, pattern: form.querySelector('[name="pattern"]').checked });
    } else {
      const floors = [...form.querySelectorAll('[name="piso"]:checked')].map(i => parseInt(i.value, 10)).sort((x, y) => x - y);
      if (floors.length < 2) { showMapHint(map.getCenter(), 'Elige al menos dos pisos'); return; }
      onSubmit({ tipo: tipo.value, nombre, floors, samePos: form.querySelector('[name="same"]').checked });
    }
  });
  form.querySelector('[data-cancel]').addEventListener('click', onCancel);
  return form;
}

// Desde el menú de Crear: el punto del clic es el inicio (escalera/rampa) o la parada del piso actual (ascensor)
function showConnectorForm() {
  const b = currentBuildingNode();
  if (!b) return;
  if (b.pisos.length < 2) { map.closePopup(); showMapHint(ctx.latlng, 'El edificio tiene un solo piso: agrega pisos en Gestionar pisos'); return; }
  ctx.step = 'form';
  const latlng = ctx.latlng;
  const form = connectorFormElement({
    title: 'Nuevo conector entre pisos',
    onSubmit: (cfg) => { map.closePopup(); startConnectorPlacement({ ...cfg, latlng }); },
    onCancel: () => map.closePopup(),
  });
  ctx.popup.setContent(form);
  fitPopup(ctx.popup);
}

// Desde un punto de ruta: ese nodo es el inicio del primer tramo (o la parada de su piso, en un ascensor)
window.startConnectorFromNode = function (id) {
  const n = nodes.find(x => x.id === id);
  const b = currentBuildingNode();
  if (!n || !b) return;
  if (b.pisos.length < 2) { showMapHint(n.latlng, 'El edificio tiene un solo piso'); return; }
  const form = connectorFormElement({
    title: 'Conectar a otro piso',
    fixedFloor: n.floor,
    onSubmit: (cfg) => {
      map.closePopup();
      if (!cfg.floors.includes(n.floor)) cfg.floors = [...cfg.floors, n.floor].sort((x, y) => x - y);
      startConnectorPlacement({ ...cfg, latlng: n.latlng, first: n.id });
    },
    onCancel: () => map.closePopup(),
  });
  L.popup({ className: 'nv-popup nv-edit', autoPan: false, minWidth: 260, maxWidth: 320 }).setLatLng(n.latlng).setContent(form).openOn(map);
};

function startConnectorPlacement(cfg) {
  if (mode !== 'create' && mode !== 'modify') setMode('create');
  cancelEdge();
  endRoute();
  placement = { ...cfg, ghosts: [], returnFloor: currentFloor, floor: null };
  document.getElementById('map').classList.add('is-drawing');
  if (isFlightType(cfg.tipo)) {
    placement.flights = [];        // [{ start: punto, end: punto }]; punto = { latlng, existing?, linkTo? }
    placement.k = 0;               // tramo en curso
    placement.part = 'start';
    const firstNode = cfg.first ? nodes.find(x => x.id === cfg.first) : null;
    if (firstNode && firstNode.floor === cfg.floors[0]) {
      placement.flights[0] = { start: { existing: firstNode.id, latlng: firstNode.latlng } };
      placement.part = 'end';
    } else if (cfg.latlng && currentFloor === cfg.floors[0] && !cfg.connectorId) {
      placement.flights[0] = { start: { latlng: cfg.latlng } };
      placement.part = 'end';
    }
    nextFlightStep();
    return;
  }
  // Ascensor: una parada por piso
  placement.stops = new Map();
  if (cfg.first) {
    const n = nodes.find(x => x.id === cfg.first);
    placement.stops.set(n.floor, { existing: n.id, latlng: n.latlng });
  } else if (cfg.latlng && cfg.floors.includes(currentFloor) && !cfg.connectorId) {
    placement.stops.set(currentFloor, { latlng: cfg.latlng });
  }
  if (cfg.samePos && cfg.latlng) {
    cfg.floors.forEach(f => { if (!placement.stops.has(f)) placement.stops.set(f, { latlng: cfg.latlng }); });
    finishConnectorPlacement();
    return;
  }
  nextElevatorFloor();
}

function showPlacementBar(title, hint, canSkip) {
  document.getElementById('connector-title').textContent = title;
  document.getElementById('connector-hint').textContent = hint;
  const skip = document.getElementById('connector-skip');
  skip.hidden = !canSkip;
  document.getElementById('connector-bar').hidden = false;
}

function connectorTitle(pl) {
  return `${CONNECTOR_TYPES[pl.tipo]}${pl.nombre ? ` ${pl.nombre}` : ''}`;
}

// Escalera / rampa: inicio del tramo k en floors[k] y fin en floors[k + 1]
function nextFlightStep() {
  const pl = placement;
  const total = pl.floors.length - 1;
  if (pl.part === 'start' && pl.k >= total) { finishConnectorPlacement(); return; }
  // Con "misma ubicación", al tener el primer tramo completo se generan los demás
  if (pl.pattern && pl.k === 1 && pl.part === 'start') {
    const P = pl.flights[0].start.latlng, Q = pl.flights[0].end.latlng;
    for (let k = 1; k < total; k++) pl.flights[k] = { start: { latlng: P }, end: { latlng: Q } };
    finishConnectorPlacement();
    return;
  }
  pl.floor = pl.part === 'start' ? pl.floors[pl.k] : pl.floors[pl.k + 1];
  setFloor(pl.floor, { keepPlacement: true });
  drawFlightGhosts();
  const where = pl.part === 'start' ? 'empieza' : 'termina';
  showPlacementBar(
    `${connectorTitle(pl)} - Tramo ${pl.k + 1} de ${total}: clic donde ${where} (${floorLabel(pl.floor, currentBuilding)})`,
    pl.part === 'start' && pl.k > 0
      ? 'Clic en la llegada del tramo anterior si la escalera sigue recta, o donde empieza el tramo - Esc cancela todo'
      : 'Clic en el mapa o en un punto de ruta existente - Esc cancela todo',
    false);
}

function drawFlightGhosts() {
  const pl = placement;
  clearGhosts();
  const marks = [];
  pl.flights.forEach((f, k) => {
    if (f.start && pl.floors[k] !== currentFloor) marks.push([f.start.latlng, `Inicio tramo ${k + 1} (${floorLabel(pl.floors[k], currentBuilding)})`]);
    if (f.end && pl.floors[k + 1] !== currentFloor) marks.push([f.end.latlng, `Fin tramo ${k + 1} (${floorLabel(pl.floors[k + 1], currentBuilding)})`]);
  });
  // la llegada del tramo anterior a este piso aún no existe como nodo: se muestra como guía en este piso
  const prev = pl.flights[pl.k - 1];
  if (pl.part === 'start' && prev?.end) marks.push([prev.end.latlng, 'Llegada del tramo anterior', true]);
  marks.forEach(([ll, label, here]) => addGhost(ll, label, here));
}

function clearGhosts() {
  placement.ghosts.forEach(g => g.remove());
  placement.ghosts = [];
}

function addGhost(latlng, label, here = false) {
  const g = L.circleMarker(latlng, {
    radius: here ? 10 : 8, weight: 2, dashArray: here ? null : '3,3',
    color: themeVar('--naviusm-accent'), fillOpacity: here ? 0.35 : 0.12, interactive: false,
  }).bindTooltip(escapeHtml(label), { permanent: true, direction: 'right', className: 'ghost-label' }).addTo(map);
  placement.ghosts.push(g);
}

// Ascensor: siguiente piso sin parada
function nextElevatorFloor() {
  const pl = placement;
  const rest = pl.floors.filter(f => !pl.stops.has(f));
  if (!rest.length) { finishConnectorPlacement(); return; }
  const placed = [...pl.stops.keys()];
  const ref = placed.length ? placed[placed.length - 1] : currentFloor;
  rest.sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref) || a - b);
  pl.floor = rest[0];
  setFloor(pl.floor, { keepPlacement: true });
  clearGhosts();
  const shown = [...pl.stops.entries()];
  if (pl.connectorId) connectorStops(pl.connectorId).forEach(n => shown.push([n.floor, { latlng: n.latlng }]));
  shown.forEach(([floor, st]) => { if (floor !== currentFloor) addGhost(st.latlng, floorLabel(floor, currentBuilding)); });
  const existing = pl.connectorId ? connectorStops(pl.connectorId).length : 0;
  showPlacementBar(
    `${connectorTitle(pl)}: ${floorLabel(pl.floor, currentBuilding)} (${pl.stops.size + existing + 1} de ${pl.floors.length + existing})`,
    'Clic donde está la parada en este piso - Clic en un punto de ruta para usarlo - Esc cancela todo',
    pl.connectorId || pl.stops.size + rest.length - 1 >= 2);
}

// Punto elegido para una parada: un punto de ruta libre se usa tal cual; una sala u otra parada,
// se crea una parada al lado conectada a ella
function stopPoint(latlng, node) {
  if (!node) return { latlng };
  if (node.type === 'waypoint' && (!node.conector_id || node.conector_id === placement.connectorId)) {
    return { existing: node.id, latlng: node.latlng };
  }
  const ll = map.containerPointToLatLng(map.latLngToContainerPoint(node.latlng).add([20, 0]));
  showMapHint(ll, 'Parada creada junto al nodo y conectada a él');
  return { latlng: ll, linkTo: node.id };
}

function placeConnectorStop(latlng, node = null) {
  const pl = placement;
  if (!insideScope(latlng)) { showMapHint(latlng, outsideScopeMsg()); return; }
  if (isFlightType(pl.tipo)) {
    // clic en la llegada pendiente del tramo anterior (aún sin nodo): la escalera sigue recta desde ahí
    const prev = pl.flights[pl.k - 1];
    let point;
    if (!node && pl.part === 'start' && prev?.end && map.latLngToContainerPoint(prev.end.latlng).distanceTo(map.latLngToContainerPoint(latlng)) < 14) {
      point = { sameAs: pl.k - 1, latlng: prev.end.latlng };
    } else {
      point = stopPoint(latlng, node);
    }
    if (pl.part === 'start') {
      pl.flights[pl.k] = { start: point };
      pl.part = 'end';
    } else {
      pl.flights[pl.k].end = point;
      pl.k += 1;
      pl.part = 'start';
    }
    nextFlightStep();
    return;
  }
  pl.stops.set(pl.floor, stopPoint(latlng, node));
  nextElevatorFloor();
}

window.skipConnectorFloor = function () {
  if (!placement || isFlightType(placement.tipo)) return;
  placement.floors = placement.floors.filter(f => f !== placement.floor);
  nextElevatorFloor();
};

function endPlacementUi() {
  clearGhosts();
  document.getElementById('connector-bar').hidden = true;
  document.getElementById('map').classList.remove('is-drawing');
}

window.cancelConnectorPlacement = function () {
  if (!placement) return;
  const back = placement.returnFloor;
  endPlacementUi();
  placement = null;
  setFloor(back);
  setStatus('Conector cancelado', 'ok');
};

// Crea (o reutiliza) el nodo de un punto (sin commit propio)
function materializeStop(point, floor, cid) {
  let n;
  if (point.existing) {
    n = nodes.find(x => x.id === point.existing);
    n.conector_id = cid;
    applyNodeVisual(n);
  } else {
    n = addNodeRaw('waypoint', point.latlng, {}, { floor, building: currentBuilding, conector_id: cid });
  }
  if (point.linkTo) addEdgeRaw(n.id, point.linkTo, false);
  return n;
}

function finishConnectorPlacement() {
  const pl = placement;
  endPlacementUi();
  placement = null;
  const flights = isFlightType(pl.tipo) ? pl.flights.filter(f => f?.start && f?.end) : null;
  if (flights ? !flights.length : (!pl.connectorId && pl.stops.size < 2)) {
    setFloor(pl.returnFloor);
    showMapHint(map.getCenter(), 'El conector quedó incompleto: no se creó');
    return;
  }
  commit(() => {
    let cid = pl.connectorId;
    if (!cid) {
      cid = crypto.randomUUID();
      connectors.push(canonConnector({ id: cid, tipo: pl.tipo, nombre: pl.nombre, building: currentBuilding }));
    }
    if (flights) {
      const ends = [];
      flights.forEach((f, k) => {
        const start = f.start.sameAs !== undefined ? ends[f.start.sameAs] : materializeStop(f.start, pl.floors[k], cid);
        const end = materializeStop(f.end, pl.floors[k + 1], cid);
        addEdgeRaw(start.id, end.id, pl.tipo === 'escalera');
        ends[k] = end;
      });
    } else {
      pl.stops.forEach((st, floor) => materializeStop(st, floor, cid));
      rebuildConnectorEdges(cid);
    }
  });
  lastCreated = { kind: 'connector' };
  setFloor(pl.returnFloor);
  setStatus(pl.connectorId ? 'Conector ampliado' : 'Conector creado', 'ok');
}

function openConnectorPopup(n, latlng) {
  const c = connectorOf(n);
  const b = currentBuildingNode();
  const stops = connectorStops(c.id);
  const floorsWith = [...new Set(stops.map(st => st.floor))];
  const nums = b ? b.pisos.map(p => p.numero) : [];
  const missing = nums.filter(f => !floorsWith.includes(f));
  const top = Math.max(...floorsWith), bottom = Math.min(...floorsWith);
  const upFloor = nums.find(f => f > top), downFloor = [...nums].reverse().find(f => f < bottom);
  const flight = isFlightType(c.tipo);
  const tipos = flight ? ['escalera', 'rampa'] : ['ascensor'];
  const html = `
    <div class="pop-edit">
      <div class="ctx-title">${flight ? 'Escalera / rampa' : 'Ascensor'}</div>
      ${flight ? `<label>Tipo</label>
      <select id="pop-con-tipo" class="form-select form-select-sm mb-2">
        ${tipos.map(k => `<option value="${k}" ${k === c.tipo ? 'selected' : ''}>${CONNECTOR_TYPES[k]}</option>`).join('')}
      </select>` : `<input type="hidden" id="pop-con-tipo" value="ascensor">`}
      <label>Nombre (opcional)</label>
      <input id="pop-con-nombre" type="text" class="form-control form-control-sm mb-2" maxlength="255" value="${escapeHtml(c.nombre || '')}">
      <div class="panel-meta mb-2">${flight ? 'Pisos' : 'Paradas'}: ${escapeHtml(floorsWith.map(f => floorLabel(f, c.building)).join(', '))}</div>
      ${flight && upFloor !== undefined ? `<button type="button" class="btn btn-sm btn-secondary w-100 mb-2" onclick="addFlight('${c.id}', 'up')">Agregar tramo hacia ${escapeHtml(floorLabel(upFloor, c.building))}</button>` : ''}
      ${flight && downFloor !== undefined ? `<button type="button" class="btn btn-sm btn-secondary w-100 mb-2" onclick="addFlight('${c.id}', 'down')">Agregar tramo desde ${escapeHtml(floorLabel(downFloor, c.building))}</button>` : ''}
      ${!flight && missing.length ? `<button type="button" class="btn btn-sm btn-secondary w-100 mb-2" onclick="addConnectorStops('${c.id}')">Agregar parada en otro piso</button>` : ''}
      <div class="pop-actions pop-actions-wrap">
        <button type="button" class="btn btn-sm btn-danger" onclick="removeConnectorStop('${n.id}')" title="Quitar este punto (Supr)">Quitar ${flight ? 'punto' : 'parada'}</button>
        <button type="button" class="btn btn-sm btn-danger" onclick="deleteConnector('${c.id}')">Eliminar conector</button>
        <span class="spacer"></span>
        <button type="button" class="btn btn-sm btn-secondary" onclick="map.closePopup()">Cancelar</button>
        <button type="button" class="btn btn-sm btn-accent" data-primary onclick="saveConnectorEdit('${c.id}')">Guardar</button>
      </div>
    </div>`;
  L.popup({ className: 'nv-popup nv-edit', autoPan: false, maxWidth: 320, minWidth: 260 }).setLatLng(latlng).setContent(html).openOn(map);
}

window.saveConnectorEdit = function (cid) {
  const tipo = document.getElementById('pop-con-tipo').value;
  const nombre = document.getElementById('pop-con-nombre').value.trim() || null;
  commit(() => {
    const c = connectors.find(x => x.id === cid);
    c.tipo = tipo;
    c.nombre = nombre;
    // los tramos (entre pisos distintos) de una escalera llevan es_escalera; las aristas dentro de un piso no
    const stops = connectorStops(cid);
    const byId = new Map(stops.map(n => [n.id, n]));
    edges.forEach(e => {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (a && b) { e.es_escalera = tipo === 'escalera' && a.floor !== b.floor; e.line.setStyle({ color: edgeColor(e) }); }
    });
    stops.forEach(applyNodeVisual);
  });
  map.closePopup();
};

// Escalera / rampa: un tramo más hacia arriba o hacia abajo del conector
window.addFlight = function (cid, dir) {
  const c = connectors.find(x => x.id === cid);
  const b = currentBuildingNode();
  const floorsWith = connectorStops(cid).map(n => n.floor);
  const nums = b.pisos.map(p => p.numero);
  const top = Math.max(...floorsWith), bottom = Math.min(...floorsWith);
  const floors = dir === 'up' ? [top, nums.find(f => f > top)] : [[...nums].reverse().find(f => f < bottom), bottom];
  map.closePopup();
  startConnectorPlacement({ connectorId: cid, tipo: c.tipo, nombre: c.nombre, floors, pattern: false });
  setStatus('Marca el inicio y el fin del tramo nuevo (puedes hacer clic en un punto del conector para usarlo)', 'ok');
};

window.addConnectorStops = function (cid) {
  const c = connectors.find(x => x.id === cid);
  const b = currentBuildingNode();
  map.closePopup();
  const have = new Set(connectorStops(cid).map(n => n.floor));
  const floors = b.pisos.map(p => p.numero).filter(f => !have.has(f));
  startConnectorPlacement({ connectorId: cid, tipo: c.tipo, nombre: c.nombre, floors, samePos: false });
  setStatus('Coloca las paradas que falten; "Omitir este piso" salta los que no correspondan', 'ok');
};

// Quitar una parada: el nodo se elimina; en un ascensor, las paradas de arriba y abajo quedan unidas
window.removeConnectorStop = function (nodeId) {
  const n = nodes.find(x => x.id === nodeId);
  if (!n) return;
  const cid = n.conector_id;
  map.closePopup();
  commit(() => {
    removeNode(nodeId);
    rebuildConnectorEdges(cid);
  });
};

// Eliminar el conector: se quitan sus tramos y uniones; los puntos sin otras conexiones se eliminan
// y los que sí tienen (usados como punto de ruta) quedan como puntos de ruta normales
window.deleteConnector = async function (cid) {
  const c = connectors.find(x => x.id === cid);
  map.closePopup();
  if (!(await window.uiConfirm(`¿Eliminar ${c.nombre || CONNECTOR_TYPES[c.tipo].toLowerCase()} y sus puntos?`, 'Eliminar conector'))) return;
  commit(() => {
    const stops = connectorStops(cid);
    const ids = new Set(stops.map(n => n.id));
    edges.filter(e => ids.has(e.from) && ids.has(e.to)).forEach(e => removeEdge(e.id));
    stops.forEach(n => {
      if (edges.some(e => e.from === n.id || e.to === n.id)) { delete n.conector_id; applyNodeVisual(n); }
      else removeNode(n.id);
    });
    connectors = connectors.filter(x => x.id !== cid);
  });
};

// =============================================================================
// Ubicar elementos (búsqueda y revisión): cambia a su edificio y piso, centra y resalta
// =============================================================================
// Lugar donde se edita un nodo: 'exterior' (campus) o el id de su edificio
function placeOf(n) {
  return n.building === 'exterior' ? 'exterior' : n.building;
}

function locateNodes(ids, { open = false } = {}) {
  const list = ids.map(id => nodes.find(n => n.id === id)).filter(Boolean);
  if (!list.length) return;
  const first = list[0];
  // Un nodo de otro alcance se abre en su editor (campus o edificio)
  if (!IS_BUILDING && placeOf(first) !== 'exterior') { openBuildingEditor(first.building, first.id); return; }
  if (IS_BUILDING && placeOf(first) === 'exterior') { openCampusEditor(first.id); return; }
  if (map) map.closePopup();
  cancelEdge();
  endRoute();
  if (IS_BUILDING) {
    if (first.building !== currentBuilding) selectBuilding(first.building);
    currentFloor = first.floor;
  }
  updateFloorSelector();
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

  // Conectores: con una sola parada, o paradas unidas solo a otras paradas (no llegan a la red de su piso)
  const lonely = connectors.filter(c => connectorStops(c.id).length < 2);
  // por piso: ningún punto del conector en ese piso está unido a la red del piso
  const unlinkedStops = [];
  connectors.forEach(c => {
    const stops = connectorStops(c.id);
    const mates = new Set(stops.map(x => x.id));
    [...new Set(stops.map(n => n.floor))].forEach(floor => {
      const here = stops.filter(n => n.floor === floor);
      const linked = here.some(n => edges.some(e => (e.from === n.id && !mates.has(e.to)) || (e.to === n.id && !mates.has(e.from))));
      if (!linked) unlinkedStops.push({ c, floor, ids: here.map(n => n.id), n: here[0] });
    });
  });

  // Nodos de un edificio que están dentro del contorno de otro (por ejemplo, creados con otro edificio elegido)
  const misplaced = [];
  nodes.forEach(n => {
    if (n.building === 'exterior' || n.type === 'building' || insideBuilding(n.latlng, n.building)) return;
    const target = nodes.find(b => b.type === 'building' && b.id !== n.building && contourOf(b.id) && insideBuilding(n.latlng, b.id));
    if (target) misplaced.push({ n, target });
  });

  return {
    isolated, components, unnamed, lonely, unlinkedStops, misplaced,
    total: isolated.length + components.length + unnamed.length + lonely.length + unlinkedStops.length + misplaced.length,
  };
}

// Mueve nodos al edificio en cuyo contorno están; si su piso no existe allí, pasan al piso de acceso
function moveToBuilding(list) {
  commit(() => {
    list.forEach(({ n, target }) => {
      const node = nodes.find(x => x.id === n.id);
      if (!node) return;
      node.building = target.id;
      if (!target.pisos.some(p => p.numero === node.floor)) node.floor = target.acceso;
      if (node.conector_id) delete node.conector_id; // un conector no cruza edificios
      applyNodeVisual(node);
    });
  });
  setStatus(list.length === 1 ? 'Nodo movido de edificio' : `${list.length} nodos movidos de edificio`, 'ok');
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
    items.forEach(({ label, ids, fix }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'review-item';
      b.textContent = label;
      b.addEventListener('click', () => locateNodes(ids));
      if (!fix) { body.appendChild(b); return; }
      const row = document.createElement('div');
      row.className = 'review-row';
      const f = document.createElement('button');
      f.type = 'button';
      f.className = 'btn btn-sm btn-secondary';
      f.textContent = fix.label;
      f.addEventListener('click', fix.run);
      row.append(b, f);
      body.appendChild(row);
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
  section('Conectores con una sola parada', 'No unen pisos: agrega otra parada o elimínalos.',
    issues.lonely.map(c => ({ label: `${c.nombre || CONNECTOR_TYPES[c.tipo]} - ${buildingName(c.building)}`, ids: connectorStops(c.id).map(n => n.id) })));
  section('Conectores sin conexión en un piso', 'En ese piso el conector no está unido a la red: desde ahí no se llega al resto.',
    issues.unlinkedStops.map(({ c, n, ids }) => ({ label: `${c.nombre || CONNECTOR_TYPES[c.tipo]} - ${placeLabel(n)}`, ids })));
  if (issues.misplaced.length) {
    section('Nodos dentro de otro edificio', 'Están asignados a un edificio pero dentro del contorno de otro.',
      issues.misplaced.map(m => ({
        label: `${m.n.name || 'Sin nombre'} - ${buildingName(m.n.building)}`,
        ids: [m.n.id],
        fix: { label: `Mover a ${m.target.name || 'edificio'}`, run: () => moveToBuilding([m]) },
      })));
    if (issues.misplaced.length > 1) {
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'btn btn-sm btn-secondary mt-1';
      all.textContent = `Mover los ${issues.misplaced.length} a su edificio`;
      all.addEventListener('click', () => moveToBuilding(issues.misplaced));
      body.appendChild(all);
    }
  }
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
  if (placement) {
    const n = h?.kind === 'node' ? nodes.find(x => x.id === h.id) : null;
    if (n && !n.ctx) return n.type === 'waypoint' && !n.conector_id ? 'Clic: usar este punto como parada' : 'Clic: parada al lado, conectada a este nodo';
    return 'Clic: parada de este piso - Esc: cancelar';
  }
  if (h?.kind === 'node' && nodes.find(x => x.id === h.id)?.ctx) {
    if (IS_BUILDING && mode === 'create') return edgeFrom || route ? 'Clic: conectar con el exterior' : 'Clic: empezar conexión desde el exterior';
    return mode === 'view' ? 'Clic: ver detalles' : (IS_BUILDING ? 'Exterior: se edita en Dibujar Mapa' : 'Interior: se edita en el editor del edificio');
  }
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
// Combinación de cambios ("como git pull --rebase"): si al publicar alguien publicó antes,
// se descarga la versión actual y se vuelven a aplicar encima solo los cambios propios,
// elemento por elemento (nodo, conexión, zona; un edificio es su nodo, con sus pisos).
// Lo que cambiaron ambos, o lo que queda inválido al combinar, se resuelve en un panel.
// =============================================================================
const MERGE_KINDS = ['nodes', 'edges', 'zones', 'connectors'];
const KIND_LABEL = { nodes: 'Nodo', edges: 'Conexión', zones: 'Zona', connectors: 'Conector' };

function mergeStates(base, mine, theirs) {
  const maps = {}, conflicts = [];
  MERGE_KINDS.forEach(kind => {
    const B = new Map(base[kind].map(x => [x.id, x]));
    const M = new Map(mine[kind].map(x => [x.id, x]));
    const T = new Map(theirs[kind].map(x => [x.id, x]));
    const R = new Map(T); // se parte de lo publicado; lo agregado por mí queda al final
    const key = (x) => (x ? JSON.stringify(x) : null);
    new Set([...B.keys(), ...M.keys()]).forEach(id => {
      const b = B.get(id), m = M.get(id), t = T.get(id);
      const bk = key(b), mk = key(m), tk = key(t);
      if (mk === bk) return;              // no lo toqué: queda lo publicado
      if (mk === tk) return;              // ambos llegamos a lo mismo
      if (tk === bk) {                    // solo yo lo cambié: se aplica lo mío
        if (m) R.set(id, m); else R.delete(id);
        return;
      }
      conflicts.push({ kind, id, mine: m || null, theirs: t || null, choice: null });
    });
    maps[kind] = R;
  });
  return { maps, conflicts };
}

function stateFromMaps(maps) {
  return {
    nodes: [...maps.nodes.values()], edges: [...maps.edges.values()], zones: [...maps.zones.values()],
    connectors: [...maps.connectors.values()],
  };
}

// Problemas que puede dejar una combinación aunque no haya conflictos directos
function integrityIssues(st) {
  const ids = new Set(st.nodes.map(n => n.id));
  const blds = new Map(st.nodes.filter(n => n.type === 'building').map(b => [b.id, b]));
  const issues = [];
  st.edges.forEach(e => {
    if (!ids.has(e.from) || !ids.has(e.to)) issues.push({ type: 'edge-orphan', kind: 'edges', id: e.id });
  });
  st.nodes.forEach(n => {
    if (n.type === 'building' || n.building === 'exterior') return;
    const b = blds.get(n.building);
    if (!b) issues.push({ type: 'node-nobuilding', kind: 'nodes', id: n.id });
    else if (!b.pisos.some(p => p.numero === n.floor)) issues.push({ type: 'node-nofloor', kind: 'nodes', id: n.id });
  });
  st.zones.forEach(z => {
    if (z.building && !blds.has(z.building)) issues.push({ type: 'zone-nobuilding', kind: 'zones', id: z.id });
  });
  const cons = new Map(st.connectors.map(c => [c.id, c]));
  st.connectors.forEach(c => {
    if (!blds.has(c.building)) issues.push({ type: 'connector-nobuilding', kind: 'connectors', id: c.id });
  });
  st.nodes.forEach(n => {
    if (!n.conector_id) return;
    const c = cons.get(n.conector_id);
    if (!c || c.building !== n.building) issues.push({ type: 'node-noconector', kind: 'nodes', id: n.id });
  });
  return issues;
}

const ISSUE_TEXT = {
  'edge-orphan': ['Une un nodo que ya no existe', 'Restaurar el nodo', 'Descartar la conexión'],
  'node-nobuilding': ['Su edificio fue eliminado', 'Pasar al exterior', 'Descartar el nodo'],
  'node-nofloor': ['Su piso ya no existe en el edificio', 'Mover al piso de acceso', 'Descartar el nodo'],
  'zone-nobuilding': ['Su edificio fue eliminado', 'Pasar al exterior', 'Descartar la zona'],
  'connector-nobuilding': ['Su edificio fue eliminado', null, 'Descartar el conector'],
  'node-noconector': ['Su conector fue eliminado o es de otro edificio', 'Dejarlo como punto de ruta', 'Descartar el nodo'],
};

// a: primera opción (conservar adaptando), b: segunda (descartar)
function resolveIssue(st, issue, option) {
  const list = st[issue.kind];
  const idx = list.findIndex(x => x.id === issue.id);
  if (idx === -1) return;
  if (option === 'b') { list.splice(idx, 1); return; }
  const el = list[idx];
  if (issue.type === 'edge-orphan') {
    const have = new Set(st.nodes.map(n => n.id));
    [el.from, el.to].filter(id => !have.has(id)).forEach(id => {
      const n = mergeSession.mineNodes.get(id) || mergeSession.baseNodes.get(id);
      if (n) st.nodes.push(n); else list.splice(list.indexOf(el), 1);
    });
  } else if (issue.type === 'node-nobuilding') {
    list[idx] = canonNode({ ...el, building: 'exterior', floor: 1 });
  } else if (issue.type === 'node-nofloor') {
    const b = st.nodes.find(n => n.id === el.building);
    list[idx] = canonNode({ ...el, floor: b.acceso });
  } else if (issue.type === 'zone-nobuilding') {
    list[idx] = canonZone({ ...el, building: null });
  } else if (issue.type === 'node-noconector') {
    list[idx] = canonNode({ ...el, conector_id: null });
  }
}

// Inicia la combinación. Devuelve 'merged' si se aplicó sin preguntar nada, o 'conflicts' si abrió el panel.
function startMerge(base, mine, theirs, theirsVersion, { keepHistory = false } = {}) {
  const { maps, conflicts } = mergeStates(canonState(base), canonState(mine), canonState(theirs));
  mergeSession = {
    maps, conflicts, issues: [], phase: 'conflicts',
    mineNodes: new Map(mine.nodes.map(n => [n.id, canonNode(n)])),
    baseNodes: new Map(base.nodes.map(n => [n.id, canonNode(n)])),
    working: null,
  };
  // La base pasa a ser lo publicado ahora: el historial anterior no corresponde a esta base
  cleanState = JSON.stringify(canonState(theirs));
  snapshotVersion = theirsVersion;
  originalNodes = new Set(theirs.nodes.filter(n => isPoiType(n.type) && n.type !== 'building').map(n => n.id));
  originalBuildings = new Set(theirs.nodes.filter(n => n.type === 'building').map(n => n.id));
  if (keepHistory) pushHistory(); else resetHistory();

  advanceMerge();
  if (!mergeSession.conflicts.length && !mergeSession.issues.length) {
    finishMerge();
    return 'merged';
  }
  setMode('view', { force: true });
  document.getElementById('merge-panel').hidden = false;
  renderMergePanel();
  setStatus('Hay cambios que resolver antes de publicar', 'warn', { sticky: true });
  return 'conflicts';
}

// Recalcula el mapa con las elecciones hechas; cuando no quedan conflictos, revisa la integridad
function advanceMerge() {
  const ms = mergeSession;
  const maps = { nodes: new Map(ms.maps.nodes), edges: new Map(ms.maps.edges), zones: new Map(ms.maps.zones), connectors: new Map(ms.maps.connectors) };
  ms.conflicts.forEach(c => {
    const pick = c.choice === 'mine' ? c.mine : c.theirs; // sin elegir aún: se muestra lo publicado
    if (pick) maps[c.kind].set(c.id, pick); else maps[c.kind].delete(c.id);
  });
  let st = stateFromMaps(maps);
  if (ms.conflicts.every(c => c.choice)) {
    ms.phase = 'issues';
    (ms.issueChoices || []).forEach(({ issue, option }) => resolveIssue(st, issue, option));
    ms.issues = integrityIssues(st);
  }
  ms.working = st;
  if (map) map.closePopup();
  clearLayers();
  buildFromState(st);
  updateBuildingSelector();
  renderMapNodes();
  markDirty();
}

function chooseConflict(i, choice) {
  mergeSession.conflicts[i].choice = choice;
  advanceMerge();
  renderMergePanel();
}

function chooseAllConflicts(choice) {
  mergeSession.conflicts.forEach(c => { c.choice = choice; });
  advanceMerge();
  renderMergePanel();
}

function chooseIssue(i, option) {
  const ms = mergeSession;
  ms.issueChoices = [...(ms.issueChoices || []), { issue: ms.issues[i], option }];
  advanceMerge();
  renderMergePanel();
}

// Volver a los conflictos para cambiar lo elegido (descarta las decisiones sobre elementos inválidos)
function backToConflicts() {
  mergeSession.phase = 'conflicts';
  mergeSession.issueChoices = [];
  mergeSession.conflicts.forEach(c => { c.choice = null; });
  advanceMerge();
  renderMergePanel();
}

function finishMerge() {
  mergeSession = null;
  document.getElementById('merge-panel').hidden = true;
  restoreBaseStatus();
  markDirty();
}

function elementLabel(kind, el) {
  if (!el) return KIND_LABEL[kind];
  if (kind === 'nodes') return `${NODE_TYPE_LABELS[el.type] || el.type}: ${el.name || 'sin nombre'}`;
  if (kind === 'zones') return `Zona: ${el.name || 'sin nombre'}`;
  if (kind === 'connectors') return `Conector: ${el.nombre || CONNECTOR_TYPES[el.tipo] || ''}`;
  const a = mergeSession.mineNodes.get(el.from) || mergeSession.working.nodes.find(n => n.id === el.from);
  const b = mergeSession.mineNodes.get(el.to) || mergeSession.working.nodes.find(n => n.id === el.to);
  return `Conexión: ${a?.name || '?'} - ${b?.name || '?'}`;
}

function conflictText(c) {
  if (!c.mine) return 'Lo eliminaste y otra persona lo modificó';
  if (!c.theirs) return 'Lo modificaste y otra persona lo eliminó';
  return 'Lo modificaste y otra persona también';
}

// Posición aproximada de un elemento (en cualquiera de sus versiones), para ubicarlo
function locateMergeItem(kind, versions) {
  const el = versions.find(Boolean);
  if (!el) return;
  if (kind === 'nodes') {
    if (nodes.some(n => n.id === el.id)) { locateNodes([el.id]); return; }
    map.setView([el.lat, el.lng], Math.max(map.getZoom(), 19));
    showMapHint(L.latLng(el.lat, el.lng), 'Aquí estaba');
    return;
  }
  if (kind === 'edges') {
    const ends = [el.from, el.to].map(id => nodes.find(n => n.id === id)?.id).filter(Boolean);
    if (ends.length) locateNodes(ends);
    return;
  }
  if (kind === 'connectors') {
    const stops = nodes.filter(n => n.conector_id === el.id).map(n => n.id);
    if (stops.length) locateNodes(stops);
    return;
  }
  const ring = el.geojson?.coordinates?.[0];
  if (ring?.length) map.fitBounds(L.latLngBounds(ring.map(([lng, lat]) => [lat, lng])), { padding: [60, 60], maxZoom: 20 });
}

function renderMergePanel() {
  const ms = mergeSession;
  const body = document.getElementById('merge-body');
  body.innerHTML = '';
  const pendingConf = ms.conflicts.filter(c => !c.choice).length;
  document.getElementById('merge-summary').textContent = ms.phase === 'conflicts'
    ? `Otra persona publicó el mapa mientras editabas. Tus demás cambios ya se combinaron; elige qué conservar en ${pendingConf === 1 ? 'este caso' : `estos ${pendingConf} casos`}.`
    : (ms.issues.length
      ? `Al combinar quedaron ${ms.issues.length === 1 ? 'un elemento inválido' : `${ms.issues.length} elementos inválidos`}. Elige qué hacer con cada uno.`
      : 'Listo: ya puedes publicar.');
  document.getElementById('merge-bulk').hidden = ms.phase !== 'conflicts';
  document.getElementById('merge-back').hidden = !(ms.phase === 'issues' && ms.conflicts.length);
  document.getElementById('merge-publish').disabled = !(ms.phase === 'issues' && !ms.issues.length);

  const item = (title, text, buttons, locate) => {
    const box = document.createElement('div');
    box.className = 'merge-item';
    const h = document.createElement('div');
    h.className = 'merge-item-title';
    h.textContent = title;
    const p = document.createElement('div');
    p.className = 'review-help';
    p.textContent = text;
    const actions = document.createElement('div');
    actions.className = 'merge-item-actions';
    buttons.forEach(({ label, active, onClick }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-sm ' + (active ? 'btn-accent' : 'btn-secondary');
      b.textContent = label;
      b.addEventListener('click', onClick);
      actions.appendChild(b);
    });
    const loc = document.createElement('button');
    loc.type = 'button';
    loc.className = 'btn btn-sm btn-link';
    loc.textContent = 'Ubicar';
    loc.addEventListener('click', locate);
    actions.appendChild(loc);
    box.append(h, p, actions);
    body.appendChild(box);
  };

  if (ms.phase === 'conflicts') {
    ms.conflicts.forEach((c, i) => item(
      elementLabel(c.kind, c.mine || c.theirs), conflictText(c),
      [
        { label: c.mine ? 'Mantener lo mío' : 'Eliminarlo', active: c.choice === 'mine', onClick: () => chooseConflict(i, 'mine') },
        { label: c.theirs ? 'Mantener lo publicado' : 'Dejarlo eliminado', active: c.choice === 'theirs', onClick: () => chooseConflict(i, 'theirs') },
      ],
      () => locateMergeItem(c.kind, [c.mine, c.theirs]),
    ));
  } else {
    ms.issues.forEach((issue, i) => {
      const el = ms.working[issue.kind].find(x => x.id === issue.id);
      const [text, a, b] = ISSUE_TEXT[issue.type];
      item(elementLabel(issue.kind, el), text,
        [a && { label: a, onClick: () => chooseIssue(i, 'a') }, { label: b, onClick: () => chooseIssue(i, 'b') }].filter(Boolean),
        () => locateMergeItem(issue.kind, [el]));
    });
  }
}

async function publishMerged() {
  if (!mergeSession || mergeSession.phase !== 'issues' || mergeSession.issues.length) return;
  finishMerge();
  publishToServer();
}

// Tras un 409: descarga lo publicado y combina. Devuelve 'merged', 'conflicts' o 'error'.
async function rebaseOnLatest(sedeId) {
  try {
    const res = await fetch(BASE_URL + `/admin/api/sedes/${sedeId}/snapshot`);
    const version = parseInt(res.headers.get('X-Snapshot-Version'), 10);
    if (!res.ok) return 'error';
    const theirs = snapshotToState(await res.json());
    return startMerge(JSON.parse(cleanState), serializeState(), theirs, version);
  } catch (err) {
    console.error(err);
    return 'error';
  }
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
  if (mergeSession) finishMerge(); // al cambiar de sede, la combinación pendiente se abandona (el borrador la conserva)
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
    if (pendingLocate) {
      const id = pendingLocate;
      pendingLocate = null;
      if (nodes.some(n => n.id === id)) locateNodes([id], { open: true });
    }
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
  currentBuilding = IS_BUILDING ? null : 'exterior';
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

  const st = snapshotToState(data);
  originalNodes = new Set(st.nodes.filter(n => isPoiType(n.type) && n.type !== 'building').map(n => n.id));
  originalBuildings = new Set(st.nodes.filter(n => n.type === 'building').map(n => n.id));
  if (!IS_BUILDING) currentBuilding = 'exterior';
  buildFromState(st);
  if (IS_BUILDING) {
    // el edificio pedido (si existe) o el primero en orden alfabético
    const wanted = st.nodes.find(n => n.type === 'building' && n.id === currentBuilding);
    const first = sortedBuildings()[0];
    currentBuilding = null;
    updateBuildingSelector(); // sin edificio elegido elige uno y lo bloquea
    if (wanted && currentBuilding !== wanted.id) selectBuilding(wanted.id);
    if (!first) renderMapNodes();
    return;
  }
  updateBuildingSelector();
  renderMapNodes();
}

// Snapshot publicado -> estado canónico del editor (con las correcciones de datos antiguos)
function snapshotToState(data) {
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

  // Conexiones con un extremo inexistente no se dibujan: tampoco forman parte del estado
  const ids = new Set(stateNodes.map(n => n.id));
  const bldIds = new Set(stateNodes.filter(n => n.type === 'building').map(n => n.id));
  const stateConnectors = (data.conectores || []).filter(c => bldIds.has(c.building));
  const conIds = new Set(stateConnectors.map(c => c.id));
  return canonState({
    nodes: stateNodes.map(n => (n.conector_id && !conIds.has(n.conector_id) ? { ...n, conector_id: null } : n)),
    edges: stateEdges.filter(e => ids.has(e.from) && ids.has(e.to)),
    zones: stateZones,
    connectors: stateConnectors,
  });
}

// Si hay avisos, primero se muestra la revisión; "Publicar de todos modos" llama con skipReview
async function publishToServer({ skipReview = false } = {}) {
  if (publishing) return;
  if (mergeSession) { setStatus('Primero resuelve los cambios combinados', 'warn'); return; }
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

    await sendPublish(sedeId);
  } finally {
    publishing = false;
  }
}

// Envía el mapa. Si alguien publicó antes (409), combina los cambios y reintenta (hasta 3 veces)
async function sendPublish(sedeId, attempt = 1) {
    setStatus('Publicando...', 'warn', { sticky: true });
    const currentNodes = new Set(nodes.filter(n => isPoiType(n.type) && n.type !== 'building').map(n => n.id));
    const currentBuildings = new Set(nodes.filter(n => n.type === 'building').map(n => n.id));
    const payload = {
      meta: { campus: sedeId, version: '2.3' },
      buildings: nodes.filter(n => n.type === 'building').map(n => ({ id: n.id, name: n.name, acceso: n.acceso, pisos: n.pisos.map(p => ({ ...p })) })),
      nodes: nodes.map(n => ({
        id: n.id, type: n.type, name: n.name, icon: n.icon, lat: n.latlng.lat, lng: n.latlng.lng, floor: parseInt(n.floor, 10), building: n.building,
        ...(isPoiType(n.type) ? { horario: n.horario, descripcion: n.descripcion, link_derivacion: n.link_derivacion } : {}),
        ...(n.conector_id ? { conector_id: n.conector_id } : {}),
      })),
      edges: edges.map(e => ({ id: e.id, from: e.from, to: e.to, weight: e.weight, es_escalera: e.es_escalera || false })),
      zonas: zones.map(z => ({ id: z.id, building: z.building, name: z.name, geojson: z.geojson, tags: z.tags, color: z.color })),
      conectores: connectors.map(c => ({ id: c.id, tipo: c.tipo, nombre: c.nombre, building: c.building })),
    };

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (snapshotVersion !== null) headers['X-Base-Version'] = String(snapshotVersion);
      const res = await fetch(BASE_URL + `/admin/api/sedes/${sedeId}/publish`, { method: 'POST', headers, body: JSON.stringify(payload) });
      if (res.status === 409 && attempt <= 3) {
        setStatus('Otra persona publicó: combinando cambios...', 'warn', { sticky: true });
        const result = await rebaseOnLatest(sedeId);
        if (result === 'merged') {
          setStatus('Se combinaron tus cambios con los publicados', 'ok');
          return sendPublish(sedeId, attempt + 1);
        }
        if (result === 'error') {
          setStatus('El mapa cambió: no se publicó', 'err');
          await window.uiAlert('Otra persona publicó el mapa y no se pudo descargar la versión actual para combinar tus cambios.\nTus cambios siguen guardados en este navegador; recarga la sede para recuperarlos.', 'No se publicó');
        }
        return; // con conflictos, el panel de combinación queda abierto
      }
      if (res.status === 409 || res.status === 422) {
        const detail = (await res.json().catch(() => ({}))).detail || '';
        setStatus(res.status === 409 ? 'El mapa cambió: no se publicó' : 'Datos inválidos: no se publicó', 'err');
        await window.uiAlert(`${detail}.\nTus cambios siguen guardados en este navegador.`, 'No se publicó');
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
}
