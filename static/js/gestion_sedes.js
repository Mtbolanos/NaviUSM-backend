// =============================================================================
// Gestión de Sedes: crear, editar y eliminar sedes.
// En la ventana de una sede:
//   - el marcador es el centro de la sede (donde abre el editor); clic en el mapa o arrastrar lo mueve;
//   - el contorno (opcional) limita el área del editor: "Dibujar contorno" y clic en cada vértice;
//     se cierra con clic en el primer vértice, "Terminar" o Enter. Una vez dibujado, los vértices se
//     arrastran, clic en un vértice lo elimina y los puntos intermedios agregan vértices.
// =============================================================================
const ROOT_PATH = NV.site().rootPath;
const SEDES = NV.page().sedes || [];
const DEFAULT_CENTER = [-33.036577, -71.486578];

let nsMap = null;
let nsMarker = null;
let center = DEFAULT_CENTER.slice();
let editingId = null;          // null = sede nueva
let ring = [];                 // vértices del contorno [L.LatLng]
let drawing = false;           // dibujando el contorno
let contourLayer = null;       // polígono (o línea mientras se dibuja) + marcadores de vértices
let modal = null;

function ensureMap() {
  if (nsMap) return;
  nsMap = L.map('ns-map', { zoomControl: true, maxZoom: NV.mapMaxZoom() }).setView(center, 16);
  NV.baseLayer(nsMap);
  nsMarker = L.marker(center, { draggable: true }).addTo(nsMap);
  nsMarker.on('dragend', () => { const p = nsMarker.getLatLng(); setCenter(p.lat, p.lng); });
  nsMap.on('click', (e) => {
    if (drawing) { addVertex(e.latlng); return; }
    setCenter(e.latlng.lat, e.latlng.lng);
  });
}

function setCenter(lat, lng) {
  center = [lat, lng];
  nsMarker.setLatLng(center);
  document.getElementById('ns-lat-disp').textContent = lat.toFixed(6);
  document.getElementById('ns-lng-disp').textContent = lng.toFixed(6);
}

// ----- Abrir la ventana (nueva o edición) -----
window.abrirSede = function (id = null) {
  const sede = id ? SEDES.find(s => s.id === id) : null;
  editingId = sede ? sede.id : null;
  document.getElementById('sedeModalTitle').textContent = sede ? `Editar ${sede.nombre}` : 'Nueva sede';
  document.getElementById('ns-save').textContent = sede ? 'Guardar cambios' : 'Crear sede';
  document.getElementById('ns-nombre').value = sede ? sede.nombre : '';
  document.getElementById('ns-zoom').value = sede ? sede.zoom : 18;
  document.getElementById('ns-search').value = '';
  document.getElementById('ns-search-results').hidden = true;
  center = sede ? [sede.lat, sede.lng] : DEFAULT_CENTER.slice();
  ring = sede && sede.contorno ? sede.contorno.slice(0, -1).map(([lng, lat]) => L.latLng(lat, lng)) : [];
  drawing = false;
  modal = modal || bootstrap.Modal.getOrCreateInstance(document.getElementById('sedeModal'));
  modal.show();
};

document.getElementById('sedeModal').addEventListener('shown.bs.modal', () => {
  ensureMap();
  nsMap.invalidateSize();
  setCenter(center[0], center[1]);
  renderContour();
  // margen superior mayor: el buscador queda sobre el mapa
  if (ring.length >= 3) nsMap.fitBounds(L.latLngBounds(ring), { paddingTopLeft: [30, 90], paddingBottomRight: [30, 30] });
  else nsMap.setView(center, editingId ? parseInt(document.getElementById('ns-zoom').value, 10) || 17 : 14);
  if (!editingId) document.getElementById('ns-nombre').focus();
});

window.usarZoomActual = function () {
  document.getElementById('ns-zoom').value = Math.round(nsMap.getZoom());
};

// ----- Contorno -----
function hint(text) {
  const el = document.getElementById('ns-hint');
  el.textContent = text || '';
  el.hidden = !text;
}

