const ROOT_PATH = window.GESTION_CONFIG.rootPath;
const sedesInfo = window.GESTION_CONFIG.sedesInfo;
let graphPayload = null;
let sedeId = sedesInfo.length > 0 ? sedesInfo[0].id : null;

async function cargarEdificios() {
  if (!sedeId) {
    document.getElementById('bld-table-body').innerHTML = '<tr><td colspan="3" class="text-center text-muted">No hay sedes creadas.</td></tr>';
    return;
  }
  try {
    const res = await fetch(`${ROOT_PATH}/api/v1/public/sedes/${sedeId}/snapshot`);
    if (!res.ok) throw new Error();
    graphPayload = await res.json();
    renderTabla();
  } catch (e) {
    document.getElementById('bld-table-body').innerHTML = '<tr><td colspan="3" class="text-center text-danger">Aún no hay un mapa publicado. Ve a "Dibujar Mapa" primero.</td></tr>';
  }
}

function renderTabla() {
  const tbody = document.getElementById('bld-table-body');
  const blds = graphPayload.buildings.filter(b => b.id !== 'exterior');

  if (blds.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted">No hay edificios en el mapa.</td></tr>';
    return;
  }

  tbody.innerHTML = blds.map(b => `
    <tr>
      <td class="align-middle fw-bold" style="color: white;">${b.name}</td>
      <td class="text-center align-middle">
        <div class="d-flex justify-content-center align-items-center gap-3">
          <span class="text-muted" style="font-size: 11px;">Desde</span>
          <button class="btn btn-sm btn-outline-secondary py-0 px-2" onclick="modificarPiso('${b.id}', 'min', -1)">-</button>
          <span style="font-weight: bold; width: 20px;">${b.min}</span>
          <button class="btn btn-sm btn-outline-secondary py-0 px-2" onclick="modificarPiso('${b.id}', 'min', 1)">+</button>
          <span class="text-muted mx-2" style="font-size: 11px;">Hasta</span>
          <button class="btn btn-sm btn-outline-secondary py-0 px-2" onclick="modificarPiso('${b.id}', 'max', -1)">-</button>
          <span style="font-weight: bold; width: 20px;">${b.max}</span>
          <button class="btn btn-sm btn-outline-secondary py-0 px-2" onclick="modificarPiso('${b.id}', 'max', 1)">+</button>
        </div>
      </td>
      <td class="text-end align-middle">
        <button class="btn btn-sm btn-danger py-1 px-3" style="font-weight: bold;" onclick="eliminarEdificio('${b.id}')">Eliminar</button>
      </td>
    </tr>
  `).join('');
}

function modificarPiso(id, type, val) {
  const b = graphPayload.buildings.find(x => x.id === id);
  b[type] += val;
  if (b.min > b.max) b.min = b.max;
  renderTabla();
}

async function eliminarEdificio(id) {
  let salasCount = 0;
  try {
    const res = await fetch(`${ROOT_PATH}/admin/api/edificios/${id}/salas`);
    if (res.ok) {
      const salas = await res.json();
      salasCount = salas.length;
    }
  } catch (e) { }

  if (salasCount > 0) {
    if (!confirm(`ADVERTENCIA: estás a punto de borrar un edificio con ${salasCount} salas. ¿Estás seguro?`)) return;
  } else {
    if (!confirm('¿Eliminar este edificio y todos sus nodos asociados? Esta acción borrará información permanentemente.')) return;
  }

  graphPayload.buildings = graphPayload.buildings.filter(b => b.id !== id);
  graphPayload.nodes = graphPayload.nodes.filter(n => n.building !== id);
  graphPayload.zonas = graphPayload.zonas.filter(z => z.building !== id);
  renderTabla();
}

async function publicarCambios() {
  try {
    const res = await fetch(`${ROOT_PATH}/admin/api/sedes/${sedeId}/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(graphPayload)
    });
    if (!res.ok) throw new Error();
    alert("✅ Cambios guardados correctamente.");
  } catch (e) { alert("❌ Error al guardar."); }
}

window.onload = cargarEdificios;