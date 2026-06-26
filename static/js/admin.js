// ── CONFIG BASE ──
const BASE_URL = window.APP_CONFIG.rootPath;
const SEDES_INFO = window.APP_CONFIG.sedesInfo;

// Mapeo UI para POIs
const SYSTEM_TYPES = { 
  waypoint: { icon: '🔵', size: 22 }, 
  building: { icon: '🏛️', size: 30 },
  entrance: { icon: '🚪', size: 26 },
  'baño': { icon: '🚽', size: 26 },
  seguridad: { icon: '👮🏻', size: 26 }
};

// ── STATE ──
let map, nodes = [], edges = [], mode = 'add';
let selNodeType = 'waypoint', edgeFrom = null;
let currentFloor = 1;
let currentBuilding = 'exterior';

window.onload = () => {
  map = L.map('map', { zoomControl: true });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 20 }).addTo(map);
  map.on('click', onMapClick);
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
    nodes: nodes.map(n => ({ id: n.id, type: n.type, name: n.name, icon: n.icon, lat: n.latlng.lat, lng: n.latlng.lng, floor: n.floor, building: n.building })),
    edges: edges.map(e => ({ id: e.id, from: e.from, to: e.to, weight: e.weight }))
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
    clearAll(true); setStatus('Mapa nuevo', 'ok');
  }
}

function setMode(m) {
  mode = m;
  document.querySelectorAll('.mmode').forEach(b => b.classList.remove('on'));
  document.getElementById('btn-' + (m === 'add' ? 'add' : m === 'edge' ? 'edge' : 'del')).classList.add('on');
  if (m !== 'edge') cancelEdge();
}

function setSystemType(el) {
  document.querySelectorAll('.ntype').forEach(n => n.classList.remove('on'));
  el.classList.add('on');
  selNodeType = el.dataset.type;
  
  const nameInp = document.getElementById('node-name-input');
  if(selNodeType === 'baño') nameInp.value = "Baño";
  else if(selNodeType === 'seguridad') nameInp.value = "Puesto de Seguridad";
  else if(selNodeType === 'waypoint') nameInp.value = "";
}

function onMapClick(e) {
  if (mode !== 'add') return;
  const rawName = document.getElementById('node-name-input').value.trim();
  const sysType = SYSTEM_TYPES[selNodeType];
  const id = crypto.randomUUID();

  const shortId = id.split('-')[0].toUpperCase();
  const name = rawName || (selNodeType === 'waypoint' ? `WP-${shortId}` : `Nodo ${shortId}`);

  const el = document.createElement('div');
  el.className = `graph-node type-${selNodeType}`;
  el.style.width = sysType.size + 'px'; el.style.height = sysType.size + 'px'; el.textContent = sysType.icon;

  const marker = L.marker(e.latlng, { icon: L.divIcon({ html: el, iconSize: [sysType.size, sysType.size], className: '' }), draggable: true }).addTo(map);
  marker.bindTooltip(name, { permanent: false, direction: 'top' });
  
  let extraProps = {};
  if (selNodeType === 'building') { extraProps = { piso_min: 1, piso_max: 4 }; }

  const node = { id, type: selNodeType, name, icon: sysType.icon, latlng: e.latlng, floor: currentFloor, building: currentBuilding, marker, el, ...extraProps };
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
  nodes = []; edges = [];
  
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
  renderBuildingListModal();
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
    const node = { id: n.id, type: n.type, name: n.name, icon: n.icon, latlng: L.latLng(n.lat, n.lng), floor, building, marker, el };
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
  
  updateBuildingSelector();
  renderMapNodes();
}

function setStatus(msg, state) {
  document.getElementById('status-txt').textContent = msg;
  document.getElementById('sdot').className = 's-dot' + (state === 'warn' ? ' warn' : '');
}