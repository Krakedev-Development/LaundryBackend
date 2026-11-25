import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { OrdersService } from '../../src/orders/orders.service';
import { MapboxDirectionsService } from '../../src/tracking/mapbox-directions.service';
import { OrderEtaService } from '../../src/tracking/order-eta.service';
import { bearer, bootApp, createUser, login, type TestApp } from '../helpers';
import { api, buildWorld, type Client, type World } from '../world';

// Contrato del tiempo real por WebSocket (apps del cliente y del chofer, mapa operativo de la
// web). Estas pruebas fijan el comportamiento: los cambios internos no deben alterarlo.
let t: TestApp;
let w: World;
let url: string;
const sockets: Socket[] = [];

const post = (token: string, path: string, body: object = {}) =>
  t.http.post(`${api}${path}`).set(bearer(token)).send(body);
const move = async (token: string, id: string, to: string) =>
  post(token, `/orders/${id}/transitions`, { to, expectedVersion: await w.version(id) }).expect(201);

// Ruta fija: las pruebas no consultan a Mapbox ni a OSRM.
const FIXED_ROUTE = {
  distanceMeters: 1200,
  durationSeconds: 240,
  geometry: { type: 'LineString' as const, coordinates: [[5, 5], [5.01, 5.01]] as [number, number][] },
  provider: 'mapbox' as const,
  isFallback: false,
};

const WEB_ORIGIN = 'http://web.test';
// Orígenes con que se pidió cada ruta al proveedor.
const routeOrigins: Array<{ latitude: number; longitude: number }> = [];

function open(token: string | null, origin?: string): Socket {
  const socket = io(url, {
    auth: token === null ? {} : { token },
    ...(origin ? { extraHeaders: { origin } } : {}),
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  sockets.push(socket);
  return socket;
}

function next<T = Record<string, unknown>>(
  socket: Socket,
  event: string,
  match: (data: T) => boolean = () => true,
  timeoutMs = 4_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`No llegó "${event}" en ${timeoutMs} ms`));
    }, timeoutMs);
    const handler = (data: T) => {
      if (!match(data)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(data);
    };
    socket.on(event, handler);
  });
}

