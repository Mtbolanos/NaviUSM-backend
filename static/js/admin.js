// ── CONFIG BASE ──
const BASE_URL = window.APP_CONFIG.rootPath;
const SEDES_INFO = window.APP_CONFIG.sedesInfo;

// Mapeo UI para POIs
const SYSTEM_TYPES = { 
  waypoint: { icon: '🔵', size: 22 }, 
  building: { icon: '🏛️', size: 30 },
  entrance: { icon: '🚪', size: 26 },
  'baño': { icon: '🚽', size: 26 },
  seguridad: { icon: '👮🏻', size: 26 },
  servicio: { icon: '🏥', size: 26 }
};

// ── STATE ──
let map, nodes = [], edges = [], mode = 'add';
let selNodeType = 'waypoint', edgeFrom = null;
let currentFloor = 1;
let nextEdgeId = 1;
let currentBuilding = 'exterior';

// ── ZONAS (zonas seguras) Y EDIFICIOS (contornos + pisos/salas) ──
const ZONE_KINDS = {
  zonaseg:  { tag: 'zona_segura',       color: '#1f7a5c' },
  edificio: { tag: 'contorno_edificio', color: '#3b6e8f' },
};
let zones = [];
let editingZoneId = null;
let drawingZonePoints = [];
let drawingZonePreviewLayer = null;
let drawingZoneVertexLayers = [];

// ── SALAS (gestión por edificio/piso, sin geometría) ──
let currentSalaEdificioId = null;
let currentSalaFloor = null;
let salasCache = [];

window.onload = async () => {
  map = L.map('map', { zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  map.on('click', onMapClick);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && (mode === 'zonaseg' || mode === 'edificio')) cancelZoneDrawing();
  });
  centrarMapaEnSede();
  loadFromServer();
};

function centrarMapaEnSede() {
  const sedeId = document.getElementById('sede-selector')?.value;
  const info = SEDES_INFO.find(s => s.id === sedeId);
  if (info) {
    map.setView([info.lat, info.lng], info.zoom);
    document.getElementById('ns-lat').value = info.lat;
    document.getElementById('ns-lng').value = info.lng;
  }
}

// ── API CRUD SEDES ──
async function submitNuevaSede() {
  const nombre = document.getElementById('ns-nombre').value.trim();
  const lat = parseFloat(document.getElementById('ns-lat').value) || map.getCenter().lat;
  const lng = parseFloat(document.getElementById('ns-lng').value) || map.getCenter().lng;
  
  if (!nombre) { alert("Ingresa un nombre para la sede"); return; }

  try {
    await fetch(BASE_URL + '/admin/api/sedes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre, lat, lng, zoom: 18 })
    });
    window.location.reload();
  } catch(e) { alert("Error al crear sede"); }
}

async function deleteCurrentSede() {
  const sedeId = document.getElementById('sede-selector')?.value;
  if(!sedeId) return;
  if(!confirm("¿Estás seguro que deseas ELIMINAR esta Sede y TODOS sus mapas? Esta acción es irreversible.")) return;

  try {
    await fetch(BASE_URL + '/admin/api/sedes/' + sedeId, { method: 'DELETE' });
    window.location.reload();
  } catch(e) { alert("Error al eliminar"); }
}

// ── MULTIPISO Y EDIFICIOS LOGIC ──
function updateBuildingSelector() {
  const sel = document.getElementById('building-selector');
  sel.innerHTML = `<option value="exterior">Campus (Exterior)</option>`;
  
  // Extraer todos los nodos que son de tipo edificio y agregarlos al select
  const blds = nodes.filter(n => n.type === 'building');
  blds.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.name || 'Edificio sin nombre';
    sel.appendChild(opt);
  });

  // Restaurar la selección actual si sigue existiendo
  if (currentBuilding === 'exterior' || blds.find(b => b.id === currentBuilding)) {
    sel.value = currentBuilding;
  } else {
    currentBuilding = 'exterior';
    sel.value = currentBuilding;
  }

  // Mostrar u ocultar el botón de configurar pisos
  document.getElementById('btn-config-pisos').style.display = currentBuilding === 'exterior' ? 'none' : 'block';
  updateFloorSelector();
}

