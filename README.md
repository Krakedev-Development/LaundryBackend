# LaundryBackend

API de Laundry en NestJS 12, Prisma 7 y PostgreSQL. Gestor de paquetes: pnpm.

Principio: el repositorio no contiene datos de negocio. No hay semillas de catálogo, sedes, usuarios, tarifas ni promociones. El único dato de arranque es el primer administrador, tomado de variables de entorno. Cortes, cargos, IVA y demás reglas los define el administrador mediante la política de negocio (`POST /api/v1/policy`); mientras un parámetro no esté configurado, la regla que lo necesita se rechaza con un error explícito en lugar de asumir un valor.

## Puesta en marcha

Requiere Node 22.13 o superior, pnpm y Docker.

```powershell
pnpm install
copy .env.example .env      # completar (incluye THROTTLE_*, AUTH_THROTTLE_LIMIT) secretos (>= 32 caracteres, distintos entre sí) y contraseñas
docker compose up -d        # PostgreSQL en el puerto POSTGRES_PORT (5433 por defecto)
pnpm prisma:deploy          # aplica migraciones
pnpm db:bootstrap           # crea el primer administrador (BOOTSTRAP_ADMIN_*)
pnpm start:dev
```

El administrador de arranque queda en estado `PASSWORD_CHANGE_REQUIRED`: debe cambiar su contraseña con `POST /api/v1/auth/change-password` antes de operar.

## Estado actual

Implementado: autenticación (registro de clientes, login, refresh con rotación y detección de reuso, cambio de contraseña, argon2), roles (CLIENT, DRIVER, SUPERVISOR, ADMIN), alta de choferes y personal por el administrador, política de negocio versionada con auditoría, y el esquema Prisma canónico de todo el dominio.

Fase 1 (administrable solo por ADMIN, lectura para cualquier usuario autenticado; sin borrado, se desactiva): zonas con polígono y resolución de cobertura por coordenada (`/zones`), sedes (`/facilities`), catálogo de prendas, servicios, extras, membresías y recompensas (`/catalog/*`) y promociones (`/catalog/promotions`, solo administrador). Cada cambio queda en `AuditLog`.

Fase 2: agenda (`/slots`). Franjas por sede, contexto (recogida con chofer, entrega con chofer, retiro en sede) y fecha, sin solapamientos ni fechas pasadas (según la zona horaria de la política). El supervisor gestiona solo su sede; el cliente ve únicamente franjas futuras con cupo y sin capacidad interna. `SlotsService.reserveCapacity/releaseCapacity` reservan cupos de forma atómica (la condición vive en el `UPDATE`) y los usará la creación de pedidos.

Fase 3: direcciones del cliente (`/customers/me/addresses`) y pedidos (`/orders`). Creación con precio calculado solo en el servidor (Decimal; prendas o peso estimado, extras, membresía, promoción, logística e IVA desde la política), cobertura por polígono de zona, reserva atómica de cupos, congelado de precios y de `policyVersion`, e idempotencia por cabecera `Idempotency-Key`. Máquina de estados canónica con rol autorizado por transición y concurrencia optimista (`expectedVersion`); las transiciones de pago, despacho, custodia, pesaje y ajustes están protegidas por una "puerta": el endpoint genérico no las ejecuta, las dispara el módulo dueño de la evidencia. Despacho básico (`/orders/:id/assign`, respeta el límite de servicios por chofer de la política), programación de entrega, y cancelación con cargo por cancelación tardía y bloqueo por cargos según la política. Sin monto mínimo configurado no se impone ninguno.

Fase 4: billetera y pago, custodia, pesaje y ajustes.

