// =============================================================================
// Base de todas las páginas (se carga en <head>, sin defer).
//   - Tema antes de pintar (evita el parpadeo): preferencia guardada o ajuste del sistema.
//   - Configuración de la página: bloques <script type="application/json"> que deja el template
//     (#site-config en base.html, #page-config en cada página). Se leen con NV.site() y NV.page().
//   - Diálogos uiAlert / uiConfirm.
//   - Selector de tema y enlace activo de la barra de navegación.
// =============================================================================
(function () {
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  function storedPref() {
    try { return localStorage.getItem('naviusm-theme') || 'system'; } catch (e) { return 'system'; }
  }

  function applyTheme(pref) {
    const theme = pref === 'dark' || (pref === 'system' && media.matches) ? 'dark' : 'light';
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-bs-theme', theme);
    root.setAttribute('data-theme-pref', pref);
    document.querySelectorAll('.theme-opt').forEach(b => b.classList.toggle('active', b.dataset.themePref === pref));
  }

  applyTheme(storedPref());
  media.addEventListener('change', () => { if ((root.getAttribute('data-theme-pref') || 'system') === 'system') applyTheme('system'); });
  // Otra pestaña cambió el tema
  window.addEventListener('storage', (e) => { if (e.key === 'naviusm-theme') applyTheme(storedPref()); });

  window.setThemePreference = function (pref) {
    try { localStorage.setItem('naviusm-theme', pref); } catch (e) { }
    applyTheme(pref);
  };

  // ----- Configuración -----
  const cache = {};
  function readJson(id) {
    if (!(id in cache)) {
      const el = document.getElementById(id);
      try { cache[id] = el ? JSON.parse(el.textContent) : {}; } catch (e) { cache[id] = {}; }
    }
    return cache[id];
  }
  window.NV = {
    site: () => readJson('site-config'),
    page: () => readJson('page-config'),
  };

  // ----- Diálogos -----
  // Título y mensaje pueden incluir nombres ingresados por usuarios: se escapan antes de insertarlos como HTML
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  window.createDynamicModal = function (message, title, showCancel) {
    return new Promise((resolve) => {
      const modalId = 'ui-modal-' + Math.random().toString(36).substring(2, 10);
      const html = `
        <div class="modal fade ui-modal" id="${modalId}" tabindex="-1" aria-hidden="true">
          <div class="modal-dialog modal-dialog-centered modal-sm">
            <div class="modal-content">
              <div class="modal-header border-0 pb-0">
                <h6 class="modal-title fw-bold">${esc(title)}</h6>
              </div>
              <div class="modal-body pb-0 ui-modal-body">${esc(message).replace(/\n/g, '<br>')}</div>
              <div class="modal-footer border-0 pt-3">
                ${showCancel ? '<button type="button" class="btn btn-sm btn-secondary" data-bs-dismiss="modal">Cancelar</button>' : ''}
                <button type="button" class="btn btn-sm btn-accent btn-confirm">Aceptar</button>
              </div>
            </div>
          </div>
        </div>`;
      document.body.insertAdjacentHTML('beforeend', html);
      const modalEl = document.getElementById(modalId);
      const modal = new bootstrap.Modal(modalEl);
      let resolved = false;
      modalEl.querySelector('.btn-confirm').addEventListener('click', () => {
        resolved = true;
        resolve(true);
        modal.hide();
      });
      modalEl.addEventListener('hidden.bs.modal', () => {
        if (!resolved) resolve(false);
        modalEl.remove();
      });
      modal.show();
    });
  };
  window.uiConfirm = (msg, title = 'Confirmar acción') => window.createDynamicModal(msg, title, true);
  window.uiAlert = (msg, title = 'Aviso') => window.createDynamicModal(msg, title, false);

  // ----- Al cargar: selector de tema y enlace activo -----
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(root.getAttribute('data-theme-pref') || 'system');
    document.querySelectorAll('.theme-opt').forEach(b => b.addEventListener('click', () => window.setThemePreference(b.dataset.themePref)));
    const currentPath = window.location.pathname.replace(/\/$/, '');
    document.querySelectorAll('#main-navbar .nav-link').forEach(link => {
      link.classList.toggle('active', new URL(link.href).pathname.replace(/\/$/, '') === currentPath);
    });
  });
})();
