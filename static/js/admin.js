// ── CONFIG BASE ──
const BASE_URL = window.APP_CONFIG.rootPath;
const SEDES_INFO = window.APP_CONFIG.sedesInfo;

const SYSTEM_TYPES = {
  waypoint: { icon: '🔵', size: 22 },
  building: { icon: '🏛️', size: 30 },
  entrance: { icon: '🚪', size: 26 },
  'baño': { icon: '🚽', size: 26 },
  seguridad: { icon: '👮🏻', size: 26 },
  servicio: { icon: '🏥', size: 26 }
};

let map, nodes = [], edges = [], mode = 'add';
let selNodeType = 'waypoint', edgeFrom = null;
let currentFloor = 1, currentBuilding = 'exterior';

let hasUnsavedChanges = false;
let tempBldMarker = null;
let bldStep = 1;
let tempBldNodeLatLng = null;
let originalNodes = new Set();
let originalBuildings = new Set();
let editingZoneId = null;

const ZONE_KINDS = {
  zonaseg: { tag: 'zona_segura', color: '#1f7a5c' },
  edificio: { tag: 'contorno_edificio', color: '#3b6e8f' },
};
let zones = [];
let drawingZonePoints = [];
let drawingZonePreviewLayer = null;
let drawingZoneVertexLayers = [];

window.addEventListener('beforeunload', (e) => {
  if (hasUnsavedChanges) e.returnValue = "Tienes cambios sin publicar. ¿Seguro que deseas salir?";
});

window.onload = async () => {
  map = L.map('map', { zoomControl: true, maxZoom: 22 });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 22, maxNativeZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  map.on('click', onMapClick);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (mode === 'zonaseg' || mode === 'edificio') cancelZoneDrawing();
      if (mode === 'edge') cancelEdge();
    }
  });
  centrarMapaEnSede();
  loadFromServer();
};

function centrarMapaEnSede() {
  const sedeId = document.getElementById('sede-selector')?.value;
  const info = SEDES_INFO.find(s => s.id === sedeId);
  if (info) {
    map.setView([info.lat, info.lng], info.zoom);
  }
}

function updateBuildingSelector() {
  const sel = document.getElementById('building-selector');
  sel.innerHTML = `<option value="exterior">Campus (Exterior)</option>`;
  const blds = nodes.filter(n => n.type === 'building');
  blds.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id; opt.textContent = b.name || 'Edificio';
    sel.appendChild(opt);
  });
  if (currentBuilding === 'exterior' || blds.find(b => b.id === currentBuilding)) {
    sel.value = currentBuilding;
  } else {
    currentBuilding = 'exterior'; sel.value = currentBuilding;
  }
  updateFloorSelector();
}

function changeBuilding() {
  currentBuilding = document.getElementById('building-selector').value;
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
  for (let i = min; i <= max; i++) {
    const opt = document.createElement('option');
    opt.value = i; opt.textContent = i === 0 ? 'Planta Baja (0)' : (i < 0 ? `Sub. ${Math.abs(i)}` : `Nivel ${i}`);
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
      const color = e.es_escalera ? '#f5a623' : '#4a9eff';
      if (fn.floor !== tn.floor) e.line.setStyle({ dashArray: '5, 10', color: color });
      else e.line.setStyle({ dashArray: null, color: color });
    } else {
      e.line.removeFrom(map);
    }
  });
  document.getElementById('st-nodes').textContent = nodes.filter(n => n.floor === currentFloor).length;
}

