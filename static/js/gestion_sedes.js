const ROOT_PATH = window.SEDES_CONFIG.rootPath;
let nsMap = null;
let nsMarker = null;
let currentLat = -33.036577;
let currentLng = -71.486578;

document.getElementById('newSedeModal').addEventListener('shown.bs.modal', function () {
  if (!nsMap) {
    nsMap = L.map('ns-map', { zoomControl: true }).setView([currentLat, currentLng], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 20, attribution: '&copy; OpenStreetMap'
    }).addTo(nsMap);

    nsMarker = L.marker([currentLat, currentLng], { draggable: true }).addTo(nsMap);

    nsMap.on('click', function (e) { updatePin(e.latlng.lat, e.latlng.lng); });
    nsMarker.on('dragend', function () {
      const pos = nsMarker.getLatLng();
      updatePin(pos.lat, pos.lng);
    });
  }
  nsMap.invalidateSize();
});

function updatePin(lat, lng) {
  currentLat = lat; currentLng = lng;
  nsMarker.setLatLng([lat, lng]);
  document.getElementById('ns-lat-disp').textContent = lat.toFixed(6);
  document.getElementById('ns-lng-disp').textContent = lng.toFixed(6);
}

async function searchLocation() {
  const query = document.getElementById('ns-search').value.trim();
  if (!query) return;

  const btn = document.querySelector('#ns-search + button');
  const resDiv = document.getElementById('ns-search-results');
  btn.textContent = "⏳"; btn.disabled = true;

  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`);
    const data = await res.json();

    resDiv.innerHTML = '';
    if (data && data.length > 0) {
      data.forEach(place => {
        const a = document.createElement('a');
        a.className = 'list-group-item list-group-item-action py-2';
        a.style.fontSize = '12px';
        a.style.cursor = 'pointer';
        a.textContent = place.display_name;
        a.onclick = () => {
          const lat = parseFloat(place.lat);
          const lon = parseFloat(place.lon);
          updatePin(lat, lon);
          nsMap.setView([lat, lon], 17);
          resDiv.style.display = 'none';
          document.getElementById('ns-search').value = place.name || place.display_name.split(',')[0];
        };
        resDiv.appendChild(a);
      });
      resDiv.style.display = 'block';
    } else {
      resDiv.style.display = 'none';
      await window.uiAlert("No se encontraron resultados para esa búsqueda.", "Sin resultados");
    }
  } catch (e) {
    console.error(e);
    await window.uiAlert("Error conectando con el servicio de mapas.", "Error de conexión");
  } finally {
    btn.textContent = "Buscar"; btn.disabled = false;
  }
}

// Ocultar resultados si se hace click fuera
document.addEventListener('click', (e) => {
  if (!e.target.closest('#ns-search-results') && e.target.id !== 'ns-search') {
    document.getElementById('ns-search-results').style.display = 'none';
  }
});

async function submitNuevaSede() {
  const nombre = document.getElementById('ns-nombre').value.trim();
  if (!nombre) {
    await window.uiAlert("Ingresa un nombre para la sede.", "Campo requerido");
    return;
  }
  try {
    const res = await fetch(`${ROOT_PATH}/admin/api/sedes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre, lat: currentLat, lng: currentLng, zoom: 18 })
    });
    if (!res.ok) throw new Error();
    window.location.reload();
  } catch (err) {
    await window.uiAlert("Error al crear la sede.", "Error");
  }
}

async function eliminarSede(id, nombre) {
  const proceed = await window.uiConfirm(`¿Eliminar sede ${nombre} y toda su información asociada permanentemente?`, "Eliminar Sede");
  if (!proceed) return;

  try {
    const res = await fetch(`${ROOT_PATH}/admin/api/sedes/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    window.location.reload();
  } catch (e) {
    await window.uiAlert("No se pudo eliminar la sede.", "Error");
  }
}