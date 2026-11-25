# Plan de Revisión y Alineación: Zonas, Sedes y Mapa Operativo en Laundry

> **Objetivo:** Auditar y alinear la lógica de **Zonas**, **Sedes** y **Mapa Operativo** en **Laundry Clean & Fresh** (`LaundryBackend` + `LaundryWeb`) para que cumpla el mismo estándar limpio, espacial, en tiempo real y con **Mapbox + WebSockets** ya probado en **AnubisRide**, preservando y fortaleciendo el agregado propio de Laundry (**gestión de Sedes / Plantas de lavado vinculadas a Zonas**).

---

## 1. Diagnóstico Comparativo: AnubisRide vs. Estado Actual en Laundry

| Capacidad | Referencia funcional en AnubisRide | Estado actual en Laundry | Brecha / Acción requerida |
| :--- | :--- | :--- | :--- |
| **Motor de mapas Web** | `mapbox-gl` + `@mapbox/mapbox-gl-draw` (`ZoneMapView.tsx`, `ZoneDrawMapModal.tsx`) | `leaflet` (`BaseMap.tsx`) con dibujo manual por clics, aunque `LaundryWeb/.env` ya tiene `VITE_MAPBOX_PUBLIC_TOKEN` | Migrar Mapa Operativo y Editor de Zonas/Sedes en `LaundryWeb` a **Mapbox GL JS + MapboxDraw** (`streets-v12`). |
| **Algoritmo espacial e índice en Backend** | Bounding Box `O(1)` + Ray-Casting + caché en memoria (`ActiveZonesSpatialIndexProvider`, TTL 60s + invalidación por generación) | `pointInPolygon` directo en `GeoService` consultando `prisma.zone.findMany()` en cada `resolveZone` | Agregar **Bounding Box pre-check**, **validación de geometría** y **caché espacial en memoria con invalidación inmediata** en `LaundryBackend/src/geo`. |
| **Integridad Zona ↔ Sede en Backend** | N/A (solo Zonas) | `GeoService.createFacility` / `updateFacility` / `updateZone` **NO** validan en servidor que la sede caiga dentro del polígono ni que editar el polígono deje sedes fuera (solo se valida en frontend) | Portar las reglas geométricas de `zone.rules.ts` al **servidor (`GeoService`)** como fuente única de verdad. |
| **Endpoints operativos y métricas** | `POST /zones/by-point`, `GET /zones/metrics/summary`, `GET /zones/:id/drivers`, `GET /zones/active/online-drivers`, `GET /zones/active/requested-trips` | Solo CRUD básico (`GET/POST/PATCH /zones` y `/facilities`) | Añadir endpoints de consulta por punto, métricas por zona y snapshot operativo (choferes online + pedidos activos + sedes). |
| **Tiempo real (WebSockets Admin)** | `SocketGateway` con canal `admin:map:subscribe`, `admin:map:snapshot`, `admin:map:driver-locations` (throttled/batch), `admin:map:driver-offline`, `admin:map:trip-*` + `useZoneMapRealtime.ts` | `TrackingGateway` solo cubre cliente/chofer (`order:<id>`). `OperationalMapPage.tsx` usa datos locales/simulados (*"Movimiento de choferes simulado"*) | Extender `TrackingGateway` con canal `admin:map:*` (para `ADMIN` y `SUPERVISOR`) y conectar `OperationalMapPage.tsx` vía `socket.io-client` con respaldo REST. |
| **Persistencia Frontend (`Sedes` y `Zonas`)** | `HttpZoneRepository.ts` directo al backend | Mezcla `localStorage` (`LocalZoneRepository.ts`, `ZONES_KEY`) con `geoApi.ts` | Eliminar dependencia de `localStorage` como estado fuente; usar API REST como fuente única de verdad. |
| **Navegación desde pines del Mapa Operativo** | Usa tipo de marcador + ID real | `OperationalMapPage.tsx` usa prefijos mock (`SOL-`, `FAC-`, `DRV-`) que fallan con UUIDs reales | Navegar según `point.kind` (`pickup`/`delivery` → orden, `facility` → sedes, `driver` → choferes, `incident` → incidencias). |

---

