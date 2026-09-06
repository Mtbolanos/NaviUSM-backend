const ROOT_PATH = window.SEDES_CONFIG.rootPath;
let nsMap = null;
let nsMarker = null;
let currentLat = -33.036577;
let currentLng = -71.486578;

// Inicializar mapa SOLO cuando el modal es visible (Evita bugs de tamaño de Leaflet en Bootstrap)
document.getElementById('newSedeModal').addEventListener('shown.bs.modal', function () {
  if (!nsMap) {
    nsMap = L.map('ns-map', { zoomControl: true }).setView([currentLat, currentLng], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 20, attribution: '&copy; OpenStreetMap'
    }).addTo(nsMap);

    nsMarker = L.marker([currentLat, currentLng], { draggable: true }).addTo(nsMap);

    // Al hacer clic en el mapa, mover el marcador
    nsMap.on('click', function(e) {
      updatePin(e.latlng.lat, e.latlng.lng);
    });

    // Al arrastrar el pin
    nsMarker.on('dragend', function() {
      const pos = nsMarker.getLatLng();
      updatePin(pos.lat, pos.lng);
    });
  }
  
  nsMap.invalidateSize();
});

function updatePin(lat, lng) {
  currentLat = lat;
  currentLng = lng;
  nsMarker.setLatLng([lat, lng]);
  document.getElementById('ns-lat-disp').textContent = lat.toFixed(6);
  document.getElementById('ns-lng-disp').textContent = lng.toFixed(6);
}

async function searchLocation() {
  const query = document.getElementById('ns-search').value.trim();
  if (!query) return;

  const btn = document.querySelector('#ns-search + button');
  btn.textContent = "⏳"; btn.disabled = true;

  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`);
    const data = await res.json();
    
    if (data && data.length > 0) {
      const lat = parseFloat(data[0].lat);
      const lon = parseFloat(data[0].lon);
      updatePin(lat, lon);
      nsMap.setView([lat, lon], 17);
    } else {
      alert("No se encontraron resultados para esa búsqueda.");
    }
  } catch (e) {
    console.error(e);
    alert("Error conectando con el servicio de mapas.");
  } finally {
    btn.textContent = "Buscar"; btn.disabled = false;
  }
}

async function submitNuevaSede() {
  const nombre = document.getElementById('ns-nombre').value.trim();
  
  if (!nombre) return alert("Ingresa un nombre para la sede.");
  
  try {
    const res = await fetch(`${ROOT_PATH}/admin/api/sedes`, {
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre, lat: currentLat, lng: currentLng, zoom: 18 })
    });
    
    if (!res.ok) throw new Error();
    window.location.reload();
  } catch (err) {
    alert("Error al crear la sede.");
  }
}