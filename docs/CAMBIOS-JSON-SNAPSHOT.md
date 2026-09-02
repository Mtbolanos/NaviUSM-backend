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