// Registra todo lo que llega de un evento para comprobar después que algo NO llegó.
function record<T = Record<string, unknown>>(socket: Socket, event: string): T[] {
  const seen: T[] = [];
  socket.on(event, (data: T) => seen.push(data));
  return seen;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connected(token: string): Promise<Socket> {
  const socket = open(token);
  await next(socket, 'authenticated');
  return socket;
}

async function subscribe(socket: Socket, orderId: string) {
  const ack = next<{ success: boolean; error?: string }>(socket, 'order:subscribed');
  socket.emit('order:subscribe', { orderId });
  return ack;
}

async function sendLocation(socket: Socket, body: Record<string, unknown>) {
  const ack = next<{ success: boolean; error?: string }>(socket, 'driver:location:received');
  socket.emit('driver:location:update', body);
  return ack;
}

// Pedido pagado y asignado al chofer del escenario (PICKUP_ASSIGNED).
async function assignedOrder(c: Client) {
  await w.credit(c.customerId, 100);
  const id = await w.order(c);
  await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(201);
  await post(w.admin, `/orders/${id}/assign`, {
    expectedVersion: await w.version(id), leg: 'INBOUND', driverId: w.driverId,
  }).expect(201);
  return id;
}

before(async () => {
  process.env.CORS_ORIGINS = WEB_ORIGIN;
  t = await bootApp();
  w = await buildWorld(t);
  const { port } = t.app.getHttpServer().address() as { port: number };
  url = `http://127.0.0.1:${port}`;
  t.app.get(MapboxDirectionsService).getRouteWithGeometry = async (origin) => {
    routeOrigins.push(origin);
    return FIXED_ROUTE;
  };
});
after(async () => {
  for (const s of sockets) s.disconnect();
  await t.close();
});

describe('conexión al socket', () => {
  it('sin token o con un token inválido se rechaza la conexión', async () => {
    const anon = open(null);
    const e1 = await next<{ success: boolean; error: string }>(anon, 'authentication_error');
    assert.equal(e1.success, false);
    assert.match(e1.error, /requerido/);

    const bad = open('token-falso');
    const e2 = await next<{ success: boolean; error: string }>(bad, 'authentication_error');
    assert.match(e2.error, /inválido o expirado/);
  });

  it('con un token válido confirma el usuario y su rol', async () => {
    const socket = open(w.driverToken);
    const auth = await next<{ userId: string; role: string }>(socket, 'authenticated');
    assert.equal(auth.role, 'DRIVER');
    assert.ok(auth.userId);
  });

  it('un navegador de un origen no permitido no puede conectarse; uno permitido sí', async () => {
    const foreign = open(w.admin, 'http://ajeno.test');
    await new Promise<void>((resolve, reject) => {
      foreign.on('connect_error', () => resolve());
      foreign.on('authenticated', () => reject(new Error('Se aceptó un origen ajeno')));
      setTimeout(() => reject(new Error('Sin respuesta')), 4_000);
    });
    const web = open(w.admin, WEB_ORIGIN);
    assert.equal((await next<{ role: string }>(web, 'authenticated')).role, 'ADMIN');
  });

  it('con la contraseña temporal pendiente no se puede conectar', async () => {
    await createUser(t, { email: 'rt-temp@test.local', role: 'SUPERVISOR' });
    const token = await login(t, 'rt-temp@test.local');
    await t.prisma.user.update({ where: { email: 'rt-temp@test.local' }, data: { status: 'PASSWORD_CHANGE_REQUIRED' } });
    const e = await next<{ error: string }>(open(token), 'authentication_error');
    assert.match(e.error, /contraseña temporal/);
  });

  it('suspender o restablecer la contraseña cierra las conexiones abiertas', async () => {
    const sup = await createUser(t, { email: 'rt-live@test.local', role: 'SUPERVISOR' });
    const facilityId = w.facilityId;
    await t.prisma.user.update({ where: { id: sup.id }, data: { facilityId } });
    const first = await connected(await login(t, 'rt-live@test.local'));
    const closed = new Promise<void>((resolve) => first.on('disconnect', () => resolve()));
    const notice = next<{ error: string }>(first, 'authentication_error');
    await t.http.patch(`${api}/users/${sup.id}/status`).set(bearer(w.admin))
      .send({ status: 'SUSPENDED', reason: 'Prueba' }).expect(200);
    assert.match((await notice).error, /suspendido/);
    await closed;

    await t.http.patch(`${api}/users/${sup.id}/status`).set(bearer(w.admin)).send({ status: 'ACTIVE' }).expect(200);
    const second = await connected(await login(t, 'rt-live@test.local'));
    const notice2 = next<{ error: string }>(second, 'authentication_error');
    await post(w.admin, `/users/${sup.id}/reset-password`, { temporaryPassword: 'Temp2026ok' }).expect(201);
    assert.match((await notice2).error, /contraseña temporal/);
  });

  it('un usuario suspendido no puede conectarse', async () => {
    await createUser(t, { email: 'rt-suspended@test.local', role: 'SUPERVISOR' });
    const token = await login(t, 'rt-suspended@test.local');
    await t.prisma.user.update({ where: { email: 'rt-suspended@test.local' }, data: { status: 'SUSPENDED' } });
    const e = await next<{ error: string }>(open(token), 'authentication_error');
    assert.match(e.error, /suspendido/);
  });
});

describe('suscripción a un pedido', () => {
  it('solo el cliente dueño, el chofer del tramo y el personal de la sede pueden seguirlo', async () => {
    const owner = await w.newClient('rt-owner@test.local');
    const other = await w.newClient('rt-other@test.local');
    const id = await assignedOrder(owner);

    assert.equal((await subscribe(await connected(owner.token), id)).success, true);
    assert.equal((await subscribe(await connected(w.driverToken), id)).success, true);
    assert.equal((await subscribe(await connected(w.supervisor), id)).success, true);
    assert.equal((await subscribe(await connected(w.admin), id)).success, true);
    const denied = await subscribe(await connected(other.token), id);
    assert.equal(denied.success, false);
    assert.match(denied.error ?? '', /Sin permiso/);
  });
});

describe('posición del chofer', () => {
  it('solo un chofer envía posición y con coordenadas válidas', async () => {
    const c = await w.newClient('rt-loc-guard@test.local');
    const fromClient = await sendLocation(await connected(c.token), { lat: 5, lng: 5 });
    assert.equal(fromClient.success, false);
    assert.match(fromClient.error ?? '', /Solo los choferes/);

    const driver = await connected(w.driverToken);
    assert.match((await sendLocation(driver, { lat: 0, lng: 0 })).error ?? '', /nulas/);
    assert.match((await sendLocation(driver, { lat: 95, lng: 5 })).error ?? '', /fuera de rango/);
    assert.match((await sendLocation(driver, { lat: '5', lng: 5 })).error ?? '', /numéricas/);
  });

  it('el cliente la recibe mientras el chofer va hacia su domicilio, nunca hacia la planta', async () => {
    const c = await w.newClient('rt-loc@test.local');
    const id = await assignedOrder(c);
    const client = await connected(c.token);
    await subscribe(client, id);
    const driver = await connected(w.driverToken);

    const relayed = next<{ orderId: string; activeLeg: string; location: { lat: number; lng: number } }>(
      client, 'driver:location:updated', (d) => d.orderId === id,
    );
    assert.equal((await sendLocation(driver, { lat: 5.001, lng: 5.002, heading: 90, speed: 4, orderId: id })).success, true);
    const fix = await relayed;
    assert.equal(fix.activeLeg, 'INBOUND');
    assert.deepEqual([fix.location.lat, fix.location.lng], [5.001, 5.002]);

    // Con el pedido camino a la planta el cliente ya no recibe la posición, desde el aviso del
    // cambio de estado (todo cambio de estado del backend lo emite).
    await t.prisma.order.update({ where: { id }, data: { status: 'HEADING_TO_FACILITY' } });
    await t.app.get(OrdersService).notifyStatusChangedById(id);
    const seen = record<{ orderId: string }>(client, 'driver:location:updated');
    assert.equal((await sendLocation(driver, { lat: 5.003, lng: 5.004, orderId: id })).success, true);
    await pause(400);
    assert.deepEqual(seen.filter((d) => d.orderId === id), []);
  });

  it('en régimen normal una posición no consulta la base para resolver chofer y pedidos', async () => {
    const c = await w.newClient('rt-cache@test.local');
    const id = await assignedOrder(c);
    const client = await connected(c.token);
    await subscribe(client, id);
    const driver = await connected(w.driverToken);
    // Primera posición: llena las cachés.
    await sendLocation(driver, { lat: 5.04, lng: 5.04, orderId: id });

    const counts = { driver: 0, legs: 0 };
    const legs = t.prisma.fulfillmentLeg;
    const drivers = t.prisma.driver;
    const origLegs = legs.findMany.bind(legs);
    const origDriver = drivers.findUnique.bind(drivers);
    (legs as unknown as { findMany: unknown }).findMany = (...a: Parameters<typeof origLegs>) => {
      counts.legs += 1;
      return origLegs(...a);
    };
    (drivers as unknown as { findUnique: unknown }).findUnique = (...a: Parameters<typeof origDriver>) => {
      counts.driver += 1;
      return origDriver(...a);
    };
    try {
      const relays = record<{ orderId: string }>(client, 'driver:location:updated');
      for (let i = 1; i <= 5; i++)
        await sendLocation(driver, { lat: 5.04 + i / 10_000, lng: 5.04, orderId: id });
      await pause(200);
      assert.ok(relays.filter((r) => r.orderId === id).length >= 5, 'el cliente recibe cada posición');
      assert.deepEqual(counts, { driver: 0, legs: 0 });
      // El conteo funciona: una consulta directa sí se registra.
      await t.prisma.driver.findUnique({ where: { id: w.driverId } });
      assert.equal(counts.driver, 1);
    } finally {
      (legs as unknown as { findMany: unknown }).findMany = origLegs;
      (drivers as unknown as { findUnique: unknown }).findUnique = origDriver;
    }
  });

  it('la posición queda guardada en la base del chofer en pocos segundos', async () => {
    const driver = await connected(w.driverToken);
    await sendLocation(driver, { lat: 5.0101, lng: 5.0202 });
    await pause(2_600);
    const row = await t.prisma.driver.findUniqueOrThrow({ where: { id: w.driverId } });
    assert.deepEqual([Number(row.latitude), Number(row.longitude)], [5.0101, 5.0202]);
    assert.ok(row.locationAt);
  });
});

describe('avisos de estado y tiempo estimado', () => {
  it('el cliente recibe la asignación, la llegada del chofer y el tiempo estimado', async () => {
    const c = await w.newClient('rt-status@test.local');
    await w.credit(c.customerId, 100);
    const id = await w.order(c);
    await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(201);
    const client = await connected(c.token);
    await subscribe(client, id);

    const assigned = next<{ status: string; activeLeg: string }>(
      client, 'order:status:changed', (d) => d.status === 'PICKUP_ASSIGNED',
    );
    await post(w.admin, `/orders/${id}/assign`, {
      expectedVersion: await w.version(id), leg: 'INBOUND', driverId: w.driverId,
    }).expect(201);
    assert.equal((await assigned).activeLeg, 'INBOUND');

    const driver = await connected(w.driverToken);
    await sendLocation(driver, { lat: 5.02, lng: 5.02, orderId: id });
    const eta = next<{ orderId: string; etaMinutes: number; distanceMeters: number; activeLeg: string }>(
      client, 'order:eta:updated', (d) => d.orderId === id,
    );
    await move(w.driverToken, id, 'HEADING_TO_PICKUP');
    const pushed = await eta;
    assert.deepEqual([pushed.activeLeg, pushed.etaMinutes, pushed.distanceMeters], ['INBOUND', 4, 1200]);

    const arrived = next<{ status: string }>(client, 'order:driver_arrived', (d) => d.status === 'ARRIVED_FOR_PICKUP');
    await move(w.driverToken, id, 'ARRIVED_FOR_PICKUP');
    await arrived;
  });

  it('ruta y tiempo estimado por HTTP solo con seguimiento activo', async () => {
    const c = await w.newClient('rt-http@test.local');
    await w.credit(c.customerId, 100);
    const id = await w.order(c);
    await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(201);
    await t.http.get(`${api}/orders/${id}/route`).set(bearer(c.token)).expect(400);
    const idle = await t.http.get(`${api}/orders/${id}/eta`).set(bearer(c.token)).expect(200);
    assert.equal(idle.body.data.isLiveTrackingActive, false);

    await post(w.admin, `/orders/${id}/assign`, {
      expectedVersion: await w.version(id), leg: 'INBOUND', driverId: w.driverId,
    }).expect(201);
    await sendLocation(await connected(w.driverToken), { lat: 5.03, lng: 5.03 });
    const route = await t.http.get(`${api}/orders/${id}/route`).set(bearer(c.token)).expect(200);
    assert.equal(route.body.data.activeLeg, 'INBOUND');
    assert.equal(route.body.data.geometry.coordinates.length, 2);
    const eta = await t.http.get(`${api}/orders/${id}/eta`).set(bearer(c.token)).expect(200);
    assert.deepEqual([eta.body.data.isLiveTrackingActive, eta.body.data.etaMinutes], [true, 4]);
    assert.deepEqual([eta.body.data.driverLocation.lat, eta.body.data.driverLocation.lng], [5.03, 5.03]);

    // Las coordenadas que envía quien consulta se ignoran: el origen es la posición del chofer.
    routeOrigins.length = 0;
    await t.http.get(`${api}/orders/${id}/route?driverLat=-1.5&driverLng=-1.5&driverHeading=10`)
      .set(bearer(c.token)).expect(200);
    assert.deepEqual(routeOrigins.at(-1), { latitude: 5.03, longitude: 5.03 });

    const other = await w.newClient('rt-http-other@test.local');
    await t.http.get(`${api}/orders/${id}/route`).set(bearer(other.token)).expect(404);
  });
});

describe('límite de consultas de seguimiento', () => {
  it('cada usuario tiene un cupo propio por minuto en ruta y tiempo estimado', async () => {
    const c = await w.newClient('rt-budget@test.local');
    const id = await w.order(c);
    const eta = `${api}/orders/${id}/eta`;
    for (let i = 0; i < 30; i++) await t.http.get(eta).set(bearer(c.token)).expect(200);
    const over = await t.http.get(eta).set(bearer(c.token)).expect(429);
    assert.match(over.body.message, /Demasiadas consultas/);
    await t.http.get(`${api}/orders/${id}/route`).set(bearer(c.token)).expect(429);
    // Otro usuario no comparte el cupo.
    await t.http.get(eta).set(bearer(w.admin)).expect(200);
  });
});

describe('estado que sobrevive a un reinicio', () => {
  it('el barrido envía el tiempo estimado de los pedidos en seguimiento, aunque no haya temporizadores', async () => {
    const c = await w.newClient('rt-sweep@test.local');
    const id = await assignedOrder(c);
    // Simula un reinicio: el pedido pasó a "en camino" sin aviso previo en esta instancia.
    await t.prisma.order.update({ where: { id }, data: { status: 'HEADING_TO_PICKUP' } });
    const idle = await w.newClient('rt-sweep-idle@test.local');
    const idleId = await w.order(idle);

    const client = await connected(c.token);
    await subscribe(client, id);
    await sendLocation(await connected(w.driverToken), { lat: 5.06, lng: 5.06 });
    const idleClient = await connected(idle.token);
    const idleSeen = record<{ orderId: string }>(idleClient, 'order:eta:updated');

    const eta = next<{ orderId: string; activeLeg: string; etaMinutes: number }>(
      client, 'order:eta:updated', (d) => d.orderId === id,
    );
    const swept = await t.app.get(OrderEtaService).sweepLiveOrders();
    assert.ok(swept >= 1);
    const got = await eta;
    assert.deepEqual([got.activeLeg, got.etaMinutes], ['INBOUND', 4]);
    await pause(200);
    assert.deepEqual(idleSeen.filter((d) => d.orderId === idleId), []);
  });

  it('los avisos personales llegan a todas las conexiones del usuario', async () => {
    const c = await w.newClient('rt-multi@test.local');
    await w.credit(c.customerId, 100);
    const id = await w.order(c);
    await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(201);
    // Dos dispositivos del mismo cliente, sin suscribirse al pedido.
    const phone = await connected(c.token);
    const tablet = await connected(c.token);
    const onPhone = next<{ status: string }>(phone, 'order:status:changed', (d) => d.status === 'PICKUP_ASSIGNED');
    const onTablet = next<{ status: string }>(tablet, 'order:status:changed', (d) => d.status === 'PICKUP_ASSIGNED');
    await post(w.admin, `/orders/${id}/assign`, {
      expectedVersion: await w.version(id), leg: 'INBOUND', driverId: w.driverId,
    }).expect(201);
    await Promise.all([onPhone, onTablet]);
  });
});

describe('mapa operativo de la web', () => {
  it('el administrador ve toda la operación, el supervisor su sede y el cliente nada', async () => {
    const admin = await connected(w.admin);
    const adminSnap = next<{ scope: string; drivers: Array<{ driverId: string }> }>(admin, 'admin:map:snapshot');
    admin.emit('admin:map:subscribe');
    const snap = await adminSnap;
    assert.equal(snap.scope, 'ADMIN');
    assert.ok(snap.drivers.some((d) => d.driverId === w.driverId));

    const sup = await connected(w.supervisor);
    const supSnap = next<{ scope: string; scopedFacilityId: string }>(sup, 'admin:map:snapshot');
    sup.emit('admin:map:subscribe');
    const s = await supSnap;
    assert.deepEqual([s.scope, s.scopedFacilityId], ['SUPERVISOR', w.facilityId]);

    const c = await w.newClient('rt-map-client@test.local');
    const client = await connected(c.token);
    const denied = next<{ error: string }>(client, 'admin:map:error');
    client.emit('admin:map:subscribe');
    assert.equal((await denied).error, 'forbidden');
  });

  it('la posición del chofer llega al mapa de su sede y no al supervisor de otra sede', async () => {
    const zone = await t.prisma.facility.findUniqueOrThrow({ where: { id: w.facilityId } });
    const otherFacility = await post(w.admin, '/facilities', {
      zoneId: zone.zoneId, name: 'Otra sede', address: 'Av 2', latitude: 6, longitude: 6,
    }).expect(201);
    const sup2 = await createUser(t, { email: 'rt-sup2@test.local', role: 'SUPERVISOR' });
    await t.prisma.user.update({ where: { id: sup2.id }, data: { facilityId: otherFacility.body.id } });

    const sup = await connected(w.supervisor);
    sup.emit('admin:map:subscribe');
    await next(sup, 'admin:map:snapshot');
    const foreign = await connected(await login(t, 'rt-sup2@test.local'));
    foreign.emit('admin:map:subscribe');
    await next(foreign, 'admin:map:snapshot');
    const foreignSeen = record<{ drivers: Array<{ driverId: string }> }>(foreign, 'admin:map:driver-locations');

    // El mapa del chofer se limita a una emisión cada 2 s por chofer.
    await pause(2_100);
    const own = next<{ drivers: Array<{ driverId: string; lat: number }> }>(
      sup, 'admin:map:driver-locations', (d) => d.drivers.some((x) => x.driverId === w.driverId),
    );
    await sendLocation(await connected(w.driverToken), { lat: 5.05, lng: 5.05 });
    const got = await own;
    assert.equal(got.drivers.find((d) => d.driverId === w.driverId)?.lat, 5.05);
    await pause(300);
    assert.deepEqual(foreignSeen, []);
  });
});
