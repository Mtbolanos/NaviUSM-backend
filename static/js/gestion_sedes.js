async function submitNuevaSede() {
  const ROOT_PATH = window.SEDES_CONFIG.rootPath;
  const nombre = document.getElementById('ns-nombre').value.trim();
  const lat = parseFloat(document.getElementById('ns-lat').value) || -33.036577;
  const lng = parseFloat(document.getElementById('ns-lng').value) || -71.486578;
  
  if (!nombre) return alert("Ingresa un nombre");
  
  await fetch(`${ROOT_PATH}/admin/api/sedes`, {
    method: 'POST', 
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre, lat, lng, zoom: 18 })
  });
  
  window.location.reload();
}