## 2. Arquitectura Objetivo (Flujo Completo)

```mermaid
flowchart LR
  subgraph Web["LaundryWeb (Admin / Supervisor)"]
    SedesUI["FacilitiesPage + ZonesPanel<br/>(Mapbox GL + MapboxDraw)"]
    MapUI["OperationalMapPage<br/>(Mapbox GL + useOperationalMapRealtime)"]
  end

  subgraph Backend["LaundryBackend (NestJS)"]
    GeoCtrl["GeoController<br/>(/zones, /facilities, /by-point, /metrics)"]
    GeoSvc["GeoService + SpatialIndexCache<br/>(BBox + RayCasting + Reglas Zona-Sede)"]
    OrdersSvc["OrdersService<br/>(assertCoverage en INBOUND/OUTBOUND)"]
    WS["TrackingGateway<br/>(Canal admin:map:*)"]
  end

  subgraph Mobile["Apps Móviles"]
    Driver["LaundryDriver<br/>(GPS WebSocket)"]
    Client["LaundryApp<br/>(Creación de Pedido)"]
  end

  SedesUI -- "REST CRUD Zonas y Sedes" --> GeoCtrl
  GeoCtrl --> GeoSvc
  GeoSvc -- "Invalida caché espacial + notifica admin:map" --> WS
  Client -- "POST /orders" --> OrdersSvc
  OrdersSvc -- "Valida cobertura en zona activa" --> GeoSvc
  Driver -- "driver:location" --> WS
  WS -- "admin:map:snapshot / driver-locations / order-updated" --> MapUI
  MapUI -. "Fallback REST si WS cae" .-> GeoCtrl
```

---

## 3. Plan Detallado por Fases

### Fase 1 — Backend Espacial, Caché e Integridad Zona ↔ Sede (`LaundryBackend`)

**Archivos objetivo:**
- `src/geo/geo-spatial.util.ts` *(nuevo — portado de `uber-backend/src/modules/zones/domain/zones-spatial.util.ts`)*
- `src/geo/active-zones-spatial-index.provider.ts` *(nuevo — portado de `ActiveZonesSpatialIndexProvider`)*
- `src/geo/geo.service.ts` *(actualizar)*
- `src/geo/geo.controller.ts` *(actualizar)*
- `src/geo/geo.module.ts` *(actualizar)*
- `src/orders/orders.service.ts` *(verificar uso consistente)*

**Checklist de revisión e implementación:**
1. **Utilidades espaciales y validación geométrica (`geo-spatial.util.ts`):**
   - Implementar `boundingBoxFromRing`, `isPointInBoundingBox`, `isPointInPolygonRing` (Ray-Casting) y `buildZoneSpatialIndex`.
   - Validar al crear/actualizar zona que el polígono tenga `>= 3` vértices únicos, coordenadas finitas válidas (`lat ∈ [-90, 90]`, `lng ∈ [-180, 180]`), área positiva y **sin auto-intersecciones**.
2. **Índice espacial en memoria (`ActiveZonesSpatialIndexProvider`):**
   - Cachear zonas activas en RAM con TTL de 60 s y contador `generation` para evitar condiciones de carrera.
   - Llamar `spatialIndex.invalidate()` en toda escritura (`createZone`, `updateZone`).
   - Refactorizar `GeoService.resolveZone(point)` para consultar el índice espacial (BBox `O(1)` → Ray-Casting) en lugar de hacer `findMany()` a PostgreSQL en cada llamada.
3. **Reglas de negocio del agregado Sedes en servidor (`GeoService`):**
   - En `createFacility` y `updateFacility`: validar con `isPointInPolygon` que `(latitude, longitude)` **esté dentro del polígono de `zoneId`** (lanzar `UnprocessableEntityException` / `BadRequestException` si cae fuera).
   - En `updateZone`:
     - Si cambia `polygon`, verificar que **todas las sedes vinculadas** a esa zona sigan cayendo dentro del nuevo polígono; si alguna queda fuera, rechazar con `ConflictException`.
     - Si cambia `polygon` o `active: false`, verificar que no existan **pedidos en curso** (`status NOT IN ('COMPLETED', 'CANCELLED')`) en las sedes de esa zona (o mantener coherencia con `assertZoneHasNoActiveFacilities`).
