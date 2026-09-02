let graphData = null;

async function fetchLatestGraph() {
  const sedeId = window.APP_CONFIG.sedeId;
  const rootPath = window.APP_CONFIG.rootPath;
  try {
    const res = await fetch(`${rootPath}/api/v1/public/sedes/${sedeId}/snapshot`);
    if (!res.ok) throw new Error('Grafo no disponible');
    graphData = await res.json();
    initMap();
  } catch (err) {
    console.error(err);
    document.getElementById('s-map').innerHTML = `
      <div style="padding: 50px 20px; text-align: center; color: white;">
        <h3>Error</h3><p>No se pudo descargar el mapa de la sede. Verifica la conexión o si el administrador ha publicado el mapa.</p>
      </div>`;
  }
}

// ══════════════════════════════════════════════════════════
// TYPE METADATA — qué tipos de nodo son seleccionables/visibles
// ══════════════════════════════════════════════════════════
const VISIBLE_TYPES = ['building', 'entrance', 'baño', 'seguridad'];
const TYPE_LABELS = {
  building: 'Edificio',
  entrance: 'Entrada',
  'baño':   'Baño',
  seguridad:'Seguridad',
  user:     'Tú',
  waypoint: ''
};

// ══════════════════════════════════════════════════════════
// GRAPH DATA & STATE
// ══════════════════════════════════════════════════════════
let mapMain     = null;
let mapRoute    = null;
let nodeMarkers = {};       // nodeId → { marker, el, data }
let selectedNode = null;

