# Cambios al JSON del snapshot

## Formato 2.2: pisos de edificio (`meta.version = "2.2"`)

_2026-10_

El snapshot se obtiene con `GET /api/v1/mobile/sedes/{sede_id}/snapshot` (app móvil, con token de sesión) y es el
mismo JSON que publica el editor. Desde esta versión el servidor normaliza los edificios antes de guardarlo, así que
todo snapshot publicado de aquí en adelante viene en este formato.

### `buildings[]`: `min`/`max` se reemplazan por `acceso` y `pisos`

Antes:

```json
{ "id": "c1a2...", "name": "Edificio A", "min": 1, "max": 4 }
```

Ahora:

```json
{
  "id": "c1a2...",
  "name": "Edificio A",
  "acceso": 1,
  "pisos": [
    { "numero": -1, "nombre": null },
    { "numero": 1, "nombre": null },
    { "numero": 2, "nombre": "Mezzanine" }
  ]
}
```

| Campo | Tipo | Notas |
|---|---|---|
| `acceso` | int | Piso a nivel de la calle (en Chile, normalmente el 1). Siempre es uno de los números de `pisos`. |
| `pisos` | array | Ordenado de menor a mayor. Al menos un piso. Números enteros únicos; negativos = subterráneos; puede haber huecos y el 0 es posible. |
| `pisos[].numero` | int | El mismo valor que usan los nodos en `floor`. |
| `pisos[].nombre` | string \| `null` | Nombre opcional. Si es `null`, mostrar "Piso N" o "Subterráneo N". |

- `min` y `max` ya no vienen. Un consumidor que los necesite puede calcularlos con el primer y el último `numero`.
- Garantía: todo nodo con `building` distinto de `"exterior"` tiene `floor` igual a uno de los `pisos` de su edificio
  (el publish rechaza lo contrario).
- `nodes`, `edges` y `zonas` no cambian.
- El nodo `type: "building"` (punto de acceso del edificio) sigue en el exterior: `building: "exterior"`, `floor: 1`.

---

# Cambios al JSON del snapshot (zonas + POIs de servicio)

_2026-09-02_

El snapshot público (`GET /api/v1/public/sedes/{sede_id}/snapshot`) devuelve **exactamente** el `payload` que `admin.js` manda al publicar (`POST /admin/api/sedes/{sede_id}/publish`) — no se reconstruye desde las tablas. Por eso cualquier cambio de forma en el payload de publish es, uno a uno, un cambio de forma en el JSON que consume el frontend/móvil.

Antes el payload tenía `buildings`, `nodes`, `edges`. Ahora hay dos cambios: una key nueva (`zonas`) y campos nuevos condicionales en algunos `nodes`.

## 1. Key nueva: `zonas`

```json
{
  "buildings": [ /* sin cambios */ ],
  "nodes": [ /* ver sección 2 */ ],
  "edges": [ /* sin cambios */ ],
  "zonas": [
    {
      "id": "418bd183-...",
      "building": "c1a2b3-...",
      "name": "Patio Central",
      "tags": ["zona_segura"],
      "color": "#1f7a5c",
      "geojson": { "type": "Polygon", "coordinates": [[[-71.55, -33.02], ["..."], ["..."]]] }
    }
  ]
}
```

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid | mismo id se reusa en updates (edición in-place, no se recrea) |
| `building` | uuid \| `null` | `null` si la zona es exterior (ej. patio); si tiene valor, es el edificio al que pertenece o cuyo contorno dibuja |
| `name` | string | |
| `tags` | string[] | códigos de `caracteristica`. Hoy solo se usan `"zona_segura"` y `"contorno_edificio"`, pero el modelo soporta más de un tag por zona |
| `color` | string (hex) | color propio de la zona; si no viene, el consumidor debería caer al color de la característica |
| `geojson` | GeoJSON geometry | **geometría pura** (`Polygon`), no un `Feature` — sin `properties` embebidas |

## 2. Nodos (`nodes`): nuevo tipo `servicio` con campos extra condicionales

Se agregó un tipo de nodo nuevo (ícono 🏥) pensado para "cosas de interés" con info de contacto (enfermería, casino, etc.). Un nodo de tipo `servicio` trae 3 campos que el resto de los tipos **no tiene**:

```json
{
  "id": "...",
  "type": "servicio",
  "name": "Enfermería",
  "icon": "🏥",
  "lat": -33.02,
  "lng": -71.55,
  "floor": 1,
  "building": "...",
  "horario": "L-V 9:00-18:00",
  "descripcion": "Atención de primeros auxilios",
  "link_derivacion": "https://..."
}
```

- `horario`, `descripcion`, `link_derivacion` solo aparecen si `type === "servicio"` — se agregan con spread condicional en `admin.js`, no están presentes (ni como `null`) en los demás tipos (`waypoint`, `entrance`, `baño`, `seguridad`, `building`).
- **Sí son columnas nuevas en la BD** (`poi.horario`, `poi.descripcion`, `poi.link_derivacion`, agregadas en `schema_actualizado.sql` en esta misma sesión). El insert en `publish_graph_data` (paso 3) se actualizó junto con el schema para escribirlas. Antes no existía forma de setear esta info para ningún nodo.

## Resumen para quien consuma el snapshot (mapa / app móvil)

- Esperar una key `zonas` nueva: array de polígonos GeoJSON con `tags`/`color`/`building`, útil para pintar zonas seguras y contornos de edificio.
- Esperar que algunos `nodes` con `type: "servicio"` traigan `horario`/`descripcion`/`link_derivacion` — pensados para mostrar en un popup en vez de solo el ícono.
- Todo lo demás (`buildings`, `edges`, resto de tipos de `nodes`) no cambió de forma.