function changeBuilding() {
  currentBuilding = document.getElementById('building-selector').value;
  document.getElementById('btn-config-pisos').style.display = currentBuilding === 'exterior' ? 'none' : 'block';
  updateFloorSelector();
  changeFloor();
}

function updateFloorSelector() {
  const floorSel = document.getElementById('floor-selector');
  floorSel.innerHTML = '';
  
  let min = 1, max = 1;
  if (currentBuilding !== 'exterior') {
    const b = nodes.find(n => n.id === currentBuilding);
    if (b) { min = b.piso_min || 1; max = b.piso_max || 4; }
  }

  for(let i = min; i <= max; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = i === 0 ? 'Planta Baja (0)' : (i < 0 ? `Subterráneo ${Math.abs(i)}` : `Nivel ${i}`);
    floorSel.appendChild(opt);
  }

  if (currentFloor < min || currentFloor > max) currentFloor = min;
  floorSel.value = currentFloor;
}

function changeFloor() {
  const floorVal = document.getElementById('floor-selector').value;
  currentFloor = floorVal ? parseInt(floorVal) : 1;
  renderMapNodes();
  cancelEdge();
}

// Lógica del mini-modal
function openFloorConfig() {
  const b = nodes.find(n => n.id === currentBuilding);
  if (!b) return;
  document.getElementById('fc-bld-name').textContent = b.name || 'Edificio';
  document.getElementById('fc-min').value = b.piso_min || 1;
  document.getElementById('fc-max').value = b.piso_max || 4;
}

function saveFloorConfig() {
  const min = parseInt(document.getElementById('fc-min').value);
  const max = parseInt(document.getElementById('fc-max').value);
  if (isNaN(min) || isNaN(max) || min > max) { alert("Niveles inválidos"); return; }

  const b = nodes.find(n => n.id === currentBuilding);
  if (b) { b.piso_min = min; b.piso_max = max; }

  const modalEl = document.getElementById('floorConfigModal');
  const modal = bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl);
  modal.hide();
  
  updateFloorSelector();
  changeFloor();
}

// Fin lógica multipiso

function renderMapNodes() {
  nodes.forEach(n => {
    if (n.floor === currentFloor) {
      n.marker.addTo(map);
    } else {
      n.marker.removeFrom(map);
    }
  });
  edges.forEach(e => {
    const fn = nodes.find(x => x.id === e.from);
    const tn = nodes.find(x => x.id === e.to);
    if (fn && tn && (fn.floor === currentFloor || tn.floor === currentFloor)) {
       e.line.addTo(map);
       if(fn.floor !== tn.floor) e.line.setStyle({ dashArray: '5, 10', color: '#f5a623' });
       else e.line.setStyle({ dashArray: null, color: '#4a9eff' });
    } else {
       e.line.removeFrom(map);
    }
  });
  document.getElementById('st-nodes').textContent = nodes.filter(n => n.floor === currentFloor).length;
}