async function publishToServer() {
  const sedeId = document.getElementById('sede-selector')?.value;
  if (!sedeId) return;

  const orphaned = nodes.filter(n => n.type === 'waypoint' && !edges.some(e => e.from === n.id || e.to === n.id));
  if (orphaned.length > 0) {
    const proceed = await window.uiConfirm(`Hay ${orphaned.length} Puntos de Ruta sin conexiones.\n¿Publicar de todos modos?`, "Advertencia");
    if (!proceed) return;
  }

  const currentNodes = new Set(nodes.filter(n => n.type !== 'waypoint' && n.type !== 'building' && n.type !== 'user').map(n => n.id));
  const currentBuildings = new Set(nodes.filter(n => n.type === 'building').map(n => n.id));

  let nodosNuevos = 0, nodosEliminados = 0, edificiosNuevos = 0, edificiosEliminados = 0;

  currentNodes.forEach(id => { if (!originalNodes.has(id)) nodosNuevos++; });
  originalNodes.forEach(id => { if (!currentNodes.has(id)) nodosEliminados++; });
  currentBuildings.forEach(id => { if (!originalBuildings.has(id)) edificiosNuevos++; });
  originalBuildings.forEach(id => { if (!currentBuildings.has(id)) edificiosEliminados++; });

  const promptMsg = `Has realizado los siguientes cambios (excluyendo puntos de ruta/aristas):\n- Nodos (POIs) nuevos: ${nodosNuevos}\n- Nodos (POIs) eliminados: ${nodosEliminados}\n- Edificios nuevos: ${edificiosNuevos}\n- Edificios eliminados: ${edificiosEliminados}\n\n¿Estás seguro de publicar el mapa?`;

  const conf = await window.uiConfirm(promptMsg, "Publicar Mapa");
  if (!conf) return;

  setStatus('Publicando...', 'warn');

  const dynamicBuildings = nodes.filter(n => n.type === 'building').map(n => ({ id: n.id, name: n.name, min: n.piso_min || 1, max: n.piso_max || 4 }));

  const payload = {
    meta: { campus: sedeId, version: '2.1' },
    buildings: dynamicBuildings,
    nodes: nodes.map(n => ({
      id: n.id, type: n.type, name: n.name, icon: n.icon, lat: n.latlng.lat, lng: n.latlng.lng, floor: parseInt(n.floor), building: n.building,
      ...(n.type !== 'waypoint' && n.type !== 'user' ? { horario: n.horario, descripcion: n.descripcion, link_derivacion: n.link_derivacion } : {})
    })),
    edges: edges.map(e => ({ id: e.id, from: e.from, to: e.to, weight: e.weight, es_escalera: e.es_escalera || false })),
    zonas: zones.map(z => ({ id: z.id, building: z.building, name: z.name, geojson: z.geojson, tags: z.tags, color: z.color }))
  };

  try {
    const res = await fetch(BASE_URL + `/admin/api/sedes/${sedeId}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error();
    hasUnsavedChanges = false;

    originalNodes = new Set(currentNodes);
    originalBuildings = new Set(currentBuildings);

    setStatus(`✅ Mapa Guardado`, 'ok');
    await window.uiAlert("El mapa ha sido publicado exitosamente.", "Éxito");
  } catch (err) {
    setStatus('❌ Error al publicar', 'err');
    await window.uiAlert("Hubo un error al publicar el mapa.", "Error");
  }
}

async function loadFromServer() {
  const sedeId = document.getElementById('sede-selector')?.value;
  if (!sedeId) return;
  setStatus('Cargando...', 'warn');
  try {
    const res = await fetch(BASE_URL + `/api/v1/public/sedes/${sedeId}/snapshot`);
    if (res.status === 404) { clearAll(true); setStatus('Mapa nuevo', 'ok'); return; }
    if (!res.ok) throw new Error();
    const data = await res.json();
    loadGraph(data);
    setStatus('✅ Grafo cargado', 'ok');
  } catch (err) {
    console.error(err);
    setStatus('❌ Error cargando el mapa', 'err');
  }
}

function setMode(m) {
  if (document.getElementById('vertex-edit-toolbar').style.display !== 'none') {
    finishVertexEditing();
  }
  const wasZoneMode = mode === 'zonaseg' || mode === 'edificio';
  const isZoneMode = m === 'zonaseg' || m === 'edificio';
  if (wasZoneMode && mode !== m) cancelZoneDrawing();
  mode = m;

  document.querySelectorAll('.mmode').forEach(b => b.classList.remove('on'));
  document.getElementById('btn-' + m).classList.add('on');
  if (m !== 'edge') cancelEdge();

  document.getElementById('panel-default').style.display = isZoneMode ? 'none' : 'flex';
  document.getElementById('panel-zonaseg').style.display = m === 'zonaseg' ? 'flex' : 'none';
  document.getElementById('panel-edificio').style.display = m === 'edificio' ? 'flex' : 'none';

  if (!isZoneMode) {
    document.getElementById('node-creation-properties').style.display = m === 'add' ? 'block' : 'none';
    document.getElementById('edge-creation-properties').style.display = m === 'edge' ? 'block' : 'none';
  }

  const bldFilter = document.getElementById('field-building-filter');
  if (bldFilter) bldFilter.style.display = m === 'edge' ? 'none' : 'flex';

  if (m === 'add') {
    const select = document.getElementById('node-type-select');
    select.value = 'waypoint'; setSystemType(select);
  }

  if (isZoneMode) openZonePanel(m);
}

function setSystemType(el) {
  selNodeType = el.value;
  const nameInp = document.getElementById('node-name-input');
  const iconInp = document.getElementById('node-icon-input');

  if (selNodeType === 'waypoint') nameInp.value = "";
  const isVisiblePoi = selNodeType !== 'waypoint' && selNodeType !== 'user';
  document.getElementById('service-fields').style.display = isVisiblePoi ? 'block' : 'none';

  if (isVisiblePoi && SYSTEM_TYPES[selNodeType]) iconInp.value = SYSTEM_TYPES[selNodeType].icon;
}

function onMapClick(e) {
  if (mode === 'edificio') {
    if (bldStep === 1) {
      tempBldNodeLatLng = e.latlng;
      tempBldMarker = L.marker(e.latlng, { icon: L.divIcon({ className: 'graph-node type-building', html: '🏛️', iconSize: [30, 30] }) }).addTo(map);
      bldStep = 2;
      document.getElementById('bld-guide-step1').style.display = 'none';
      document.getElementById('bld-guide-step2').style.display = 'block';
    } else addZoneVertex(e.latlng);
    return;
  }

  if (mode === 'zonaseg') { addZoneVertex(e.latlng); return; }

  if (mode === 'add') {
    const isDuplicate = nodes.some(n => n.floor === currentFloor && n.latlng.distanceTo(e.latlng) < 0.5);
    if (isDuplicate) return;

    hasUnsavedChanges = true;
    const rawName = document.getElementById('node-name-input').value.trim();
    const sysType = SYSTEM_TYPES[selNodeType];
    const id = crypto.randomUUID();
    const shortId = id.split('-')[0].toUpperCase();
    const name = rawName || (selNodeType === 'waypoint' ? `WP-${shortId}` : `Nodo ${shortId}`);
    const icon = (selNodeType !== 'waypoint' && document.getElementById('node-icon-input')?.value.trim()) || sysType.icon;

    const el = document.createElement('div');
    el.className = `graph-node type-${selNodeType}`;
    el.style.width = sysType.size + 'px'; el.style.height = sysType.size + 'px'; el.textContent = icon;

    const marker = L.marker(e.latlng, { icon: L.divIcon({ html: el, iconSize: [sysType.size, sysType.size], className: '' }), draggable: true }).addTo(map);
    marker.bindTooltip(name, { permanent: false, direction: 'top' });

    let extraProps = {};
    if (selNodeType === 'building') extraProps = { piso_min: 1, piso_max: 4 };
    if (selNodeType !== 'waypoint' && selNodeType !== 'user') {
      extraProps = {
        horario: document.getElementById('node-horario-input')?.value.trim() || '',
        descripcion: document.getElementById('node-descripcion-input')?.value.trim() || '',
        link_derivacion: document.getElementById('node-link-input')?.value.trim() || ''
      };
    }

    const node = { id, type: selNodeType, name, icon, latlng: e.latlng, floor: currentFloor, building: currentBuilding, marker, el, ...extraProps };
    nodes.push(node);

    marker.on('click', (ev) => { L.DomEvent.stopPropagation(ev); onNodeClick(id, ev.latlng); });
    marker.on('dragend', () => { node.latlng = marker.getLatLng(); rebuildLines(); });

    if (selNodeType === 'building') updateBuildingSelector();
    renderMapNodes();
  }
}

// ── SISTEMA DE POPUPS (EDICIÓN) ──
function openEditPopup(type, id, latlng) {
  let html = '';
  if (type === 'node') {
    const n = nodes.find(x => x.id === id);
    const isBld = n.type === 'building';
    const isSrv = n.type !== 'waypoint' && n.type !== 'user';

    const bOptions = nodes.filter(x => x.type === 'building').map(b => `<option value="${b.id}" ${b.id === n.building ? 'selected' : ''}>${b.name}</option>`).join('');

    html = `
          <div class="pop-edit">
            <h6 style="margin-bottom:10px; font-weight:bold; color:var(--naviusm-text);">Editar ${isBld ? 'Edificio' : 'Nodo'}</h6>
            <label>Nombre</label>
            <input type="text" id="pop-name" class="form-control form-control-sm mb-2" value="${n.name}">
            
            ${!isBld ? `
            <label>Edificio Asignado</label>
            <select id="pop-building" class="form-select form-select-sm mb-2" style="font-size:12px;">
              <option value="exterior" ${n.building === 'exterior' ? 'selected' : ''}>Campus (Exterior)</option>
              ${bOptions}
            </select>
            ` : ''}

            ${isSrv ? `
              <label>Icono (Emoji)</label>
          <input type="text" id="pop-icon" class="form-control form-control-sm mb-2" value="${n.icon || ''}" maxlength="4">
          <label>Horario</label>
          <input type="text" id="pop-horario" class="form-control form-control-sm mb-2" value="${n.horario || ''}">
          <label>Descripción</label>
          <textarea id="pop-desc" class="form-control form-control-sm mb-2" rows="2">${n.descripcion || ''}</textarea>
          <label>Link</label>
          <input type="url" id="pop-link" class="form-control form-control-sm mb-2" value="${n.link_derivacion || ''}">
        ` : ''}
        <div class="d-flex justify-content-end gap-2 mt-3">
          <button class="btn btn-sm btn-secondary" onclick="map.closePopup()">Cancelar</button>
          <button class="btn btn-sm btn-success" style="background:var(--naviusm-green); border:none;" onclick="saveNodeEdit('${id}')">Guardar</button>
        </div>
      </div>
    `;
  } else if (type === 'edge') {
    const e = edges.find(x => x.id === id);
    html = `
      <div class="pop-edit">
        <h6 style="margin-bottom:10px; font-weight:bold; color:var(--naviusm-text);">Editar Conexión</h6>
        <label class="d-flex align-items-center gap-2 text-white" style="cursor:pointer; text-transform:none;">
          <input type="checkbox" id="pop-es-escalera" ${e.es_escalera ? 'checked' : ''} style="width:16px; height:16px;"> 
          Esta conexión es una escalera
        </label>
        <div class="d-flex justify-content-end gap-2 mt-3">
          <button class="btn btn-sm btn-secondary" onclick="map.closePopup()">Cancelar</button>
          <button class="btn btn-sm btn-success" style="background:var(--naviusm-green); border:none;" onclick="saveEdgeEdit('${id}')">Guardar</button>
        </div>
      </div>
    `;
  } else if (type === 'zone') {
    const z = zones.find(x => x.id === id);
    html = `
      <div class="pop-edit">
        <h6 style="margin-bottom:10px; font-weight:bold; color:var(--naviusm-text);">Editar Zona / Edificio</h6>
        <label>Nombre</label>
        <input type="text" id="pop-zone-name" class="form-control form-control-sm mb-2" value="${z.name}">
        <div class="d-flex justify-content-end gap-2 mt-3">
          <button class="btn btn-sm btn-warning me-auto" style="font-weight:bold; color:black;" onclick="enableZoneVertexEditing('${id}'); map.closePopup();">Modificar Contorno</button>
          <button class="btn btn-sm btn-success" style="background:var(--naviusm-green); border:none;" onclick="saveZoneEdit('${id}')">Guardar</button>
        </div>
      </div>
    `;
  }
  L.popup({ className: 'dark-popup' }).setLatLng(latlng).setContent(html).openOn(map);
}

window.saveNodeEdit = function (id) {
  const n = nodes.find(x => x.id === id);
  n.name = document.getElementById('pop-name').value;

  if (n.type !== 'building' && document.getElementById('pop-building')) {
    n.building = document.getElementById('pop-building').value;
  }

  if (document.getElementById('pop-icon')) {
    n.icon = document.getElementById('pop-icon').value;
    n.el.textContent = n.icon;
    n.horario = document.getElementById('pop-horario').value;
    n.descripcion = document.getElementById('pop-desc').value;
    n.link_derivacion = document.getElementById('pop-link').value;
  }
  n.marker.bindTooltip(n.name, { permanent: false, direction: 'top' });
  if (n.type === 'building') {
    const z = zones.find(z => z.building === id);
    if (z) z.name = n.name;
    updateBuildingSelector();
  }
  map.closePopup();
  hasUnsavedChanges = true;
};

window.saveEdgeEdit = function (id) {
  const e = edges.find(x => x.id === id);
  e.es_escalera = document.getElementById('pop-es-escalera').checked;
  e.line.setStyle({ color: e.es_escalera ? '#f5a623' : '#4a9eff' });
  map.closePopup();
  hasUnsavedChanges = true;
};

window.saveZoneEdit = function (id) {
  const z = zones.find(x => x.id === id);
  z.name = document.getElementById('pop-zone-name').value;
  if (z.building) {
    const n = nodes.find(n => n.id === z.building);
    if (n) {
      n.name = z.name;
      n.marker.bindTooltip(n.name, { permanent: false, direction: 'top' });
    }
    updateBuildingSelector();
  }
  map.closePopup();
  hasUnsavedChanges = true;
};

function onNodeClick(id, latlng) {
  if (mode === 'delete') {
    const n = nodes.find(x => x.id === id);
    if (n.type === 'building') {
      attemptDeleteBuilding(id);
    } else {
      executeNodeDeletion(id);
    }
    return;
  }

  if (mode === 'edge') {
    if (!edgeFrom) {
      edgeFrom = id;
      nodes.find(n => n.id === id).el.style.boxShadow = "0 0 0 4px rgba(74, 158, 255, 0.8)";
    } else {
      if (edgeFrom !== id) addEdge(edgeFrom, id);
      cancelEdge();
    }
    return;
  }

  if (mode === 'add' || mode === 'zonaseg' || mode === 'edificio') {
    openEditPopup('node', id, latlng);
  }
}

function addEdge(from, to) {
  if (edges.some(e => (e.from === from && e.to === to) || (e.from === to && e.to === from))) return;

  const fNode = nodes.find(n => n.id === from), tNode = nodes.find(n => n.id === to);
  const weight = map.distance(fNode.latlng, tNode.latlng);
  const penalty = Math.abs(fNode.floor - tNode.floor) * 15;
  const isEscalera = document.getElementById('edge-escalera-input')?.checked || false;
  const color = isEscalera ? '#f5a623' : '#4a9eff';

  const line = L.polyline([fNode.latlng, tNode.latlng], { color: color, weight: 3 }).addTo(map);
  const id = crypto.randomUUID();

  line.on('click', (ev) => {
    L.DomEvent.stopPropagation(ev);
    if (mode === 'delete') {
      line.removeFrom(map); edges = edges.filter(e => e.id !== id); hasUnsavedChanges = true;
    } else {
      openEditPopup('edge', id, ev.latlng);
    }
  });

  edges.push({ id, from, to, weight: weight + penalty, es_escalera: isEscalera, line });
  hasUnsavedChanges = true;
  renderMapNodes();
}

function cancelEdge() {
  if (edgeFrom) {
    const n = nodes.find(x => x.id === edgeFrom);
    if (n) n.el.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.5)";
  }
  edgeFrom = null;
}

function addZoneVertex(latlng) {
  const idx = drawingZonePoints.length;
  drawingZonePoints.push([latlng.lat, latlng.lng]);
  const marker = L.marker(latlng, { draggable: true, icon: L.divIcon({ className: 'zone-vertex', iconSize: [12, 12] }) }).addTo(map);
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
  if (drawingZonePoints.length === 2) drawingZonePreviewLayer = L.polyline(drawingZonePoints, { color: '#333', dashArray: '4,4' }).addTo(map);
  else if (drawingZonePoints.length >= 3) drawingZonePreviewLayer = L.polygon(drawingZonePoints, { color: '#333', dashArray: '4,4', fillOpacity: 0.1 }).addTo(map);
  const btnSave = document.getElementById(mode + '-save-btn');
  if (btnSave) btnSave.disabled = drawingZonePoints.length < 3;
}

function cancelZoneDrawing() {
  drawingZonePoints = [];
  if (drawingZonePreviewLayer) { drawingZonePreviewLayer.removeFrom(map); drawingZonePreviewLayer = null; }
  drawingZoneVertexLayers.forEach(m => m.removeFrom(map));
  drawingZoneVertexLayers = [];
  if (tempBldMarker) { tempBldMarker.removeFrom(map); tempBldMarker = null; }
  bldStep = 1;
  document.getElementById('edificio-save-btn').disabled = true;
  document.getElementById('zonaseg-save-btn').disabled = true;
}

function populateZoneBuildingSelect(kind) {
  const sel = document.getElementById(kind + '-building-select');
  if (!sel) return;
  sel.innerHTML = '<option value="exterior">Exterior / Campus</option>' +
    nodes.filter(n => n.type === 'building').map(b => `<option value="${b.id}">${b.name}</option>`).join('');
}

function openZonePanel(kind) {
  cancelZoneDrawing();
  document.getElementById(kind + '-name-input').value = '';
  populateZoneBuildingSelect(kind);
  if (kind === 'edificio') {
    document.getElementById('bld-guide-step1').style.display = 'block';
    document.getElementById('bld-guide-step2').style.display = 'none';
  }
}

function confirmZoneConfig(kind) {
  const name = document.getElementById(kind + '-name-input').value.trim() || 'Sin nombre';

  if (kind === 'edificio' && drawingZonePoints.length >= 3 && tempBldNodeLatLng) {
    const nodeId = crypto.randomUUID();
    const el = document.createElement('div');
    el.className = `graph-node type-building`;
    el.style.width = '30px'; el.style.height = '30px'; el.textContent = '🏛️';

    const marker = L.marker(tempBldNodeLatLng, { icon: L.divIcon({ html: el, iconSize: [30, 30], className: '' }), draggable: true }).addTo(map);
    marker.bindTooltip(name, { permanent: false, direction: 'top' });

    marker.on('click', (ev) => { L.DomEvent.stopPropagation(ev); onNodeClick(nodeId, ev.latlng); });
    marker.on('dragend', () => { node.latlng = marker.getLatLng(); rebuildLines(); });

    const node = { id: nodeId, type: 'building', name: name, icon: '🏛️', latlng: tempBldNodeLatLng, floor: currentFloor, building: 'exterior', marker, el, piso_min: 1, piso_max: 4 };
    nodes.push(node);

    const shapePoints = drawingZonePoints;
    const geojson = { type: 'Polygon', coordinates: [[...shapePoints, shapePoints[0]].map(([lat, lng]) => [lng, lat])] };
    const zone = { id: crypto.randomUUID(), building: nodeId, name, tags: ['contorno_edificio'], color: '#3b6e8f', geojson, polygon: null };
    zones.push(zone);
    renderZone(zone);

    if (tempBldMarker) { tempBldMarker.removeFrom(map); tempBldMarker = null; }
    updateBuildingSelector();
    bldStep = 1; tempBldNodeLatLng = null;
    document.getElementById('bld-guide-step1').style.display = 'block';
    document.getElementById('bld-guide-step2').style.display = 'none';

  } else if (kind === 'zonaseg') {
    const buildingVal = document.getElementById(kind + '-building-select').value;
    const shapePoints = drawingZonePoints;
    const geojson = { type: 'Polygon', coordinates: [[...shapePoints, shapePoints[0]].map(([lat, lng]) => [lng, lat])] };
    const zone = { id: crypto.randomUUID(), building: buildingVal === 'exterior' ? null : buildingVal, name, tags: ['zona_segura'], color: '#1f7a5c', geojson, polygon: null };
    zones.push(zone);
    renderZone(zone);
  }
  hasUnsavedChanges = true;
  openZonePanel(kind);
}

function enableZoneVertexEditing(id) {
  editingZoneId = id;
  const zone = zones.find(z => z.id === id);
  drawingZoneVertexLayers.forEach(m => m.removeFrom(map));
  drawingZoneVertexLayers = [];

  zone.polygon.setStyle({ weight: 4, color: '#22d07a', dashArray: '5, 5' });

  const coords = zone.geojson.coordinates[0].slice(0, -1);
  coords.forEach((coord, idx) => {
    const latlng = [coord[1], coord[0]];
    const marker = L.marker(latlng, { draggable: true, icon: L.divIcon({ className: 'zone-vertex', iconSize: [12, 12] }) }).addTo(map);

    marker.on('drag', () => {
      const ll = marker.getLatLng();
      zone.geojson.coordinates[0][idx] = [ll.lng, ll.lat];
      if (idx === 0) zone.geojson.coordinates[0][coords.length] = [ll.lng, ll.lat];
      const leafletCoords = zone.geojson.coordinates[0].map(c => [c[1], c[0]]);

      zone.polygon.eachLayer(layer => {
        layer.setLatLngs(leafletCoords);
      });
      hasUnsavedChanges = true;
    });
    drawingZoneVertexLayers.push(marker);
  });
  document.getElementById('vertex-edit-toolbar').style.display = 'flex';
}

window.finishVertexEditing = function () {
  drawingZoneVertexLayers.forEach(m => m.removeFrom(map));
  drawingZoneVertexLayers = [];
  document.getElementById('vertex-edit-toolbar').style.display = 'none';

  if (editingZoneId) {
    const zone = zones.find(z => z.id === editingZoneId);
    if (zone) {
      const base = zone.color || colorForZone(zone);
      zone.polygon.setStyle({ weight: 2, color: shadeColor(base, -0.25), dashArray: null });
    }
    editingZoneId = null;
  }
  setStatus('⚠️ Contorno modificado sin guardar', 'warn');
}

function renderZone(zone) {
  const base = zone.color || colorForZone(zone);
  zone.polygon = L.geoJSON(zone.geojson, { style: { color: shadeColor(base, -0.25), fillColor: shadeColor(base, 0.45), fillOpacity: 0.45, weight: 2 } }).addTo(map);
  zone.polygon.on('click', (ev) => {
    if (mode === 'add' || mode === 'edge') { map.fire('click', ev); return; }
    L.DomEvent.stopPropagation(ev);
    if (mode === 'delete') {
      if (zone.building) {
        attemptDeleteBuilding(zone.building, zone);
      } else {
        executeZoneDeletion(zone);
      }
    } else {
      openEditPopup('zone', zone.id, ev.latlng);
    }
  });
}

function shadeColor(hex, p) {
  const num = parseInt(hex.replace('#', ''), 16);
  const blend = (c) => Math.round(p > 0 ? c + (255 - c) * p : c + c * p);
  return '#' + [blend((num >> 16) & 0xFF), blend((num >> 8) & 0xFF), blend(num & 0xFF)].map(c => Math.min(255, Math.max(0, c)).toString(16).padStart(2, '0')).join('');
}
function colorForZone(zone) {
  const k = Object.values(ZONE_KINDS).find(k => zone.tags.includes(k.tag)); return k ? k.color : '#888888';
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
  cancelEdge(); renderMapNodes(); hasUnsavedChanges = true;
}

function rebuildLines() {
  edges.forEach(e => {
    const fn = nodes.find(n => n.id === e.from), tn = nodes.find(n => n.id === e.to);
    e.line.setLatLngs([fn.latlng, tn.latlng]);
  });
}

function loadGraph(data) {
  if (data.nodes) {
    const uniqueNodes = [];
    const seenCoords = new Set();
    data.nodes.forEach(n => {
      const key = `${n.lat.toFixed(6)},${n.lng.toFixed(6)},${n.floor},${n.type}`;
      if (!seenCoords.has(key)) {
        seenCoords.add(key);
        uniqueNodes.push(n);
      }
    });
    data.nodes = uniqueNodes;
  }

  originalNodes = new Set((data.nodes || []).filter(n => n.type !== 'waypoint' && n.type !== 'building' && n.type !== 'user').map(n => n.id));
  originalBuildings = new Set((data.buildings || []).filter(b => b.id !== 'exterior').map(b => b.id));

  nodes.forEach(n => n.marker.removeFrom(map));
  zones.forEach(z => z.polygon && z.polygon.removeFrom(map));
  nodes = []; edges = []; zones = [];
  if (!data.nodes || !data.edges) return;
  const idMap = {}; const isUUID = (str) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);

  data.buildings = (data.buildings || []).map(b => {
    if (b.id !== 'exterior' && !isUUID(b.id)) { const newId = crypto.randomUUID(); idMap[b.id] = newId; b.id = newId; } return b;
  });

  data.nodes = data.nodes.map(n => {
    if (!isUUID(n.id)) { const newId = crypto.randomUUID(); idMap[n.id] = newId; n.id = newId; }
    if (n.building && idMap[n.building]) n.building = idMap[n.building];
    n.floor = parseInt(n.floor, 10) || 1; return n;
  });

  data.edges = data.edges.map(e => {
    if (!isUUID(e.id)) e.id = crypto.randomUUID();
    if (idMap[e.from]) e.from = idMap[e.from];
    if (idMap[e.to]) e.to = idMap[e.to];
    return e;
  });

  if (data.buildings && data.buildings.length > 0) buildings = data.buildings;
  else buildings = [{ id: 'exterior', name: 'Campus (Exterior)', min: 1, max: 1 }];

  currentBuilding = 'exterior';
  updateFloorSelector();

  data.nodes.forEach(n => {
    if (n.type === 'building') {
      const bData = (data.buildings || []).find(b => b.id === n.id);
      n.piso_min = bData ? bData.min : 1; n.piso_max = bData ? bData.max : 4;
    }
    const sysType = SYSTEM_TYPES[n.type] || SYSTEM_TYPES['waypoint'];
    const el = document.createElement('div'); el.className = `graph-node type-${n.type}`;
    el.style.width = sysType.size + 'px'; el.style.height = sysType.size + 'px'; el.textContent = n.icon || sysType.icon;
    const marker = L.marker([n.lat, n.lng], { icon: L.divIcon({ html: el, iconSize: [sysType.size, sysType.size], className: '' }), draggable: true });
    marker.bindTooltip(n.name, { permanent: false, direction: 'top' });
    const serviceProps = n.type !== 'waypoint' && n.type !== 'user' ? { horario: n.horario, descripcion: n.descripcion, link_derivacion: n.link_derivacion } : {};
    const node = { id: n.id, type: n.type, name: n.name, icon: n.icon, latlng: L.latLng(n.lat, n.lng), floor: n.floor, building: n.building || 'exterior', marker, el, ...serviceProps };
    nodes.push(node);
    marker.on('click', (ev) => { L.DomEvent.stopPropagation(ev); onNodeClick(n.id, ev.latlng); });
    marker.on('dragend', () => { node.latlng = marker.getLatLng(); rebuildLines(); hasUnsavedChanges = true; });
  });

  data.edges.forEach(e => {
    const fn = nodes.find(x => x.id === e.from), tn = nodes.find(x => x.id === e.to);
    if (!fn || !tn) return;
    const line = L.polyline([fn.latlng, tn.latlng], { color: e.es_escalera ? '#f5a623' : '#4a9eff', weight: 3 });
    line.on('click', (ev) => { L.DomEvent.stopPropagation(ev); if (mode === 'delete') { line.removeFrom(map); edges = edges.filter(x => x.id !== e.id); hasUnsavedChanges = true; } else { openEditPopup('edge', e.id, ev.latlng); } });
    edges.push({ id: e.id, from: e.from, to: e.to, weight: e.weight, es_escalera: e.es_escalera || false, line });
  });

  zones = (data.zonas || []).map(z => ({ id: z.id, building: z.building, name: z.name, tags: z.tags || [], color: z.color, geojson: z.geojson, polygon: null }));
  zones.forEach(renderZone);
  updateBuildingSelector(); renderMapNodes();
}

function setStatus(msg, state) {
  document.getElementById('status-txt').textContent = msg;
  document.getElementById('sdot').className = 's-dot' + (state === 'warn' ? ' warn' : '');
}

async function attemptDeleteBuilding(nodeId, zoneObj = null) {
  const childNodes = nodes.filter(n => n.building === nodeId);
  // Contar estrictamente POIs asociados (entradas, baños, etc.)
  const salasCount = childNodes.filter(n => n.type !== 'waypoint' && n.type !== 'building' && n.type !== 'user').length;

  const confirmMsg = salasCount > 0
    ? `ADVERTENCIA: estás a punto de borrar un edificio con ${salasCount} salas/puntos.\n¿Estás seguro?`
    : `¿Eliminar este edificio y su contorno asociado?`;

  const proceed = await window.uiConfirm(confirmMsg, "Eliminar Edificio");
  if (!proceed) return;

  if (zoneObj) {
    executeZoneDeletion(zoneObj);
  } else {
    const z = zones.find(z => z.building === nodeId);
    if (z) executeZoneDeletion(z);
  }

  childNodes.forEach(child => executeNodeDeletion(child.id));

  executeNodeDeletion(nodeId);
}

function executeZoneDeletion(zone) {
  if (zone.polygon) zone.polygon.removeFrom(map);
  zones = zones.filter(z => z.id !== zone.id);
  hasUnsavedChanges = true;
}

function executeNodeDeletion(id) {
  const n = nodes.find(x => x.id === id);
  if (!n) return;
  n.marker.removeFrom(map);
  edges.filter(e => e.from === id || e.to === id).forEach(e => e.line.removeFrom(map));
  edges = edges.filter(e => e.from !== id && e.to !== id);
  nodes = nodes.filter(x => x.id !== id);
  if (n.type === 'building') updateBuildingSelector();
  hasUnsavedChanges = true;
  renderMapNodes();
}