### 1. Capa de Multi-Tenancy y Acceso

**Tabla `ORGANIZACION`** (El "Tenant" o Cliente Principal)
* `id` (UUID): Identificador único universal. Se usa UUID en vez de enteros auto-incrementales para evitar ataques de enumeración y facilitar la descentralización.
* `nombre`: Razón social o nombre oficial (ej. "Universidad Técnica Federico Santa María").
* `slug`: Un identificador URL-friendly (ej. "usm"). Útil para enrutamientos (ej. `usm.naviusm.cl`).
* `created_at`: Marca de tiempo de auditoría.

**Tabla `USUARIO`** (Gestión de Identidad)
* `organizacion_id`: **Clave del aislamiento (RLS).** Define a qué universidad pertenece este usuario.
* `email`: Credencial principal de acceso.
* `password_hash`: Hash generado por `bcrypt`. El backend jamás conoce el password en texto plano.
* `rol`: Define los privilegios (ej. `admin` vs `editor`).
* `is_active`: Permite un *soft-delete* (suspender a un trabajador sin borrar sus registros).
* `last_login`: Telemetría básica de uso de la plataforma.

**Tabla `SEDE`** (Contenedor Físico y Geográfico)
* `organizacion_id`: Asocia la sede a una universidad específica.
* `nombre`: Etiqueta física (ej. "Sede Viña del Mar").
* `latitud` / `longitud`: Coordenadas exactas que le indican al frontend dónde debe inicializar la cámara del mapa.
* `zoom_defecto`: Nivel de acercamiento óptimo para esa sede en particular.

---

### 2. Capa Estructural y de Caché

**Tabla `EDIFICIO`** (Agrupación Física Multipiso)
* *Propósito:* Agrupa lógicamente los nodos que pertenecen a una misma estructura para aislar la visualización por niveles en la interfaz.
* `sede_id` / `organizacion_id`: Trazabilidad espacial y de acceso.
* `nombre`: Identificador del edificio (ej. "Edificio C", "Casino").
* `piso_min` / `piso_max`: Define dinámicamente los selectores de nivel en el frontend (ej. si tiene subterráneos, `piso_min` podría ser -2).

**Tabla `SNAPSHOT`** (El puente Offline)
* `payload` (JSONB): Guarda el grafo completo pre-calculado en formato GeoJSON. Permite que el backend sirva el mapa sin hacer pesados *joins* espaciales en cada petición.
* `version` (INT): Fundamental para el funcionamiento offline. La app descarga el JSON y guarda esta versión para ahorrar ancho de banda y no redescargar el mapa si la versión en el servidor no ha cambiado.

---

### 3. Capa Topológica (Motor de Ruteo)

**Tabla `NODO`** (El Grafo Matemático)
* `geom` (GEOMETRY PointZ): El punto tridimensional (PostGIS). La "Z" permite entender superposición geográfica en distintos niveles.
* `piso` (INT): Atributo semántico para el filtrado en la UI (ej. Nivel 1, Nivel 2).
* `tipo`: Define el comportamiento estructural (ej. `waypoint`, `entrada`).
* `edificio_id`: Relaciona este nodo con su edificio contenedor (o nulo si está en el exterior).
* `gid` (INT SERIAL): **Requisito estricto de pgRouting.** Aunque usamos UUIDs para la arquitectura moderna, los algoritmos internos de Postgres (como Dijkstra o $A^*$) exigen identificadores numéricos secuenciales para procesar grafos a alta velocidad.

**Tabla `POI` (Puntos de Interés)** (Capa Descriptiva)
* *Propósito:* Evita saturar la tabla `NODO` con columnas nulas, ya que el 90% de los nodos serán waypoints invisibles.
* `nodo_id`: Relación 1:1 estricta. Este POI "cuelga" físicamente de un nodo topológico.
* `nombre`: Nombre legible (ej. "Baño Hombres Edificio C").
* `categoria`: Usado para botones de filtro rápido en la app ("Baños", "Seguridad").

**Tabla `ARISTA`** (Las Conexiones)
* `origen_id` / `destino_id` (UUID): Conexión arquitectónica estándar.
* `source` / `target` (INT): Mapeo directo al `gid` numérico de los nodos de origen y destino. Sin esto, pgRouting no puede calcular la topología.
* `distancia`: El "peso" precalculado de la arista.
* `es_bidireccional`: Para vías de un solo sentido (ej. torniquetes).
* `es_accesible`: Variable para excluir aristas (ej. escaleras) al calcular "Rutas para Silla de Ruedas".

---

### 4. Capa de Seguridad y Evacuación

**Tabla `RUTA_EVACUACION`** (Cabecera)
* `nombre`: Ej. "Evacuación principal Edificio C".
* `tipo_emergencia`: Permite rutas distintas según el evento (sismo vs. incendio).

**Tabla `RUTA_EVACUACION_ARISTA`** (Detalle)
* *Propósito:* Reutiliza la infraestructura existente del grafo en lugar de dibujar geometrías nuevas.
* `arista_id`: Los tramos que componen la ruta.
* `orden` (INT): Define la secuencia estricta y direccional (Paso 1, 2, 3) hacia la zona segura.