// ── GRAPH LOGIC ──
async function publishToServer() {
  const sedeId = document.getElementById('sede-selector')?.value;
  if (!sedeId) return;
  setStatus('Publicando...', 'warn');

  const dynamicBuildings = nodes
    .filter(n => n.type === 'building')
    .map(n => ({ id: n.id, name: n.name, min: n.piso_min || 1, max: n.piso_max || 4 }));

  const payload = {
    meta: { campus: sedeId, version: '2.1' },
    buildings: dynamicBuildings, // Enviamos el array generado dinámicamente
    nodes: nodes.map(n => ({
      id: n.id, type: n.type, name: n.name, icon: n.icon, lat: n.latlng.lat, lng: n.latlng.lng, floor: n.floor, building: n.building,
      ...(n.type === 'servicio' ? { horario: n.horario, descripcion: n.descripcion, link_derivacion: n.link_derivacion } : {})
    })),
    edges: edges.map(e => ({ id: e.id, from: e.from, to: e.to, weight: e.weight })),
    zonas: zones.map(z => ({ id: z.id, building: z.building, name: z.name, geojson: z.geojson, tags: z.tags, color: z.color }))
  };

  try {
    const res = await fetch(BASE_URL + `/admin/api/sedes/${sedeId}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error();
    setStatus(`✅ Mapa Guardado`, 'ok');
  } catch (err) { setStatus('❌ Error', 'err'); }
}

async function loadFromServer() {
  const sedeId = document.getElementById('sede-selector')?.value;
  if (!sedeId) return;
  setStatus('Cargando...', 'warn');
  try {
    const res = await fetch(BASE_URL + `/api/v1/public/sedes/${sedeId}/snapshot`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    loadGraph(data);
    setStatus('✅ Grafo cargado', 'ok');
  } catch (err) {
    console.error('loadFromServer failed:', err);
    clearAll(true); setStatus('Mapa nuevo', 'ok');
  }
}

function setMode(m) {
  const wasZoneMode = mode === 'zonaseg' || mode === 'edificio';
  const isZoneMode = m === 'zonaseg' || m === 'edificio';
  if (wasZoneMode && mode !== m) cancelZoneDrawing();
  mode = m;
  document.querySelectorAll('.mmode').forEach(b => b.classList.remove('on'));
  const btnId = m === 'add' ? 'add' : m === 'edge' ? 'edge' : isZoneMode ? m : 'del';
  document.getElementById('btn-' + btnId).classList.add('on');
  if (m !== 'edge') cancelEdge();

  document.getElementById('panel-default').style.display = isZoneMode ? 'none' : '';
  document.getElementById('panel-zonaseg').style.display = m === 'zonaseg' ? '' : 'none';
  document.getElementById('panel-edificio').style.display = m === 'edificio' ? '' : 'none';

  if (isZoneMode) openZonePanel(m);
  if (m === 'edificio') refreshEdificioPanel();
}

function setSystemType(el) {
  document.querySelectorAll('.ntype').forEach(n => n.classList.remove('on'));
  el.classList.add('on');
  selNodeType = el.dataset.type;

  const nameInp = document.getElementById('node-name-input');
  if(selNodeType === 'baño') nameInp.value = "Baño";
  else if(selNodeType === 'seguridad') nameInp.value = "Puesto de Seguridad";
  else if(selNodeType === 'waypoint') nameInp.value = "";

  document.getElementById('service-fields').style.display = selNodeType === 'servicio' ? '' : 'none';
  if (selNodeType === 'servicio') {
    const iconInp = document.getElementById('node-icon-input');
    if (!iconInp.value.trim()) iconInp.value = SYSTEM_TYPES.servicio.icon;
  }
}

function onMapClick(e) {
  if (mode === 'zonaseg' || mode === 'edificio') {
    if (editingZoneId) return; // editando metadatos: no se dibuja nada nuevo
    addZoneVertex(e.latlng);
    return;
  }
  if (mode !== 'add') return;
  const rawName = document.getElementById('node-name-input').value.trim();
  const sysType = SYSTEM_TYPES[selNodeType];
  const id = crypto.randomUUID();

  const shortId = id.split('-')[0].toUpperCase();
  const name = rawName || (selNodeType === 'waypoint' ? `WP-${shortId}` : `Nodo ${shortId}`);
  const icon = (selNodeType === 'servicio' && document.getElementById('node-icon-input').value.trim()) || sysType.icon;

  const el = document.createElement('div');
  el.className = `graph-node type-${selNodeType}`;
  el.style.width = sysType.size + 'px'; el.style.height = sysType.size + 'px'; el.textContent = icon;

  const marker = L.marker(e.latlng, { icon: L.divIcon({ html: el, iconSize: [sysType.size, sysType.size], className: '' }), draggable: true }).addTo(map);
  marker.bindTooltip(name, { permanent: false, direction: 'top' });

  let extraProps = {};
  if (selNodeType === 'building') { extraProps = { piso_min: 1, piso_max: 4 }; }
  if (selNodeType === 'servicio') {
    extraProps = {
      horario: document.getElementById('node-horario-input').value.trim(),
      descripcion: document.getElementById('node-descripcion-input').value.trim(),
      link_derivacion: document.getElementById('node-link-input').value.trim(),
    };
  }

  const node = { id, type: selNodeType, name, icon, latlng: e.latlng, floor: currentFloor, building: currentBuilding, marker, el, ...extraProps };
  nodes.push(node);

  marker.on('click', (ev) => { L.DomEvent.stopPropagation(ev); onNodeClick(id); });
  marker.on('dragend', () => { node.latlng = marker.getLatLng(); rebuildLines(); });
  
  if (selNodeType === 'building') updateBuildingSelector();
  
  renderMapNodes();
}

function onNodeClick(id) {
  if (mode === 'delete') {
    const n = nodes.find(x => x.id === id);
    n.marker.removeFrom(map);
    edges.filter(e => e.from === id || e.to === id).forEach(e => e.line.removeFrom(map));
    edges = edges.filter(e => e.from !== id && e.to !== id);
    nodes = nodes.filter(x => x.id !== id);
    renderMapNodes();
    return;
  }
  if (mode === 'edge') {
    if (!edgeFrom) {
      edgeFrom = id;
      const markerEl = nodes.find(n => n.id === id).el;
      markerEl.style.boxShadow = "0 0 0 4px rgba(74, 158, 255, 0.8)";
    } else {
      if (edgeFrom !== id) addEdge(edgeFrom, id);
      cancelEdge();
    }
  }
}

function addEdge(from, to) {
  const fNode = nodes.find(n => n.id === from), tNode = nodes.find(n => n.id === to);
  const weight = map.distance(fNode.latlng, tNode.latlng);
  const penalty = Math.abs(fNode.floor - tNode.floor) * 15; 
  
  const line = L.polyline([fNode.latlng, tNode.latlng], { color: '#4a9eff', weight: 3 }).addTo(map);
  const id = crypto.randomUUID();
  line.on('click', (ev) => { L.DomEvent.stopPropagation(ev); if (mode === 'delete') { line.removeFrom(map); edges = edges.filter(e => e.id !== id); }});
  
  edges.push({ id, from, to, weight: weight + penalty, line });
  renderMapNodes();
}

function cancelEdge() {
  if(edgeFrom) {
    const n = nodes.find(x => x.id === edgeFrom);
    if(n) n.el.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.5)";
  }
  edgeFrom = null; 
}

// ── DIBUJO DE ZONAS ──
function addZoneVertex(latlng) {
  const idx = drawingZonePoints.length;
  drawingZonePoints.push([latlng.lat, latlng.lng]);

  const marker = L.marker(latlng, {
    draggable: true,
    icon: L.divIcon({ className: 'zone-vertex', iconSize: [12, 12] })
  }).addTo(map);
  marker.on('drag', () => {
    const ll = marker.getLatLng();
    drawingZonePoints[idx] = [ll.lat, ll.lng];
    redrawZonePreviewShape();
  });
  drawingZoneVertexLayers.push(marker);

  redrawZonePreviewShape();
}

function redrawZonePreviewShape() {
  if (drawingZonePreviewLayer) { drawingZonePreviewLayer.removeFrom(map); drawingZonePreviewLayer = null; }

  if (drawingZonePoints.length === 2) {
    drawingZonePreviewLayer = L.polyline(drawingZonePoints, { color: '#333', dashArray: '4,4' }).addTo(map);
  } else if (drawingZonePoints.length >= 3) {
    drawingZonePreviewLayer = L.polygon(drawingZonePoints, { color: '#333', dashArray: '4,4', fillOpacity: 0.1 }).addTo(map);
  }

  const btnSave = document.getElementById(mode + '-save-btn');
  if (btnSave) btnSave.disabled = drawingZonePoints.length < 3;
}

function cancelZoneDrawing() {
  drawingZonePoints = [];
  if (drawingZonePreviewLayer) { drawingZonePreviewLayer.removeFrom(map); drawingZonePreviewLayer = null; }
  drawingZoneVertexLayers.forEach(m => m.removeFrom(map));
  drawingZoneVertexLayers = [];
  const btnSave = document.getElementById(mode + '-save-btn');
  if (btnSave && !editingZoneId) btnSave.disabled = true;
}

function populateZoneBuildingSelect(kind) {
  const sel = document.getElementById(kind + '-building-select');
  if (!sel) return;
  sel.innerHTML = '<option value="exterior">Exterior / Campus</option>' +
    nodes.filter(n => n.type === 'building')
      .map(b => `<option value="${b.id}">${b.name}</option>`).join('');
}

function openZonePanel(kind) {
  cancelZoneDrawing();
  editingZoneId = null;
  document.getElementById(kind + '-name-input').value = '';
  populateZoneBuildingSelect(kind);
  const btnSave = document.getElementById(kind + '-save-btn');
  if (btnSave) btnSave.disabled = true;
}

function confirmZoneConfig(kind) {
  const name = document.getElementById(kind + '-name-input').value.trim() || 'Sin nombre';
  const buildingVal = document.getElementById(kind + '-building-select').value;
  const building = buildingVal === 'exterior' ? null : buildingVal;

  if (editingZoneId) {
    const zone = zones.find(z => z.id === editingZoneId);
    if (zone) {
      zone.name = name;
      zone.building = building;
      if (zone.polygon) zone.polygon.removeFrom(map);
      renderZone(zone);
    }
    openZonePanel(kind);
    return;
  }

  if (drawingZonePoints.length < 3) return;

  const shapePoints = drawingZonePoints;
  const closedPoints = [...shapePoints, shapePoints[0]];
  const geojson = { type: 'Polygon', coordinates: [closedPoints.map(([lat, lng]) => [lng, lat])] };

  const { tag, color } = ZONE_KINDS[kind];
  const zone = { id: crypto.randomUUID(), building, name, tags: [tag], color, geojson, polygon: null };
  zones.push(zone);
  renderZone(zone);

  openZonePanel(kind); // limpia el formulario y el dibujo para la siguiente
}

function shadeColor(hex, percent) {
  const num = parseInt(hex.replace('#', ''), 16);
  let r = (num >> 16) & 0xFF, g = (num >> 8) & 0xFF, b = num & 0xFF;
  const blend = (c) => Math.round(percent > 0 ? c + (255 - c) * percent : c + c * percent);
  r = Math.min(255, Math.max(0, blend(r)));
  g = Math.min(255, Math.max(0, blend(g)));
  b = Math.min(255, Math.max(0, blend(b)));
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}

function colorForZone(zone) {
  const kind = Object.values(ZONE_KINDS).find(k => zone.tags.includes(k.tag));
  return kind ? kind.color : '#888888';
}

function renderZone(zone) {
  const base = zone.color || colorForZone(zone);
  const fillColor = shadeColor(base, 0.45);
  const borderColor = shadeColor(base, -0.25);
  zone.polygon = L.geoJSON(zone.geojson, {
    style: { color: borderColor, fillColor, fillOpacity: 0.45, weight: 2 }
  }).addTo(map);
  zone.polygon.on('click', (ev) => { L.DomEvent.stopPropagation(ev); onZoneClick(zone.id); });
}

function onZoneClick(id) {
  const zone = zones.find(z => z.id === id);
  if (!zone) return;

  if (mode === 'delete') {
    if (zone.polygon) zone.polygon.removeFrom(map);
    zones = zones.filter(z => z.id !== id);
    return;
  }

  if (mode === 'zonaseg' || mode === 'edificio') {
    const kind = ZONE_KINDS[mode];
    if (!zone.tags.includes(kind.tag)) return; // no es del tipo de este modo, se ignora
    cancelZoneDrawing();
    editingZoneId = id;
    populateZoneBuildingSelect(mode);
    document.getElementById(mode + '-name-input').value = zone.name;
    document.getElementById(mode + '-building-select').value = zone.building || 'exterior';
    const btnSave = document.getElementById(mode + '-save-btn');
    if (btnSave) btnSave.disabled = false;
  }
}

// ── EDIFICIOS: pisos y salas ──
async function refreshEdificioPanel() {
  const buildingVal = document.getElementById('edificio-building-select').value;
  currentSalaEdificioId = buildingVal === 'exterior' ? null : buildingVal;

  const section = document.getElementById('edificio-salas-section');
  if (!currentSalaEdificioId) { section.style.display = 'none'; return; }
  section.style.display = '';

  const b = nodes.find(n => n.id === currentSalaEdificioId);
  const min = b?.piso_min ?? 1, max = b?.piso_max ?? 4;
  document.getElementById('edificio-piso-min').value = min;
  document.getElementById('edificio-piso-max').value = max;

  if (currentSalaFloor === null || currentSalaFloor < min || currentSalaFloor > max) currentSalaFloor = min;

  const tabsEl = document.getElementById('edificio-piso-tabs');
  tabsEl.innerHTML = '';
  for (let p = min; p <= max; p++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-ed btn-ed-ghost piso-tab' + (p === currentSalaFloor ? ' on' : '');
    btn.textContent = 'Piso ' + p;
    btn.onclick = () => { currentSalaFloor = p; refreshEdificioPanel(); };
    tabsEl.appendChild(btn);
  }

  await loadSalas();
}

function saveEdificioPisos() {
  const min = parseInt(document.getElementById('edificio-piso-min').value);
  const max = parseInt(document.getElementById('edificio-piso-max').value);
  if (isNaN(min) || isNaN(max) || min > max) { alert('Niveles inválidos'); return; }
  const b = nodes.find(n => n.id === currentSalaEdificioId);
  if (b) { b.piso_min = min; b.piso_max = max; }
  currentSalaFloor = min;
  refreshEdificioPanel();
}

async function loadSalas() {
  if (!currentSalaEdificioId) return;
  try {
    salasCache = await (await fetch(BASE_URL + `/admin/api/edificios/${currentSalaEdificioId}/salas`)).json();
  } catch (err) {
    console.error('loadSalas failed:', err);
    salasCache = [];
  }
  renderSalasList();
}

function renderSalasList() {
  const list = document.getElementById('edificio-salas-list');
  const salas = salasCache.filter(s => s.piso === currentSalaFloor);
  list.innerHTML = salas.length
    ? salas.map(s => `
        <div class="sala-row">
          <span>${s.nombre}</span>
          <button class="btn-ed btn-ed-danger" style="padding:2px 8px;" onclick="deleteSalaRow('${s.id}')">✕</button>
        </div>`).join('')
    : '<p class="text-muted" style="font-size:11px;">Sin salas en este piso.</p>';
}

async function addSala() {
  const input = document.getElementById('edificio-sala-name-input');
  const nombre = input.value.trim();
  if (!nombre || !currentSalaEdificioId) return;
  try {
    await fetch(BASE_URL + `/admin/api/edificios/${currentSalaEdificioId}/salas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ piso: currentSalaFloor, nombre }),
    });
    input.value = '';
    await loadSalas();
  } catch (err) { console.error('addSala failed:', err); }
}

