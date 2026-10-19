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
    baseLayer,
  };

  // ----- Mapa base -----
  // Con mapTiles.style_url (mosaicos vectoriales, p. ej. OpenFreeMap) el mapa se dibuja en el navegador con
  // MapLibre GL: nítido a cualquier zoom. Si no hay style_url, o MapLibre no carga (sin WebGL, CDN caído),
  // se usan los mosaicos raster de mapTiles.url.
  const MAPLIBRE_VERSION = '6.15.0';
  const ADAPTER_VERSION = '0.1.4';
  const DEFAULT_TILES = {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    max_zoom: 19,
    style_url: null,
    style_attribution: null,
  };
  let maplibrePromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
      document.head.appendChild(s);
    });
  }

  function loadMaplibre() {
    if (!maplibrePromise) {
      maplibrePromise = (async () => {
        if (!document.createElement('canvas').getContext('webgl2')) throw new Error('WebGL2 no disponible');
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = `https://cdn.jsdelivr.net/npm/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.css`;
        document.head.appendChild(css);
        // MapLibre 6 se distribuye solo como módulo ES; el adaptador para Leaflet (UMD) lo toma de window.maplibregl
        window.maplibregl = await import(`https://cdn.jsdelivr.net/npm/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.mjs`);
        await loadScript(`https://cdn.jsdelivr.net/npm/@maplibre/maplibre-gl-leaflet@${ADAPTER_VERSION}/dist/leaflet-maplibre-gl.js`);
        if (!L.maplibreGL) throw new Error('Adaptador de MapLibre no disponible');
      })();
    }
    return maplibrePromise;
  }

  // Agrega el mapa base a un mapa Leaflet. maxZoom: zoom máximo del mapa (el raster se amplía sobre max_zoom)
  function baseLayer(map, { maxZoom = 22 } = {}) {
    const t = { ...DEFAULT_TILES, ...(readJson('site-config').mapTiles || {}) };
    const addRaster = () => L.tileLayer(t.url, { maxZoom, maxNativeZoom: t.max_zoom, attribution: t.attribution }).addTo(map);
    if (!t.style_url) return addRaster();
    let fellBack = false;
    const fallback = (err, layer) => {
      if (fellBack) return;
      fellBack = true;
      console.warn('Mapa vectorial no disponible; se usa el mapa raster.', err);
      if (layer && map.hasLayer(layer)) map.removeLayer(layer);
      addRaster();
    };
    loadMaplibre().then(() => {
      const layer = L.maplibreGL({
        style: t.style_url,
        attributionControl: { customAttribution: t.style_attribution || '' },
      });
      layer.addTo(map);
      const gl = layer.getMaplibreMap();
      let loaded = false;
      gl.once('load', () => { loaded = true; });
      // Si el estilo no carga (servidor caído, URL inválida), se vuelve al raster
      gl.on('error', (e) => { if (!loaded) fallback(e && e.error, layer); });
    }).catch((err) => fallback(err));
    return null;
  }

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