4. **Nuevos endpoints operativos en `GeoController`:**
   - `POST /zones/by-point` (`{ lat, lng }`): devuelve la zona activa (y sus sedes activas) que cubre el punto, o `404` si está fuera de cobertura.
   - `GET /zones/metrics/summary` (`ADMIN`, `SUPERVISOR`): métricas por zona (sedes activas, choferes disponibles/en servicio, pedidos activos de recogida/entrega).
   - `GET /zones/operational-snapshot` (`ADMIN`, `SUPERVISOR`): snapshot REST unificado de zonas activas, sedes, choferes online con última ubicación GPS y pedidos en curso (respaldo del Mapa Operativo).
5. **Verificación en `OrdersService`:**
   - Confirmar que al crear o reprogramar un pedido (`INBOUND` y `OUTBOUND` si es `HOME_HOME`), la dirección del cliente se valide contra el polígono vigente de la zona de la sede (`assertCoverage`), y que la sede y su zona estén activas.

---

### Fase 2 — WebSockets en Tiempo Real para el Mapa Operativo (`LaundryBackend`)

**Archivos objetivo:**
- `src/tracking/tracking.gateway.ts` *(extender)*
- `src/tracking/tracking.constants.ts` *(añadir eventos `admin:map:*`)*
- `src/drivers/drivers.service.ts` *(notificar cambio de estado/ubicación al canal admin)*
- `src/orders/orders.service.ts` *(notificar creación/cambio de estado de pedido al canal admin)*

**Checklist de revisión e implementación:**
1. **Room y autenticación de personal (`admin:map`):**
   - Al autenticar un socket con rol `ADMIN` o `SUPERVISOR`, permitir `@SubscribeMessage('admin:map:subscribe')` (rechazar otros roles con `admin:map:error`).
   - Unir al socket al room `admin:map` (para `SUPERVISOR`, opcionalmente filtrar por su `facilityId` si aplica).
2. **Snapshot inicial (`admin:map:snapshot`):**
   - Al suscribirse, emitir inmediatamente el estado real actual:
     - `drivers`: choferes activos (`AVAILABLE`, `ON_SERVICE`, `BREAK`) con `driverId`, `name`, `status`, `facilityId`, `zoneIds`, `lat`, `lng`, `heading`, `speed`, `locationAt`.
     - `orders`: pedidos en etapas operativas de mapa (`PICKUP_PENDING`..`ARRIVED_FOR_PICKUP`, `DELIVERY_ASSIGNED`..`ARRIVED_FOR_DELIVERY`) con coordenadas de cliente y estado.
     - `incidents`: incidencias abiertas vinculadas a pedidos activos.
3. **Emisiones incrementales con throttle (patrón Anubis):**
   - `admin:map:driver-locations`: throttle por chofer (p. ej. cada 2–3 s) al recibir `driver:location` o `PATCH /drivers/me/location`, evitando saturar el navegador.
   - `admin:map:driver-offline`: emitir cuando un chofer se desconecta o pasa a `OFFLINE`.
   - `admin:map:order-updated`: emitir cuando un pedido se crea o cambia de estado (para actualizar/retirar pines de recogida/entrega en el mapa sin recargar).

---

### Fase 3 — Configuración de Mapbox GL JS + MapboxDraw en `LaundryWeb`

**Archivos objetivo:**
- `LaundryWeb/package.json` *(instalar `mapbox-gl`, `@mapbox/mapbox-gl-draw`, `socket.io-client` y tipos)*
- `LaundryWeb/src/config/mapbox.ts` *(nuevo — equivalente a `uber-web/src/config/mapbox.ts`, leyendo `VITE_MAPBOX_PUBLIC_TOKEN` y `VITE_MAPBOX_STYLE`)*
- `LaundryWeb/src/config/mapboxMapRuntime.ts` *(nuevo — portado de Anubis para suprimir capas 404 como `mapbox-traffic-v1` y manejar errores de estilo)*
- `LaundryWeb/src/components/maps/mapboxGeo.ts` *(nuevo — conversión limpia entre GeoJSON `[lng, lat]` y `{ lat, lng }`, cálculo de bounds/centro)*