function syncContourUi() {
  const has = ring.length >= 3 && !drawing;
  document.getElementById('ns-draw').hidden = drawing;
  document.getElementById('ns-draw').textContent = has ? 'Dibujar de nuevo' : 'Dibujar contorno';
  document.getElementById('ns-finish').hidden = !drawing;
  document.getElementById('ns-cancel-draw').hidden = !drawing;
  document.getElementById('ns-clear').hidden = !has;
  document.getElementById('ns-contour-meta').textContent = drawing
    ? `${ring.length} ${ring.length === 1 ? 'vértice' : 'vértices'}`
    : has ? `${ring.length} vértices: arrastra para mover, clic en un vértice para quitarlo` : 'Sin contorno: el editor no limita el área';
  document.getElementById('ns-map').classList.toggle('is-drawing', drawing);
  hint(drawing ? 'Clic para agregar vértices (se pueden arrastrar). Clic en el primero, Enter o "Terminar" para cerrar. Retroceso quita el último; Esc cancela.' : '');
}

function vertexIcon(cls) {
  const size = cls === 'is-mid' ? 10 : 14;
  return L.divIcon({ className: `ns-vertex ${cls}`, iconSize: [size, size] });
}

function renderContour() {
  if (contourLayer) contourLayer.remove();
  contourLayer = L.layerGroup().addTo(nsMap);
  const color = getComputedStyle(document.documentElement).getPropertyValue('--naviusm-accent').trim() || '#f5a623';
  if (drawing) {
    if (ring.length) L.polyline(ring, { color, weight: 2, dashArray: '6,4', interactive: false }).addTo(contourLayer);
    // Los vértices ya puestos se pueden arrastrar mientras se dibuja; clic en el primero cierra el contorno
    ring.forEach((ll, i) => {
      const m = L.marker(ll, { icon: vertexIcon(i === 0 ? 'is-first' : ''), draggable: true, keyboard: false }).addTo(contourLayer);
      m.on('drag', () => { ring[i] = m.getLatLng(); contourLayer.eachLayer(l => l instanceof L.Polyline && l.setLatLngs(ring)); });
      m.on('dragend', renderContour);
      m.on('click', (e) => { L.DomEvent.stopPropagation(e); if (i === 0) terminarContorno(); });
    });
  } else if (ring.length >= 3) {
    L.polygon(ring, { color, weight: 2, fillOpacity: 0.08, interactive: false }).addTo(contourLayer);
    ring.forEach((ll, i) => {
      const m = L.marker(ll, { icon: vertexIcon(''), draggable: true, keyboard: false }).addTo(contourLayer);
      m.on('drag', () => { ring[i] = m.getLatLng(); contourLayer.eachLayer(l => l instanceof L.Polygon && l.setLatLngs(ring)); });
      m.on('dragend', renderContour);
      m.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        if (ring.length <= 3) { hint('El contorno necesita al menos 3 vértices. Usa "Borrar contorno" para quitarlo.'); return; }
        ring.splice(i, 1);
        renderContour();
      });
    });
    // Puntos intermedios: al arrastrarlos se convierten en un vértice nuevo
    ring.forEach((ll, i) => {
      const next = ring[(i + 1) % ring.length];
      const mid = L.latLng((ll.lat + next.lat) / 2, (ll.lng + next.lng) / 2);
      const m = L.marker(mid, { icon: vertexIcon('is-mid'), draggable: true, keyboard: false }).addTo(contourLayer);
      m.on('dragstart', () => { ring.splice(i + 1, 0, m.getLatLng()); });
      m.on('drag', () => { ring[i + 1] = m.getLatLng(); contourLayer.eachLayer(l => l instanceof L.Polygon && l.setLatLngs(ring)); });
      m.on('dragend', renderContour);
      m.on('click', (e) => L.DomEvent.stopPropagation(e));
    });
  }
  syncContourUi();
}

function addVertex(latlng) {
  ring.push(latlng);
  renderContour();
}

let ringBeforeDraw = [];
window.dibujarContorno = function () {
  ringBeforeDraw = ring.slice();
  ring = [];
  drawing = true;
  renderContour();
};

window.terminarContorno = function () {
  if (!drawing) return;
  if (ring.length < 3) { hint('Agrega al menos 3 vértices para cerrar el contorno.'); return; }
  drawing = false;
  renderContour();
};

window.cancelarDibujo = function () {
  ring = ringBeforeDraw;
  drawing = false;
  renderContour();
};

window.borrarContorno = async function () {
  if (!(await window.uiConfirm('¿Quitar el contorno? El editor dejará de limitar el área de esta sede.', 'Borrar contorno'))) return;
  ring = [];
  renderContour();
};