async function deleteSalaRow(id) {
  try {
    await fetch(BASE_URL + `/admin/api/salas/${id}`, { method: 'DELETE' });
    await loadSalas();
  } catch (err) { console.error('deleteSalaRow failed:', err); }
}

function clearAll(silent = false) {
  if (!silent && !confirm('¿Vaciar todos los nodos del PISO ACTUAL?')) return;
  const toDelete = nodes.filter(n => n.floor === currentFloor).map(n => n.id);
  toDelete.forEach(id => {
    nodes.find(n => n.id === id).marker.removeFrom(map);
    edges.filter(e => e.from === id || e.to === id).forEach(e => e.line.removeFrom(map));
    edges = edges.filter(e => e.from !== id && e.to !== id);
    nodes = nodes.filter(n => n.id !== id);
  });
  cancelEdge(); renderMapNodes();
}

function rebuildLines() {
  edges.forEach(e => {
    const fn = nodes.find(n => n.id === e.from), tn = nodes.find(n => n.id === e.to);
    e.line.setLatLngs([fn.latlng, tn.latlng]);
  });
}

function loadGraph(data) {
  nodes.forEach(n => n.marker.removeFrom(map)); edges.forEach(e => e.line.removeFrom(map));
  zones.forEach(z => z.polygon && z.polygon.removeFrom(map));
  nodes = []; edges = []; zones = [];
  
  if (!data.nodes || !data.edges) return;

  // 1. Migrador automático a UUIDs para mapas antiguos
  const idMap = {};
  const isUUID = (str) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
  
  data.buildings = (data.buildings || []).map(b => {
    if (b.id !== 'exterior' && !isUUID(b.id)) {
      const newId = crypto.randomUUID(); idMap[b.id] = newId; b.id = newId;
    }
    return b;
  });

  data.nodes = data.nodes.map(n => {
    if (!isUUID(n.id)) {
      const newId = crypto.randomUUID(); idMap[n.id] = newId; n.id = newId;
    }
    if (n.building && idMap[n.building]) n.building = idMap[n.building];
    return n;
  });

  data.edges = data.edges.map(e => {
    if (!isUUID(e.id)) e.id = crypto.randomUUID();
    if (idMap[e.from]) e.from = idMap[e.from];
    if (idMap[e.to]) e.to = idMap[e.to];
    return e;
  });

  // 2. Restaurar edificios
  if (data.buildings && data.buildings.length > 0) {
    buildings = data.buildings;
  } else {
    buildings = [{ id: 'exterior', name: 'Campus (Exterior)', min: 1, max: 1 }];
  }
  currentBuilding = buildings[0].id;
  updateFloorSelector();

  data.nodes.forEach(n => {
    // Si el nodo es edificio, le pegamos sus pisos leyendo la data del backend
    if (n.type === 'building') {
      const bData = (data.buildings || []).find(b => b.id === n.id);
      n.piso_min = bData ? bData.min : 1;
      n.piso_max = bData ? bData.max : 4;
    }
    const sysType = SYSTEM_TYPES[n.type] || SYSTEM_TYPES['waypoint'];
    const el = document.createElement('div');
    el.className = `graph-node type-${n.type}`;
    el.style.width = sysType.size + 'px'; el.style.height = sysType.size + 'px'; el.textContent = n.icon || sysType.icon;
    
    const marker = L.marker([n.lat, n.lng], { icon: L.divIcon({ html: el, iconSize: [sysType.size, sysType.size], className: '' }), draggable: true });
    marker.bindTooltip(n.name, { permanent: false, direction: 'top' });
    
    const floor = n.floor !== undefined ? n.floor : 1;
    const building = n.building || 'exterior';
    const serviceProps = n.type === 'servicio'
      ? { horario: n.horario, descripcion: n.descripcion, link_derivacion: n.link_derivacion }
      : {};
    const node = { id: n.id, type: n.type, name: n.name, icon: n.icon, latlng: L.latLng(n.lat, n.lng), floor, building, marker, el, ...serviceProps };
    nodes.push(node);
    
    marker.on('click', (ev) => { L.DomEvent.stopPropagation(ev); onNodeClick(n.id); });
    marker.on('dragend', () => { node.latlng = marker.getLatLng(); rebuildLines(); });
  });
  
  data.edges.forEach(e => {
    const fn = nodes.find(x => x.id === e.from), tn = nodes.find(x => x.id === e.to);
    if (!fn || !tn) return;
    const line = L.polyline([fn.latlng, tn.latlng], { color: '#4a9eff', weight: 3 });
    line.on('click', (ev) => { L.DomEvent.stopPropagation(ev); if (mode === 'delete') { line.removeFrom(map); edges = edges.filter(x => x.id !== e.id); }});
    edges.push({ id: e.id, from: e.from, to: e.to, weight: e.weight, line });
    const num = parseInt(e.id.replace('E', '')); if (!isNaN(num) && num >= nextEdgeId) nextEdgeId = num + 1;
  });
  
  zones = (data.zonas || []).map(z => ({
    id: z.id, building: z.building, name: z.name, tags: z.tags || [], color: z.color, geojson: z.geojson, polygon: null
  }));
  zones.forEach(renderZone);

  updateBuildingSelector();
  renderMapNodes();
}

function setStatus(msg, state) {
  document.getElementById('status-txt').textContent = msg;
  document.getElementById('sdot').className = 's-dot' + (state === 'warn' ? ' warn' : '');
}