**Checklist de revisión e implementación:**
1. Instalar dependencias en `LaundryWeb`: `mapbox-gl`, `@mapbox/mapbox-gl-draw`, `socket.io-client` (y `@types/mapbox-gl` si aplica).
2. Configurar estilo claro por defecto (`mapbox://styles/mapbox/streets-v12`) y fallback limpio si falta el token (`MapboxTokenMissing`).
3. Reutilizar `configureMapboxMap(map)` de Anubis para evitar errores 404 en consola por fuentes no habilitadas.
4. Asegurar que todos los mapas en `LaundryWeb` respondan a `ResizeObserver` (`map.resize()`) dentro de modales, drawers y layouts responsivos.

---

### Fase 4 — Apartado **Sedes** (`FacilitiesPage.tsx` + `ZonesPanel.tsx`)

**Archivos objetivo:**
- `LaundryWeb/src/features/logistics/FacilitiesPage.tsx`
- `LaundryWeb/src/features/logistics/zones/ZonesPanel.tsx`
- `LaundryWeb/src/features/logistics/zones/ZoneEditor.tsx` *(migrar a `MapboxDraw`: `draw_polygon`, `direct_select`, `trash`)*
- `LaundryWeb/src/features/logistics/zones/FacilityLocationPicker.tsx` y `FacilityPinPreview.tsx` *(migrar a Mapbox GL JS)*
- `LaundryWeb/src/features/logistics/zones/useZones.ts` *(fuente única de verdad HTTP, sin estado fantasma en `localStorage`)*
- `LaundryWeb/src/services/api/geoApi.ts` *(añadir `findZoneByPoint`, `getZonesMetricsSummary`)*

**Checklist de revisión e implementación:**
1. **Dibujo y edición de Zonas con MapboxDraw:**
   - Al crear zona: abrir modal con `MapboxDraw` en modo `draw_polygon` (con botón de cancelar/borrar, validación de `>= 3` vértices y auto-cierre).
   - Al editar zona: cargar el polígono existente en `MapboxDraw` en modo `direct_select` (edición directa de vértices) y ajustar la cámara con `fitBounds`.
   - Mostrar las demás zonas existentes y los pines de **Sedes** como referencia visual en el mapa mientras se edita, impidiendo visual y lógicamente dejar una sede fuera de su zona.
2. **Registro y edición de Sedes (agregado de Laundry):**
   - Seleccionar zona → colocar/arrastrar pin de sede sobre el mapa Mapbox GL JS con el polígono de la zona resaltado.
   - Validar en tiempo real con `zoneContains` (y en el servidor al guardar) que el pin esté dentro de la zona activa.
   - Integrar búsqueda de dirección y geocodificación inversa (`MapboxGeoProvider`) para autocompletar dirección y ciudad al colocar el pin.
   - Validar capacidad diaria (`>= 1 kg`), horarios de apertura/cierre, días operativos y estado (`ACTIVE` / `MAINTENANCE`), mostrando mensajes claros del backend si hay pedidos abiertos al intentar desactivar.
3. **Visualización de Zonas + Sedes en `ZonesPanel`:**
   - Renderizar capas GeoJSON (`zones-source`) con relleno/borde diferenciado para zonas activas vs. inactivas y zona seleccionada.
   - Popups interactivos al hacer clic en una zona o sede (nombre, estado, sedes vinculadas, capacidad total, métricas).
   - Eliminar el guardado/lectura silenciosa desde `localStorage` (`LocalZoneRepository`) para que recargar la página refleje siempre los datos reales de PostgreSQL.

---

### Fase 5 — Apartado **Mapa Operativo** (`OperationalMapPage.tsx`) *(Completada)*

**Archivos objetivo:**
- `LaundryWeb/src/services/realtime/adminSocketService.ts`
- `LaundryWeb/src/hooks/useOperationalMapRealtime.ts`
- `LaundryWeb/src/features/logistics/OperationalMapPage.tsx`
- `LaundryWeb/src/components/maps/MapboxZoneMap.tsx`

---

### Fase 6 — Historial de Recorrido (PostgreSQL), Alertas de Chofer Inactivo y Filtro por Estado