document.addEventListener('keydown', (e) => {
  if (!drawing || e.target.matches('input, textarea')) return;
  if (e.key === 'Enter') { e.preventDefault(); terminarContorno(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelarDibujo(); }
  else if (e.key === 'Backspace') { e.preventDefault(); ring.pop(); renderContour(); }
}, true);

// ----- Buscar un lugar -----
window.searchLocation = async function () {
  const query = document.getElementById('ns-search').value.trim();
  if (query.length < 2) return;
  const btn = document.getElementById('ns-search-btn');
  const resDiv = document.getElementById('ns-search-results');
  btn.textContent = 'Buscando...'; btn.disabled = true;
  try {
    const c = nsMap.getCenter();
    const params = new URLSearchParams({
      q: query,
      solo_recintos: document.getElementById('ns-solo-recintos').checked,
      lat: c.lat.toFixed(5),
      lng: c.lng.toFixed(5),
    });
    const res = await fetch(`${ROOT_PATH}/admin/api/geocode?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    resDiv.innerHTML = '';
    if (data && data.length > 0) {
      data.forEach(place => {
        const a = document.createElement('a');
        a.className = 'list-group-item list-group-item-action py-2 ns-result';
        // textContent: los nombres vienen de un servicio externo, nunca se insertan como HTML
        const title = document.createElement('div');
        title.className = 'ns-result-title';
        title.textContent = place.nombre;
        a.appendChild(title);
        if (place.detalle) {
          const sub = document.createElement('div');
          sub.className = 'panel-meta';
          sub.textContent = place.detalle;
          a.appendChild(sub);
        }
        a.onclick = () => {
          setCenter(place.lat, place.lng);
          nsMap.setView([place.lat, place.lng], 17);
          resDiv.hidden = true;
          document.getElementById('ns-search').value = place.nombre;
        };
        resDiv.appendChild(a);
      });
      resDiv.hidden = false;
    } else {
      resDiv.hidden = true;
      await window.uiAlert('No se encontraron resultados para esa búsqueda.', 'Sin resultados');
    }
  } catch (e) {
    console.error(e);
    await window.uiAlert('Error conectando con el servicio de mapas.', 'Error de conexión');
  } finally {
    btn.textContent = 'Buscar'; btn.disabled = false;
  }
};

document.addEventListener('click', (e) => {
  if (!e.target.closest('#ns-search-results') && e.target.id !== 'ns-search') {
    document.getElementById('ns-search-results').hidden = true;
  }
});

// ----- Guardar / eliminar -----
window.guardarSede = async function () {
  if (drawing) { await window.uiAlert('Termina o cancela el dibujo del contorno antes de guardar.', 'Contorno'); return; }
  const nombre = document.getElementById('ns-nombre').value.trim();
  if (!nombre) { await window.uiAlert('Ingresa un nombre para la sede.', 'Campo requerido'); return; }
  const zoom = parseInt(document.getElementById('ns-zoom').value, 10);
  if (!(zoom >= 1 && zoom <= 22)) { await window.uiAlert('El zoom inicial debe estar entre 1 y 22.', 'Zoom'); return; }
  const body = {
    nombre, zoom, lat: center[0], lng: center[1],
    contorno: ring.length >= 3 ? ring.map(ll => [ll.lng, ll.lat]) : null,
  };
  const btn = document.getElementById('ns-save');
  btn.disabled = true;
  try {
    const res = await fetch(`${ROOT_PATH}/admin/api/sedes${editingId ? `/${editingId}` : ''}`, {
      method: editingId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const msg = typeof data.detail === 'string' ? data.detail : 'Revisa los datos de la sede.';
      await window.uiAlert(msg, 'No se pudo guardar');
      return;
    }
    window.location.reload();
  } catch (err) {
    await window.uiAlert('Error de conexión al guardar la sede.', 'Error');
  } finally {
    btn.disabled = false;
  }
};

window.eliminarSede = async function (id, nombre) {
  const proceed = await window.uiConfirm(`¿Eliminar sede ${nombre} y toda su información asociada permanentemente?`, 'Eliminar sede');
  if (!proceed) return;
  try {
    const res = await fetch(`${ROOT_PATH}/admin/api/sedes/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    window.location.reload();
  } catch (e) {
    await window.uiAlert('No se pudo eliminar la sede.', 'Error');
  }
};
