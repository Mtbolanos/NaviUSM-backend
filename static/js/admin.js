// ── CONFIG BASE ──
const BASE_URL = window.APP_CONFIG.rootPath;
const SEDES_INFO = window.APP_CONFIG.sedesInfo;

// Mapeo UI para POIs
const SYSTEM_TYPES = { 
  waypoint: { icon: '🔵', size: 22 }, 
  user: { icon: '📍', size: 18 },
  building: { icon: '🏛️', size: 30 },
  entrance: { icon: '🚪', size: 26 },
  'baño': { icon: '🚽', size: 26 },
  seguridad: { icon: '👮🏻', size: 26 }
};

// ── STATE ──
let map, nodes = [], edges = [], mode = 'add';
let selNodeType = 'waypoint', edgeFrom = null;
let nextNodeId = 1, nextEdgeId = 1;
let currentFloor = 1;

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

// ── MULTIPISO LOGIC ──
function changeFloor() {
  currentFloor = parseInt(document.getElementById('floor-selector').value);
  renderMapNodes();
  cancelEdge();
}

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

  const payload = {
    meta: { campus: sedeId, version: '2.1' },
    nodes: nodes.map(n => ({ id: n.id, type: n.type, name: n.name, icon: n.icon, lat: n.latlng.lat, lng: n.latlng.lng, floor: n.floor })),
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
  else if(selNodeType === 'waypoint' || selNodeType === 'user') nameInp.value = "";
}

function onMapClick(e) {
  if (mode !== 'add') return;
  const rawName = document.getElementById('node-name-input').value.trim();
  const name = rawName || (selNodeType === 'waypoint' ? `WP-${nextNodeId}` : `Nodo ${nextNodeId}`);
  const sysType = SYSTEM_TYPES[selNodeType];
  const id = 'N' + (nextNodeId++);

  const el = document.createElement('div');
  el.className = `graph-node type-${selNodeType}`;
  el.style.width = sysType.size + 'px'; el.style.height = sysType.size + 'px'; el.textContent = sysType.icon;

  const marker = L.marker(e.latlng, { icon: L.divIcon({ html: el, iconSize: [sysType.size, sysType.size], className: '' }), draggable: true }).addTo(map);
  marker.bindTooltip(name, { permanent: false, direction: 'top' });
  
  const node = { id, type: selNodeType, name, icon: sysType.icon, latlng: e.latlng, floor: currentFloor, marker, el };
  nodes.push(node);

  marker.on('click', (ev) => { L.DomEvent.stopPropagation(ev); onNodeClick(id); });
  marker.on('dragend', () => { node.latlng = marker.getLatLng(); rebuildLines(); });
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
  const id = 'E' + (nextEdgeId++);
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
  nodes = []; edges = []; nextNodeId = 1; nextEdgeId = 1;
  
  if (!data.nodes || !data.edges) return;
  data.nodes.forEach(n => {
    const sysType = SYSTEM_TYPES[n.type] || SYSTEM_TYPES['waypoint'];
    const el = document.createElement('div');
    el.className = `graph-node type-${n.type}`;
    el.style.width = sysType.size + 'px'; el.style.height = sysType.size + 'px'; el.textContent = n.icon || sysType.icon;
    
    const marker = L.marker([n.lat, n.lng], { icon: L.divIcon({ html: el, iconSize: [sysType.size, sysType.size], className: '' }), draggable: true });
    marker.bindTooltip(n.name, { permanent: false, direction: 'top' });
    
    const floor = n.floor !== undefined ? n.floor : 1;
    const node = { id: n.id, type: n.type, name: n.name, icon: n.icon, latlng: L.latLng(n.lat, n.lng), floor, marker, el };
    nodes.push(node);
    
    marker.on('click', (ev) => { L.DomEvent.stopPropagation(ev); onNodeClick(n.id); });
    marker.on('dragend', () => { node.latlng = marker.getLatLng(); rebuildLines(); });
    const num = parseInt(n.id.replace('N', '')); if (!isNaN(num) && num >= nextNodeId) nextNodeId = num + 1;
  });
  
  data.edges.forEach(e => {
    const fn = nodes.find(x => x.id === e.from), tn = nodes.find(x => x.id === e.to);
    if (!fn || !tn) return;
    const line = L.polyline([fn.latlng, tn.latlng], { color: '#4a9eff', weight: 3 });
    line.on('click', (ev) => { L.DomEvent.stopPropagation(ev); if (mode === 'delete') { line.removeFrom(map); edges = edges.filter(x => x.id !== e.id); }});
    edges.push({ id: e.id, from: e.from, to: e.to, weight: e.weight, line });
    const num = parseInt(e.id.replace('E', '')); if (!isNaN(num) && num >= nextEdgeId) nextEdgeId = num + 1;
  });
  
  renderMapNodes();
}

function setStatus(msg, state) {
  document.getElementById('status-txt').textContent = msg;
  document.getElementById('sdot').className = 's-dot' + (state === 'warn' ? ' warn' : '');
}