Esta fase completa los 3 puntos operativos restantes sobre la base ya implementada de Mapbox + WebSockets (`admin:map:*`), manteniendo el alcance estricto de `SUPERVISOR` a su sede/zona asignada.

#### 6.1 Historial de recorrido persistido en PostgreSQL (`LaundryBackend`)

**Modelo Prisma aditivo (`prisma/schema.prisma`):**
```prisma
model DriverLocationPoint {
  id         String   @id @default(uuid()) @db.Uuid
  driverId   String   @db.Uuid
  driver     Driver   @relation(fields: [driverId], references: [id], onDelete: Cascade)
  orderId    String?  @db.Uuid
  order      Order?   @relation(fields: [orderId], references: [id], onDelete: SetNull)
  latitude   Decimal  @db.Decimal(9, 6)
  longitude  Decimal  @db.Decimal(9, 6)
  heading    Float?
  speed      Float?
  recordedAt DateTime @default(now())

  @@index([driverId, recordedAt])
  @@index([orderId, recordedAt])
}
```
> [!IMPORTANT]
> La migración Prisma (`prisma migrate dev --name add_driver_location_history`) es **100% aditiva** (no modifica ni borra tablas existentes) y se ejecutará únicamente con confirmación explícita.

**Estrategia de escritura eficiente (sin saturar PostgreSQL):**
- En `TrackingGateway.flushLocationWrites()` (batch cada 2 s) y `recordDriverLocationFromHttp()`:
  - Mantener en memoria el último punto persistido por `driverId` (`lastPersistedPoint`).
  - Insertar en `DriverLocationPoint` solo si han pasado **≥ 15 segundos** o el chofer se desplazó **≥ 25 metros** (Haversine) desde el último punto guardado.
  - Asociar `orderId` automáticamente cuando el chofer tenga un tramo activo (`HEADING_TO_PICKUP`, `PICKED_UP`, `HEADING_TO_FACILITY`, `OUT_FOR_DELIVERY`).

**Nuevo endpoint REST (`DriversController` / `DriversService`):**
- `GET /drivers/:id/location-history?from=ISO&to=ISO&orderId=UUID&limit=500`
  - Roles: `ADMIN` (cualquier chofer) y `SUPERVISOR` (**solo choferes de su `facilityId`**; si pertenece a otra sede responde `404`).
  - Rango por defecto: últimas 6 horas (máximo 24 horas por consulta para proteger rendimiento).
  - Respuesta: lista ordenada cronológicamente de `{ latitude, longitude, heading, speed, orderId, recordedAt }` + resumen (`totalPoints`, `distanceMeters`, `firstAt`, `lastAt`).

#### 6.2 Alertas activas de chofer inactivo (`LaundryBackend` + `LaundryWeb`)

**Reglas de detección (`src/tracking/driver-inactivity.util.ts`):**
- Un chofer genera alerta activa cuando cumple cualquiera de estas condiciones:
  1. **`NO_SIGNAL_ON_SERVICE` (Crítica):** `status === 'ON_SERVICE'` y han pasado **≥ 3 minutos** sin recibir señal GPS (`Date.now() - locationAt >= 180_000`).
  2. **`NO_SIGNAL_AVAILABLE` (Advertencia):** `status === 'AVAILABLE'` y han pasado **≥ 5 minutos** sin recibir señal GPS (`Date.now() - locationAt >= 300_000`).
  3. **`STATIONARY_ON_SERVICE` (Advertencia):** `status === 'ON_SERVICE'` con señal GPS reciente, pero sin moverse más de **30 metros** en los últimos **8 minutos** durante un tramo en ruta (`HEADING_TO_PICKUP` / `OUT_FOR_DELIVERY`).
- **Emisión en tiempo real (`TrackingGateway`):**
  - Evaluador periódico cada 30 s (`setInterval` con `.unref()`) sobre los choferes activos.
  - Incluir `alerts: AdminMapDriverAlert[]` dentro de `admin:map:snapshot` y emitir cambios por `admin:map:driver-alerts` hacia `admin:map:all` (ADMIN) y `admin:map:facility:<facilityId>` (SUPERVISOR, filtrado solo a su sede).
  - Incluir también `alerts` en el respaldo REST `GET /zones/operational-snapshot`.