- Billetera (`/wallet`): saldo derivado del libro mayor inmutable; abono manual del administrador con comprobante e idempotencia (mientras no haya proveedor de pagos); pago de cargos; condonación por el administrador. Los movimientos de un cliente se serializan con bloqueo de fila, así que pagos simultáneos no sobregiran.
- Pago (`POST /orders/:id/pay`): salda con la billetera lo pendiente y confirma el pedido; sirve también para la diferencia por ajustes. Cancelar un pedido pagado reembolsa a la billetera. `/complete` exige cero saldo pendiente.
- Custodia (`/orders/:id/handoffs/issue|verify`, `/handoffs/:id/revoke`): cinco tipos de traspaso, cada uno con quién presenta (cliente o chofer) y quién verifica (chofer o personal). Código de 6 dígitos y token QR guardados solo como HMAC/hash; vigencia e intentos máximos vienen de la política; el bloqueo por intentos fallidos persiste aunque la petición falle; toda acción queda en `HandoffAudit`. Verificar correctamente mueve el pedido (puerta HANDOFF).
- Pesaje y ajustes (`/orders/:id/weight|adjustments|pricing/resolve`): en pedidos por peso se recalcula con la política y el precio por libra congelados; un aumento requiere aprobación del cliente, una rebaja se aplica sola y se devuelve a la billetera. Los ajustes manuales se expresan como impacto en el total (impuesto incluido).

Fase 5: KYC, puntos, incidencias, chat y notificaciones.

- KYC (`/kyc`): el cliente envía datos y referencias opacas de documentos (el almacenamiento no está definido); el personal revisa desde una cola, el rechazo exige motivo y se puede reenviar. La política `requireKycForOrders` (apagada por defecto) exige identidad aprobada para crear pedidos.
- Puntos (`/points`, `/redemptions`): se acumulan al completar el pedido con la tasa de la política congelada en él; sin tasa configurada no se acumulan. Canjear reserva los puntos (con bloqueo de fila), el rechazo los devuelve.
- Incidencias (`/incidents`): cualquier participante reporta; chofer o personal pueden retener el pedido (estado `INCIDENT`, el flujo se pausa) y al resolverla vuelve al estado previo. Ciclo OPEN, IN_REVIEW, RESOLVED, CLOSED.
- Chat (`/orders/:id/messages`): hilo por pedido entre cliente, chofer asignado y personal de la sede; se cierra con el pedido.
- Notificaciones (`/notifications`): avisos al cliente por hitos del pedido, KYC, canjes, incidencias y mensajes.
- Todo cuerpo de petición se recorta antes de validar (excepto contraseñas).

Pendiente: despacho avanzado (reasignación, zonas de chofer, ubicación en vivo), cambio de franja con regla de corte, proveedor de pagos y almacenamiento, capacidad diaria de la sede, y un barrido de seguridad previo a conectar los frontends.

## Seguridad

- Permisos: todas las rutas exigen sesión salvo las públicas; los roles se declaran por ruta y una matriz de pruebas (`test/e2e/security.test.ts`) verifica 401 sin sesión y 403 para cada rol no autorizado. El rol y el estado se leen de la base en cada petición: suspender una cuenta surte efecto de inmediato.
- Aislamiento: clientes, choferes y supervisores solo acceden a sus propios pedidos, direcciones, cargos y notificaciones (404 en vez de 403 para no revelar existencia).
- Exposición de datos: clientes y choferes ven solo campos públicos de sede y de política; los hashes y secretos nunca salen en respuestas.
- Autenticación: argon2, JWT con algoritmo fijo (HS256) y vida corta, refresh con rotación y detección de reuso; límites de intentos por IP y, en el inicio de sesión, por IP y cuenta.
- Base de datos: el contenedor solo escucha en 127.0.0.1.
- Entradas: lista blanca de campos, textos recortados antes de validar, claves de idempotencia acotadas, listados con tope.
- Pendiente de decidir: cifrado en reposo de datos personales (documento KYC), política de bloqueo prolongado por intentos fallidos, y rotación de secretos.

## Pruebas

`pnpm test` (unitarias) y `pnpm test:e2e` (contra la base `<DB>_test`, que se crea y migra sola; nunca toca la de desarrollo). Usan el runner nativo de Node sobre el código compilado. `pnpm test:all` ejecuta ambas.

## Convenciones

- Todas las rutas exigen sesión salvo las marcadas con `@Public()`; los roles se declaran con `@Roles(...)`.
- Montos en `Decimal`; fechas en UTC, con la zona operativa tomada de la política.
- Los pedidos congelan precios y versión de política al crearse; toda mutación incrementa `Order.version`.
- El saldo de billetera se deriva del libro mayor (`LedgerEntry`), nunca se guarda como campo mutable.
- Los códigos de custodia y los tokens de sesión se guardan hasheados.
