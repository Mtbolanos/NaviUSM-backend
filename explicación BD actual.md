### 1. Capa de Multi-Tenancy y Acceso

**Tabla `ORGANIZACION`** (El "Tenant" o Cliente Principal)

* `id` (UUID): Identificador único universal. Se usa UUID en vez de enteros auto-incrementales para evitar ataques de enumeración (saber cuántos clientes hay) y facilitar la descentralización.
* `nombre`: Razón social o nombre oficial (ej. "Universidad Técnica Federico Santa María").
* `slug`: Un identificador URL-friendly (ej. "usm"). Útil si en el futuro decides enrutar a los clientes mediante subdominios (ej. `usm.naviusm.cl`).
* `created_at`: Marca de tiempo de auditoría.

**Tabla `USUARIO`** (Gestión de Identidad)

* `organizacion_id`: **Clave del aislamiento (RLS).** Define a qué universidad pertenece este usuario.
* `email`: Credencial principal de acceso.
* `password_hash`: Hash generado por `bcrypt`. Por seguridad, el backend jamás conoce el password en texto plano.
* `rol`: Define los privilegios (ej. `admin` puede borrar sedes, `editor` solo puede modificar el grafo).
* `is_active`: Permite un *soft-delete* (suspender a un trabajador sin borrar sus registros de auditoría o los mapas que haya publicado).
* `last_login`: Telemetría básica de uso de la plataforma.

**Tabla `SEDE`** (Contenedor Físico y Geográfico)

* `organizacion_id`: Asocia la sede a una universidad específica.
* `nombre`: Etiqueta física (ej. "Sede Viña del Mar").
* `latitud` / `longitud`: **Aquí entran tus coordenadas exactas.** Le dicen al frontend dónde debe inicializar la cámara del mapa antes de cargar cualquier nodo.
* `zoom_defecto`: Nivel de acercamiento óptimo para esa sede en particular (algunos campus son más densos y requieren más zoom inicial que otros).

---

### 2. Capa de Caché y Offline

**Tabla `SNAPSHOT`** (El puente entre la Base de Datos y la App Móvil)

* `sede_id` / `organizacion_id`: A qué sede y tenant pertenece este "paquete" de datos.
* `payload` (JSONB): Es el corazón de la app móvil. Guarda el grafo completo pre-calculado en formato JSON nativo de Postgres. Esto permite que el backend sirva el mapa en milisegundos sin tener que hacer pesados *joins* espaciales en cada petición de un teléfono.
* `version` (INT): Fundamental para el funcionamiento offline de la app móvil. La app descarga el JSON y guarda esta versión. La próxima vez que se abre, la app solo le pregunta al servidor: *"¿Tienes una versión mayor a la 5?"*, ahorrando ancho de banda masivamente.

---

### 3. Capa Topológica (Motor de Ruteo)

**Tabla `NODO`** (El Grafo Matemático)

* `geom` (GEOMETRY PointZ): El punto tridimensional. Alimenta a PostGIS para cálculos espaciales reales. La "Z" es crítica para que el motor entienda que el piso 1 y el piso 2 están superpuestos geográficamente, pero separados físicamente.
* `piso` (INT): Atributo semántico para que la interfaz de usuario sepa qué botones de filtrado mostrar (Piso 1, 2, 3) y oculte los nodos de otros niveles.
* `tipo`: Define el comportamiento estructural (ej. `waypoint`, `ascensor`, `escalera`, `puerta`).

**Tabla `POI` (Puntos de Interés)** (Capa Descriptiva)

* *Propósito del desacople:* El 90% de la base de datos serán nodos "invisibles" (esquinas de pasillos, codos de escaleras) necesarios para que $A^*$ funcione. Separar `POI` asegura que no saturemos la tabla `NODO` con columnas nulas de nombres y descripciones.
* `nodo_id`: Relación 1:1 estricta. Este POI "cuelga" físicamente de un nodo topológico.
* `nombre`: "Baño Hombres Edificio C", "Casino".
* `categoria`: Atributo usado para agrupar los botones de filtro rápido de la app ("Mostrar todos los Baños", "Mostrar Cafeterías").

**Tabla `ARISTA`** (Las Conexiones)

* `origen_id` / `destino_id`: Los dos nodos que se conectan para formar un camino.
* `distancia`: Es el **"peso" (weight)** de la arista. Pre-calcularlo espacialmente en Postgres al insertar la arista ahorra cómputo al algoritmo de ruteo del teléfono.
* `es_bidireccional`: Booleano para vías de un solo sentido (ej. torniquetes de salida, escaleras mecánicas que solo suben).
* `es_accesible`: **Variable táctica de accesibilidad universal.** Si esta arista es una escalera, el valor es `false`. Esto permite que la app móvil tenga un toggle de "Ruta para Silla de Ruedas", lo que alterará el cálculo del algoritmo para ignorar estas aristas.

---

### 4. Capa de Seguridad y Evacuación

**Tabla `RUTA_EVACUACION`** (Cabecera)

* `nombre`: Ej. "Evacuación principal Edificio C".
* `tipo_emergencia`: Permite tener rutas distintas según el evento (ej. ruta contra incendio vs. zonas de seguridad por sismo).

**Tabla `RUTA_EVACUACION_ARISTA`** (Tabla de detalle Many-to-Many)

* *Propósito:* En lugar de dibujar líneas nuevas en el mapa para las evacuaciones, reutilizamos la infraestructura existente.
* `arista_id`: Cuáles tramos de camino componen la ruta segura.
* `orden` (INT): Define la secuencia estricta. Una ruta de evacuación no es ruteo libre, es un camino direccional obligatorio (Paso 1, Paso 2, Paso 3) hacia la zona segura.