// ══════════════════════════════════════════════════════════
// A* PATHFINDING
// ══════════════════════════════════════════════════════════
function astar(graph, startId, goalId) {
  // Build adjacency list from edges (bidirectional)
  const adj = {};
  graph.nodes.forEach(n => { adj[n.id] = []; });
  graph.edges.forEach(e => {
    adj[e.from]?.push({ id: e.to,   cost: e.weight });
    adj[e.to]?.push  ({ id: e.from, cost: e.weight });
  });

  // Heuristic: haversine distance to goal
  const nodeMap = {};
  graph.nodes.forEach(n => { nodeMap[n.id] = n; });
  const goal = nodeMap[goalId];
  if (!goal) return null;

  function h(nodeId) {
    const n = nodeMap[nodeId];
    if (!n) return Infinity;
    return haversine(n.lat, n.lng, goal.lat, goal.lng);
  }

  const open   = new Set([startId]);
  const cameFrom  = {};
  const gScore = {}; graph.nodes.forEach(n => { gScore[n.id] = Infinity; });
  const fScore = {}; graph.nodes.forEach(n => { fScore[n.id] = Infinity; });
  gScore[startId] = 0;
  fScore[startId] = h(startId);

  while (open.size > 0) {
    let current = null;
    let bestF = Infinity;
    open.forEach(id => { if (fScore[id] < bestF) { bestF = fScore[id]; current = id; } });

    if (current === goalId) {
      const path = [goalId];
      let cur = goalId;
      while (cameFrom[cur]) { cur = cameFrom[cur]; path.unshift(cur); }
      const totalDist = gScore[goalId];
      return { path, totalDist, nodes: path.map(id => nodeMap[id]) };
    }

    open.delete(current);

    const neighbors = adj[current] || [];
    for (const { id: nid, cost } of neighbors) {
      const tentG = gScore[current] + cost;
      if (tentG < gScore[nid]) {
        cameFrom[nid] = current;
        gScore[nid]   = tentG;
        fScore[nid]   = tentG + h(nid);
        open.add(nid);
      }
    }
  }
  return null;
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ══════════════════════════════════════════════════════════
// LOAD GRAPH
// ══════════════════════════════════════════════════════════
function loadGraph(data) {
  graphData = data;
  if (mapMain) initNodeMarkers();
}

// ══════════════════════════════════════════════════════════
// NAV & SCREEN
// ══════════════════════════════════════════════════════════
function go(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if (id === 's-map' && mapMain) setTimeout(() => mapMain.invalidateSize(), 100);
  if (id === 's-route' && mapRoute) setTimeout(() => mapRoute.invalidateSize(), 100);
}

function enterApp() {
  go('s-map');
  fetchLatestGraph();
}

// ══════════════════════════════════════════════════════════
// MAIN MAP
// ══════════════════════════════════════════════════════════
function initMap() {
  if (mapMain) { mapMain.invalidateSize(); return; }

  const graph = graphData || { nodes: [], edges: [] };
  const center = getUserNode(graph) || { lat: -33.0250, lng: -71.5522 };

  mapMain = L.map('map', { zoomControl: false, attributionControl: false })
    .setView([center.lat, center.lng], 18);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(mapMain);

  initNodeMarkers();
}

function getUserNode(graph) {
  return graph.nodes.find(n => n.type === 'user');
}

function initNodeMarkers() {
  Object.values(nodeMarkers).forEach(({ marker }) => marker.removeFrom(mapMain));
  nodeMarkers = {};

  if (mapMain._graphEdgeLayer) { mapMain._graphEdgeLayer.clearLayers(); }
  else { mapMain._graphEdgeLayer = L.layerGroup().addTo(mapMain); }

  const graph = graphData || { nodes: [], edges: [] };

  graph.nodes.forEach(n => {
    let marker, el;

    if (n.type === 'user') {
      el = document.createElement('div');
      el.innerHTML = `
        <div style="position:relative;width:22px;height:22px">
          <div style="position:absolute;inset:0;background:rgba(66,133,244,0.2);border-radius:50%;animation:gpsRing 2s ease-out infinite"></div>
          <div style="position:absolute;inset:4px;background:#4285f4;border:2.5px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.35)"></div>
        </div>`;
      const icon = L.divIcon({ className:'', html: el, iconSize:[22,22], iconAnchor:[11,11] });
      marker = L.marker([n.lat, n.lng], { icon, zIndexOffset: 2000 }).addTo(mapMain);

    } else if (VISIBLE_TYPES.includes(n.type)) {
      el = document.createElement('div');
      el.style.cssText = `
        display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer;`;
      el.innerHTML = `
        <div class="gmap-pin type-${n.type}">
          <span style="font-size:${n.type==='building'?'16':'13'}px">${n.icon || '📍'}</span>
        </div>
        <div class="gmap-label">${n.name}</div>`;
      const size = n.type === 'building' ? 36 : 28;
      const icon = L.divIcon({ className:'', html: el, iconSize:[size,44], iconAnchor:[size/2, size+10] });
      marker = L.marker([n.lat, n.lng], { icon }).addTo(mapMain);
      marker.on('click', () => selectGraphNode(n));

    } else {
      el = document.createElement('div');
      marker = L.marker([n.lat, n.lng], {
        icon: L.divIcon({ className:'', html:'<div style="width:1px;height:1px;opacity:0"></div>', iconSize:[1,1] }),
        interactive: false, keyboard: false,
      });
    }

    nodeMarkers[n.id] = { marker, el, data: n };
  });

  const visCoords = graph.nodes
    .filter(n => n.type !== 'waypoint')
    .map(n => [n.lat, n.lng]);
  if (visCoords.length > 1) mapMain.fitBounds(visCoords, { padding: [50, 50] });
  else if (visCoords.length === 1) mapMain.setView(visCoords[0], 18);
}

// ══════════════════════════════════════════════════════════
// SELECT NODE
// ══════════════════════════════════════════════════════════
function selectGraphNode(nodeData) {
  if (selectedNode) {
    const prev = nodeMarkers[selectedNode]?.el;
    if (prev) prev.querySelector('.gmap-pin')?.classList.remove('selected');
  }
  selectedNode = nodeData.id;

  const cur = nodeMarkers[nodeData.id]?.el;
  if (cur) cur.querySelector('.gmap-pin')?.classList.add('selected');

  document.getElementById('bcard-ico').textContent  = nodeData.icon || '📍';
  document.getElementById('bcard-name').textContent = nodeData.name;
  document.getElementById('bcard-desc').textContent = '~' + (nodeMarkers[nodeData.id] ? estimateDist(nodeData) : '—') + ' · Toca "Ir" para navegar';

  const card = document.getElementById('bcard');
  card.classList.remove('show');
  setTimeout(() => card.classList.add('show'), 10);
}

function estimateDist(destNode) {
  const graph = graphData || { nodes: [], edges: [] };
  const userNode = getUserNode(graph);
  if (!userNode) return '—';
  const result = astar(graph, userNode.id, destNode.id);
  if (!result) return '—';
  const m = Math.round(result.totalDist);
  const min = Math.max(1, Math.round(m / 80));
  return m + 'm · ' + min + ' min';
}

// ══════════════════════════════════════════════════════════
// ROUTE — A*
// ══════════════════════════════════════════════════════════
function routeTo() {
  if (!selectedNode) { toast('❌ No hay nodo seleccionado'); return; }
  const graph = graphData || { nodes: [], edges: [] };
  const userNode = getUserNode(graph);
  if (!userNode) { toast('❌ Sin nodo de usuario en el grafo'); return; }

  const result = astar(graph, userNode.id, selectedNode);
  if (!result) { toast('❌ Sin ruta disponible — revisa el grafo'); return; }

  const destData = graph.nodes.find(n => n.id === selectedNode);
  go('s-route');

  document.getElementById('r-dest').textContent = destData.name;
  const m = Math.round(result.totalDist);
  const min = Math.max(1, Math.round(m / 80));
  document.getElementById('r-dist').textContent = m + 'm';
  document.getElementById('r-time').textContent = min + ' min';

  setTimeout(() => renderRouteMap(result, destData), 200);
}

function renderRouteMap(result, destData) {
  if (mapRoute) { mapRoute.remove(); mapRoute = null; }

  const graph = graphData || { nodes: [], edges: [] };
  const userNode = getUserNode(graph);
  const pathCoords = result.nodes.map(n => [n.lat, n.lng]);

  mapRoute = L.map('route-map', { zoomControl: false, attributionControl: false })
    .setView(pathCoords[0], 18);

  setTimeout(() => mapRoute && mapRoute.invalidateSize(), 300);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(mapRoute);

  L.polyline(pathCoords, {
    color: '#ffffff', weight: 13, opacity: 0.9, lineCap: 'round', lineJoin: 'round'
  }).addTo(mapRoute);
  
  L.polyline(pathCoords, {
    color: '#4285f4', weight: 7, opacity: 1, lineCap: 'round', lineJoin: 'round'
  }).addTo(mapRoute);

  if (userNode) {
    const uHtml = `
      <div style="position:relative;width:22px;height:22px">
        <div style="position:absolute;inset:0;background:rgba(66,133,244,0.2);border-radius:50%;animation:gpsRing 2s ease-out infinite"></div>
        <div style="position:absolute;inset:4px;background:#4285f4;border:2.5px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.35)"></div>
      </div>`;
    const uIcon = L.divIcon({ className:'', html: uHtml, iconSize:[22,22], iconAnchor:[11,11] });
    L.marker([userNode.lat, userNode.lng], { icon: uIcon, zIndexOffset: 2000 }).addTo(mapRoute);
  }

  if (destData) {
    const dHtml = `
      <div style="display:flex;flex-direction:column;align-items:center">
        <div style="
          background:white; border-radius:50%; width:40px; height:40px;
          display:flex;align-items:center;justify-content:center;font-size:20px;
          box-shadow:0 3px 14px rgba(0,0,0,0.25);border:2px solid #e8eaed">
          ${destData.icon || '📍'}
        </div>
        <div style="
          background:white;border-radius:4px;padding:3px 8px;margin-top:4px;
          font-size:11px;font-weight:600;color:#202124;font-family:'Space Grotesk',sans-serif;
          box-shadow:0 2px 6px rgba(0,0,0,0.2);white-space:nowrap">
          ${destData.name}
        </div>
      </div>`;
    const dIcon = L.divIcon({ className:'', html: dHtml, iconSize:[120,56], iconAnchor:[20,20] });
    L.marker([destData.lat, destData.lng], { icon: dIcon, zIndexOffset: 1000 }).addTo(mapRoute);
  }

  mapRoute.fitBounds(pathCoords, { padding: [60, 60] });
  buildSteps(result);
}

// ══════════════════════════════════════════════════════════
// STEPS — instrucciones por giros
// ══════════════════════════════════════════════════════════
function bearing(lat1, lng1, lat2, lng2) {
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function turnAngle(b1, b2) {
  let d = b2 - b1;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

const TURN_THRESHOLD_DEG = 25;
const MAX_STEPS = 5;

function buildSteps(result) {
  const nodes = result.nodes;

  if (nodes.length < 2) {
    document.getElementById('steps-list').innerHTML =
      `<div class="step-row">
         <div class="snum cur">1</div>
         <div class="step-body"><div class="st">¡Ya estás en ${nodes[0]?.name || 'el destino'}!</div></div>
       </div>`;
    return;
  }

  const candidates = [];
  for (let i = 1; i < nodes.length - 1; i++) {
    const prev = nodes[i - 1], cur = nodes[i], nxt = nodes[i + 1];
    const b1 = bearing(prev.lat, prev.lng, cur.lat, cur.lng);
    const b2 = bearing(cur.lat, cur.lng, nxt.lat, nxt.lng);
    const angle = turnAngle(b1, b2);
    if (Math.abs(angle) >= TURN_THRESHOLD_DEG) {
      candidates.push({ idx: i, angle, dir: angle > 0 ? 'derecha' : 'izquierda' });
    }
  }

  const maxTurns = MAX_STEPS - 2;
  let turns = candidates;
  if (turns.length > maxTurns) {
    turns = [...candidates]
      .sort((a, b) => Math.abs(b.angle) - Math.abs(a.angle))
      .slice(0, maxTurns)
      .sort((a, b) => a.idx - b.idx);
  }

  const steps = [];
  steps.push({ cls: 'done', label: 'Sal desde ' + nodes[0].name, sublabel: '' });

  let anchorIdx = 0;
  for (const t of turns) {
    let dist = 0;
    for (let j = anchorIdx; j < t.idx; j++) {
      dist += haversine(nodes[j].lat, nodes[j].lng, nodes[j + 1].lat, nodes[j + 1].lng);
    }
    steps.push({
      cls: 'todo',
      label: `Avanza ~${Math.round(dist)}m y gira a la ${t.dir}`,
      sublabel: ''
    });
    anchorIdx = t.idx;
  }

  let finalDist = 0;
  for (let j = anchorIdx; j < nodes.length - 1; j++) {
    finalDist += haversine(nodes[j].lat, nodes[j].lng, nodes[j + 1].lat, nodes[j + 1].lng);
  }
  const destName = nodes[nodes.length - 1].name;
  const finalLabel = turns.length === 0
    ? `Avanza ~${Math.round(finalDist)}m hasta ${destName}`
    : `¡Llegaste a ${destName}!`;
  const finalSub = turns.length === 0 ? '' : `~${Math.round(finalDist)}m restantes`;
  steps.push({ cls: 'cur', label: finalLabel, sublabel: finalSub });

  document.getElementById('steps-list').innerHTML = steps.map((s, i) => `
    <div class="step-row">
      <div class="snum ${s.cls}">${i + 1}</div>
      <div class="step-body">
        <div class="st">${s.label}</div>
        ${s.sublabel ? `<div class="sd">${s.sublabel}</div>` : ''}
      </div>
    </div>`).join('');
}

function clearRoute() {
  if (selectedNode) {
    const prev = nodeMarkers[selectedNode]?.el;
    if (prev) prev.querySelector('.gmap-pin')?.classList.remove('selected');
    selectedNode = null;
  }
  document.getElementById('bcard').classList.remove('show');
}

function arrive() {
  go('s-map');
  clearRoute();
  toast('✅ ¡Llegaste a ' + document.getElementById('r-dest').textContent + '!');
  if (mapMain) setTimeout(() => mapMain.invalidateSize(), 150);
}

// ══════════════════════════════════════════════════════════
// FILTER
// ══════════════════════════════════════════════════════════
function filterChip(el, type) {
  document.querySelectorAll('.fchip').forEach(c => c.classList.remove('on'));
  el.classList.add('on');
  Object.values(nodeMarkers).forEach(({ marker, data }) => {
    if (data.type === 'user' || data.type === 'waypoint') return;
    const show = type === 'todo' || data.type === type;
    if (show) marker.addTo(mapMain); else marker.removeFrom(mapMain);
  });
}

// ══════════════════════════════════════════════════════════
// INLINE SEARCH
// ══════════════════════════════════════════════════════════
function focusSearchInput() {
  document.getElementById('s-input-inline').focus();
}

function onSearchFocus() {
  renderInlineSearch(document.getElementById('s-input-inline').value || '');
}

function onSearchInput(q) {
  document.getElementById('search-clear').style.display = q ? 'inline' : 'none';
  renderInlineSearch(q);
}

function clearSearchInput(ev) {
  ev?.stopPropagation();
  const input = document.getElementById('s-input-inline');
  input.value = '';
  document.getElementById('search-clear').style.display = 'none';
  renderInlineSearch('');
  input.focus();
}

function renderInlineSearch(q) {
  const graph = graphData || { nodes: [], edges: [] };
  const targets = graph.nodes.filter(n => VISIBLE_TYPES.includes(n.type));
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const query = norm(q.trim());
  const filtered = query
    ? targets.filter(n => norm(n.name).includes(query))
    : targets;

  const box = document.getElementById('search-results');
  box.classList.add('show');

  if (!filtered.length) {
    box.innerHTML = `<div class="search-empty">Sin resultados</div>`;
    return;
  }

  box.innerHTML = filtered.map(n => `
    <div class="search-result-row" onclick="pickSearchResult('${n.id}')">
      <div class="search-result-ico">${n.icon || '📍'}</div>
      <div class="search-result-txt">
        <h4>${n.name}</h4>
        <p>${TYPE_LABELS[n.type] || n.type}</p>
      </div>
      <button class="search-result-go" onclick="event.stopPropagation();pickSearchResult('${n.id}')">Ir →</button>
    </div>`).join('');
}

function pickSearchResult(nodeId) {
  const graph = graphData || { nodes: [], edges: [] };
  const node = graph.nodes.find(n => n.id === nodeId);
  if (!node) return;
  
  hideSearchResults();
  const input = document.getElementById('s-input-inline');
  input.value = '';
  input.blur();
  document.getElementById('search-clear').style.display = 'none';
  
  selectGraphNode(node);
  if (mapMain) mapMain.setView([node.lat, node.lng], 18);
  routeTo();
}

function hideSearchResults() {
  document.getElementById('search-results').classList.remove('show');
}

document.addEventListener('click', (ev) => {
  const topbar = document.querySelector('.map-topbar');
  if (topbar && !topbar.contains(ev.target)) hideSearchResults();
});

// ══════════════════════════════════════════════════════════
// CLOCK & INIT
// ══════════════════════════════════════════════════════════
function updateClock() {
  const now = new Date();
  document.getElementById('clock').textContent =
    now.getHours() + ':' + String(now.getMinutes()).padStart(2,'0');
}
setInterval(updateClock, 10000);
updateClock();

enterApp();

// ══════════════════════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════════════════════
let _toastTimer;
function toast(msg) {
  const el = document.getElementById('toast-el');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('on'), 2800);
}