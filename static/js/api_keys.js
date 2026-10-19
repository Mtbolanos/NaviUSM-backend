const AK_ROOT = NV.site().rootPath;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtFecha(iso) {
  return iso ? new Date(iso).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' }) : '-';
}

function estadoKey(k) {
  if (k.revoked_at) return '<span class="nv-badge">Revocada</span>';
  if (k.expires_at && new Date(k.expires_at) <= new Date()) return '<span class="nv-badge nv-badge-warn">Expirada</span>';
  return '<span class="nv-badge nv-badge-ok">Activa</span>';
}

async function cargarKeys() {
  const tbody = document.getElementById('ak-body');
  try {
    const res = await fetch(`${AK_ROOT}/admin/api/api-keys`);
    if (!res.ok) throw new Error();
    const keys = await res.json();
    if (keys.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center panel-meta py-4">No hay API keys creadas.</td></tr>';
      return;
    }
    tbody.innerHTML = keys.map(k => `
      <tr>
        <td class="fw-bold">${escapeHtml(k.nombre)}</td>
        <td class="mono">${escapeHtml(k.prefijo)}...</td>
        <td>${fmtFecha(k.created_at)}</td>
        <td>${fmtFecha(k.expires_at)}</td>
        <td>${fmtFecha(k.last_used_at)}</td>
        <td>${estadoKey(k)}</td>
        <td class="text-end">${k.revoked_at ? '' :
          `<button class="btn btn-sm btn-danger" data-id="${escapeHtml(k.id)}" data-nombre="${escapeHtml(k.nombre)}" onclick="revocarKey(this)">Revocar</button>`}</td>
      </tr>`).join('');
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-danger py-4">Error cargando las API keys.</td></tr>';
  }
}

async function crearKey(ev) {
  ev.preventDefault();
  const nombre = document.getElementById('ak-nombre').value.trim();
  const fecha = document.getElementById('ak-expira').value; // YYYY-MM-DD
  if (!nombre) return;
  // La fecha elegida vence al final de ese día (hora local)
  const expires_at = fecha ? new Date(`${fecha}T23:59:59`).toISOString() : null;
  try {
    const res = await fetch(`${AK_ROOT}/admin/api/api-keys`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre, expires_at })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Error al crear la API key');
    document.getElementById('ak-nueva-valor').value = data.key;
    document.getElementById('ak-nueva').hidden = false;
    document.getElementById('ak-form').reset();
    cargarKeys();
  } catch (e) {
    await window.uiAlert(e.message, 'Error');
  }
}

async function copiarKey() {
  const input = document.getElementById('ak-nueva-valor');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch (_) {
    input.select(); document.execCommand('copy');
  }
}

async function revocarKey(btn) {
  const { id, nombre } = btn.dataset; // datos en atributos data-*: sin armar JS con texto del usuario
  const ok = await window.uiConfirm(`¿Revocar la API key "${nombre}"?\nLas apps que la usan dejarán de tener acceso de inmediato.`, 'Revocar API key');
  if (!ok) return;
  const res = await fetch(`${AK_ROOT}/admin/api/api-keys/${id}`, { method: 'DELETE' });
  if (!res.ok) await window.uiAlert('No se pudo revocar la API key.', 'Error');
  cargarKeys();
}

window.onload = cargarKeys;