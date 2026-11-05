# LaundryBackend

API de Laundry en NestJS 12, Prisma 7 y PostgreSQL. Gestor de paquetes: pnpm.

Principio: el repositorio no contiene datos de negocio. No hay semillas de catálogo, sedes, usuarios, tarifas ni promociones. El único dato de arranque es el primer administrador, tomado de variables de entorno. Cortes, cargos, IVA y demás reglas los define el administrador mediante la política de negocio (`POST /api/v1/policy`); mientras un parámetro no esté configurado, la regla que lo necesita se rechaza con un error explícito en lugar de asumir un valor.

## Puesta en marcha

Requiere Node 22.13 o superior, pnpm y Docker.

```powershell
pnpm install
copy .env.example .env      # completar secretos (>= 32 caracteres, distintos entre sí) y contraseñas
docker compose up -d        # PostgreSQL en el puerto POSTGRES_PORT (5433 por defecto)
pnpm prisma:deploy          # aplica migraciones
pnpm db:bootstrap           # crea el primer administrador (BOOTSTRAP_ADMIN_*)
pnpm start:dev
```

El administrador de arranque queda en estado `PASSWORD_CHANGE_REQUIRED`: debe cambiar su contraseña con `POST /api/v1/auth/change-password` antes de operar.

## Estado actual

Implementado: autenticación (registro de clientes, login, refresh con rotación y detección de reuso, cambio de contraseña, argon2), roles (CLIENT, DRIVER, SUPERVISOR, ADMIN), alta de choferes y personal por el administrador, política de negocio versionada con auditoría, y el esquema Prisma canónico de todo el dominio.

Pendiente (el esquema ya lo modela): sedes y zonas, catálogo, agenda y cupos, pedidos y máquina de estados, custodia (QR y códigos), pesaje y ajustes, billetera y cargos, KYC, puntos y canjes, incidencias, chat y notificaciones.

## Convenciones

- Todas las rutas exigen sesión salvo las marcadas con `@Public()`; los roles se declaran con `@Roles(...)`.
- Montos en `Decimal`; fechas en UTC, con la zona operativa tomada de la política.
- Los pedidos congelan precios y versión de política al crearse; toda mutación incrementa `Order.version`.
- El saldo de billetera se deriva del libro mayor (`LedgerEntry`), nunca se guarda como campo mutable.
- Los códigos de custodia y los tokens de sesión se guardan hasheados.
