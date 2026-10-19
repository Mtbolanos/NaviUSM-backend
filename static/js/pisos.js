// =============================================================================
// Componente de pisos de un edificio, compartido por Gestión de Edificios y el editor
// de edificio. Trabaja sobre un modelo editable:
//   { nombre, accesoKey, pisos: [{ key, numero, nombre, desde }] }
// "desde" es el número que el piso tiene en el mapa actual (null si es nuevo): al aplicar,
// los nodos de ese piso pasan al número nuevo, y un piso antiguo que ya no está se elimina.
// =============================================================================
(function () {
  let keySeq = 0;

  function pisoBase(numero) {
    return numero < 0 ? `Subterráneo ${-numero}` : `Piso ${numero}`;
  }

  function plural(n, uno, varios) {
    return `${n} ${n === 1 ? uno : varios}`;
  }

  // Modelo desde una lista de pisos [{numero, nombre}] y el número de acceso
  function makeModel(nombre, pisos, acceso) {
    const model = {
      nombre: nombre || '',
      pisos: pisos.map(p => ({ key: ++keySeq, numero: p.numero, nombre: p.nombre || null, desde: p.numero })),
    };
    model.accesoKey = (model.pisos.find(p => p.numero === acceso) || model.pisos[0]).key;
    return model;
  }

  function numerosRepetidos(model) {
    const seen = new Set(), dup = new Set();
    model.pisos.forEach(p => (seen.has(p.numero) ? dup.add(p.numero) : seen.add(p.numero)));
    return dup;
  }

  function accesoNumero(model) {
    return model.pisos.find(p => p.key === model.accesoKey).numero;
  }

  // Forma comparable (independiente de las claves internas)
  function serialize(model) {
    return JSON.stringify({
      nombre: model.nombre.trim(),
      acceso: model.pisos.find(p => p.key === model.accesoKey)?.numero,
      pisos: [...model.pisos].sort((a, b) => a.numero - b.numero).map(p => [p.numero, (p.nombre || '').trim() || null, p.desde]),
    });
  }

  // El piso 0 no se agrega con los botones: se salta (de -1 se pasa a 1 y viceversa)
  function addFloor(model, donde) {
    const numeros = model.pisos.map(p => p.numero);
    let numero = donde === 'arriba' ? Math.max(...numeros) + 1 : Math.min(...numeros) - 1;
    if (numero === 0) numero = donde === 'arriba' ? 1 : -1;
    if (numeros.includes(numero)) numero = donde === 'arriba' ? Math.max(...numeros, numero) + 1 : Math.min(...numeros, numero) - 1;
    model.pisos.push({ key: ++keySeq, numero, nombre: null, desde: null });
  }

  // opts:
  //   counts(p)  -> { poi, ruta, total } de los nodos que hoy tiene el piso (p.desde)
  //   onChange() -> el modelo cambió (sin cambiar la estructura de la tabla)
  //   rerender() -> hay que volver a dibujar (cambió la estructura u orden)
  //   onVer(p)   -> opcional: botón "Ver en el mapa" en cada piso existente
  //   beforeChange() -> opcional: se llama justo antes de cada cambio (para deshacer dentro de la ventana)
  function render(container, model, opts) {
    const before = () => opts.beforeChange && opts.beforeChange();
    container.innerHTML = '';
    const dupes = numerosRepetidos(model);
    const sorted = [...model.pisos].sort((a, b) => b.numero - a.numero);
    const table = document.createElement('div');
    table.className = 'floor-table';
    table.innerHTML = `
      <div class="floor-row floor-header">
        <span>Número</span><span>Nombre (opcional)</span><span>Acceso</span><span>Puntos</span><span></span>
      </div>`;

    sorted.forEach((p, i) => {
      const isExtreme = i === 0 || i === sorted.length - 1;
      const counts = p.desde === null ? { poi: 0, ruta: 0, total: 0 } : opts.counts(p);
      const row = document.createElement('div');
      row.className = 'floor-row';

      const num = document.createElement('input');
      num.type = 'number';
      num.step = '1';
      num.className = 'form-control form-control-sm floor-num' + (dupes.has(p.numero) ? ' is-invalid' : '');
      num.value = p.numero;
      num.title = dupes.has(p.numero) ? 'Número repetido' : pisoBase(p.numero);
      num.setAttribute('aria-label', 'Número de piso');
      num.addEventListener('change', () => {
        const v = parseInt(num.value, 10);
        if (Number.isNaN(v) || v === p.numero) { num.value = p.numero; return; }
        before();
        p.numero = v;
        opts.onChange();
        opts.rerender();
      });

      const name = document.createElement('input');
      name.type = 'text';
      name.maxLength = 100;
      name.className = 'form-control form-control-sm';
      name.placeholder = pisoBase(p.numero);
      name.value = p.nombre || '';
      name.setAttribute('aria-label', 'Nombre del piso');
      // Un paso de deshacer por cada edición del nombre (desde que se enfoca hasta que se sale)
      let nameSaved = false;
      name.addEventListener('focus', () => { nameSaved = false; });
      name.addEventListener('input', () => {
        if (!nameSaved) { before(); nameSaved = true; }
        p.nombre = name.value.trim() || null;
        opts.onChange();
      });

      const accesoWrap = document.createElement('label');
      accesoWrap.className = 'floor-acceso';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `acceso-${container.id || 'pisos'}`;
      radio.checked = model.accesoKey === p.key;
      radio.title = 'Piso a nivel de la calle';
      radio.addEventListener('change', () => { before(); model.accesoKey = p.key; opts.onChange(); opts.rerender(); });
      accesoWrap.appendChild(radio);
      if (model.accesoKey === p.key) {
        const tag = document.createElement('span');
        tag.textContent = 'Acceso';
        accesoWrap.appendChild(tag);
      }

      const pts = document.createElement('span');
      pts.className = 'panel-meta';
      pts.textContent = p.desde === null ? 'Nuevo' : `${plural(counts.poi, 'punto', 'puntos')} - ${counts.ruta} de ruta`;
      pts.title = 'Puntos de interés - puntos de ruta';

      // Dos espacios fijos (Ver en el mapa | Eliminar): los botones quedan siempre en la misma columna
      const actions = document.createElement('span');
      actions.className = 'floor-actions' + (opts.onVer ? '' : ' no-ver');
      const verSlot = document.createElement('span');
      const delSlot = document.createElement('span');
      if (opts.onVer && p.desde !== null) {
        const ver = document.createElement('button');
        ver.type = 'button';
        ver.className = 'btn btn-sm btn-outline-secondary';
        ver.textContent = 'Ver en el mapa';
        ver.addEventListener('click', () => opts.onVer(p));
        verSlot.appendChild(ver);
      }
      if (isExtreme && sorted.length > 1) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn btn-sm btn-outline-danger';
        del.textContent = 'Eliminar';
        del.title = 'Solo se puede eliminar el piso superior o el inferior';
        del.addEventListener('click', () => removeFloor(model, p, counts, opts, before));
        delSlot.appendChild(del);
      }
      if (opts.onVer) actions.append(verSlot, delSlot); else actions.append(delSlot);

      row.append(num, name, accesoWrap, pts, actions);
      table.appendChild(row);
    });
    container.appendChild(table);

    if (dupes.size) {
      const warn = document.createElement('div');
      warn.className = 'text-danger small mt-1';
      warn.textContent = 'Hay números de piso repetidos: corrígelos antes de guardar.';
      container.appendChild(warn);
    }

    const add = document.createElement('div');
    add.className = 'floor-add';
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'btn btn-sm btn-outline-secondary';
    up.textContent = '+ Agregar piso arriba';
    up.addEventListener('click', () => { before(); addFloor(model, 'arriba'); opts.onChange(); opts.rerender(); });
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'btn btn-sm btn-outline-secondary';
    down.textContent = '+ Agregar subterráneo';
    down.addEventListener('click', () => { before(); addFloor(model, 'abajo'); opts.onChange(); opts.rerender(); });
    add.append(up, down);
    container.appendChild(add);
  }

  async function removeFloor(model, p, counts, opts, before) {
    if (model.accesoKey === p.key) {
      await window.uiAlert('Es el piso de acceso. Marca otro piso como acceso antes de eliminarlo.', 'Eliminar piso');
      return;
    }
    if (counts.total > 0) {
      const ok = await window.uiConfirm(
        `${pisoBase(p.numero)} tiene ${plural(counts.poi, 'punto de interés', 'puntos de interés')} y ${plural(counts.ruta, 'punto de ruta', 'puntos de ruta')}.\nSe eliminarán junto con sus conexiones.\n¿Eliminar el piso?`,
        'Eliminar piso');
      if (!ok) return;
    }
    before();
    model.pisos = model.pisos.filter(x => x.key !== p.key);
    opts.onChange();
    opts.rerender();
  }

  // Copia del modelo para deshacer / rehacer dentro de una ventana
  function cloneModel(model) {
    return { ...model, pisos: model.pisos.map(p => ({ ...p })) };
  }

  window.PisosUI = { pisoBase, plural, makeModel, numerosRepetidos, accesoNumero, serialize, addFloor, render, cloneModel };
})();