#### 6.3 UI en `LaundryWeb` (`OperationalMapPage.tsx` + `MapboxZoneMap.tsx`)

1. **Filtro por estado de chofer (`MapLayersToolbar.tsx` / `OperationalMapPage.tsx`):**
   - Selector adicional junto al filtro de zona: `Todos los estados`, `Disponible`, `En servicio`, `En descanso`, `Desconectado`, `Con alerta / Sin señal`.
   - Aplica simultáneamente al mapa Mapbox, al selector de seguimiento (`DriverMapControls`) y a la tabla inferior (`MapLocations`).
2. **Panel de alertas de chofer inactivo (`DriverInactivityAlerts.tsx`):**
   - Banner/lista compacta encima del mapa (solo visible cuando existen alertas activas) mostrando nombre del chofer, severidad (`Crítica` / `Advertencia`), motivo (p. ej. *"Sin señal GPS hace 6 min · En servicio"*) y botón **"Ubicar"** que centra y selecciona al chofer en Mapbox.
3. **Visor de historial de recorrido en Mapbox (`DriverRouteHistoryPanel.tsx` + `MapboxZoneMap.tsx`):**
   - Controles para elegir un chofer + rango rápido (`Última hora`, `Hoy`, `Últimas 24 h`) y cargar `GET /drivers/:id/location-history`.
   - Nueva capa GeoJSON en `MapboxZoneMap.tsx` (`history-route-source` / `history-route-line`) que dibuja la **polilínea histórica** en azul índigo con marcador de **Inicio** y **Fin**, distancia total recorrida y botón **"Limpiar recorrido"**.

---

## 4. Plan de Verificación (Pruebas Automatizadas y E2E)

### Backend (`LaundryBackend`)
- **Pruebas unitarias (`test/unit/geo-zones.test.ts`):**
  - `isPointInBoundingBox` y `isPointInPolygonRing` (dentro, fuera, borde, polígonos cóncavos, coordenadas inválidas).
  - Validación de polígonos malformados o auto-intersecados.
  - `ActiveZonesSpatialIndexProvider`: hit de caché, invalidación por generación al crear/actualizar zona.
  - Reglas Zona ↔ Sede: rechazar sede fuera del polígono de su zona; rechazar edición de polígono que deje una sede activa fuera; rechazar desactivación de zona con sedes activas.
- **Pruebas de historial y alertas (`test/unit/driver-history-alerts.test.ts`):**
  - Regla de muestreo (descarta puntos < 15 s y < 25 m; persiste al superar umbral).
  - Detección de `NO_SIGNAL_ON_SERVICE`, `NO_SIGNAL_AVAILABLE` y `STATIONARY_ON_SERVICE`.
  - Alcance de `SUPERVISOR`: solo recibe historial y alertas de choferes de su `facilityId`.
- **Comandos:** `pnpm typecheck && pnpm build && pnpm test`.

### Frontend Web (`LaundryWeb`)
- **Prueba funcional end-to-end en navegador (`localhost:3000`):**
  1. **Sedes → Crear zona** en MapboxDraw → verificar persistencia en PostgreSQL tras recargar (`F5`).
  2. **Sedes → Registrar sede** dentro/fuera de zona y validar bloqueo en UI + API.
  3. **Mapa Operativo** → verificar filtros por capa, zona y **estado de chofer**; confirmar aparición de **alerta de chofer inactivo** y botón "Ubicar"; consultar **historial de recorrido** de un chofer y verificar la polilínea histórica sobre Mapbox.
- **Comandos:** `pnpm lint && pnpm build && pnpm test`.

---

## 5. Restricciones y Criterios de Calidad
- **Migración Prisma estrictamente aditiva** (`DriverLocationPoint`), aplicada solo tras aprobación del usuario.
- **Sin emojis en la interfaz** (usar íconos de `lucide-react`).
- **Servidor como única fuente de verdad** (sin datos simulados ni fallback silencioso a `localStorage` en escrituras).
- **Modo claro limpio (`streets-v12`)** consistente en todo el panel web.
- **Cero modificaciones fuera de `c:\LaundryCleanFresh`.**
