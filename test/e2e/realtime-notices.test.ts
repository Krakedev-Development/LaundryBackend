import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { OrderStatus } from '../../src/generated/prisma/client';
import { OrderEtaService } from '../../src/tracking/order-eta.service';
import { TrackingGateway, type OrderStatusBroadcast } from '../../src/tracking/tracking.gateway';
import { bearer, bootApp, type TestApp } from '../helpers';
import { api, buildWorld, type Client, type World } from '../world';

// Los cambios de estado que ocurren fuera de las transiciones genéricas también se avisan por
// tiempo real (app del cliente y del chofer) y sincronizan el envío periódico del tiempo estimado.
let t: TestApp;
let w: World;
let emitted: OrderStatusBroadcast[] = [];
let synced: Array<[string, OrderStatus]> = [];

const post = (token: string, path: string, body: object = {}) =>
  t.http.post(`${api}${path}`).set(bearer(token)).send(body);
const move = async (token: string, id: string, to: string) =>
  post(token, `/orders/${id}/transitions`, { to, expectedVersion: await w.version(id) }).expect(201);
const statusesFor = (id: string) => emitted.filter((e) => e.orderId === id).map((e) => e.status);
const userIdOf = async (c: Client) =>
  (await t.prisma.customer.findUniqueOrThrow({ where: { id: c.customerId } })).userId;
const syncedFor = (id: string) => synced.filter(([orderId]) => orderId === id).map(([, s]) => s);

before(async () => {
  t = await bootApp();
  w = await buildWorld(t);
  // Se registran los avisos sin abrir sockets ni consultar rutas (las pruebas no salen a la red).
  const gateway = t.app.get(TrackingGateway);
  gateway.emitOrderStatusChanged = (payload) => void emitted.push(payload);
  const eta = t.app.get(OrderEtaService);
  eta.syncTrackingForStatus = (orderId, status) => void synced.push([orderId, status]);
});
after(() => t.close());
beforeEach(() => {
  emitted = [];
  synced = [];
});

async function headingToPickup(c: Client) {
  await w.credit(c.customerId, 100);
  const id = await w.order(c);
  await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(201);
  await post(w.admin, `/orders/${id}/assign`, {
    expectedVersion: await w.version(id), leg: 'INBOUND', driverId: w.driverId,
  }).expect(201);
  await move(w.driverToken, id, 'HEADING_TO_PICKUP');
  return id;
}

describe('avisos de estado en tiempo real', () => {
  it('pagar con la billetera avisa la confirmación del pedido', async () => {
    const c = await w.newClient('rt-pay@test.local');
    await w.credit(c.customerId, 100);
    const id = await w.order(c);
    await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(201);
    assert.deepEqual(statusesFor(id), ['CONFIRMED']);
    assert.equal(emitted.find((e) => e.orderId === id)?.customerUserId, await userIdOf(c));
  });

  it('la confirmación manual del pago avisa la confirmación del pedido', async () => {
    const c = await w.newClient('rt-manual@test.local');
    const id = await w.order(c);
    await post(w.admin, `/orders/${id}/confirm-payment`, {
      expectedVersion: await w.version(id), note: 'Transferencia recibida',
    }).expect(201);
    assert.deepEqual(statusesFor(id), ['CONFIRMED']);
  });

  it('retener detiene el seguimiento y liberar lo reanuda en el tramo hacia el cliente', async () => {
    const c = await w.newClient('rt-hold@test.local');
    const id = await headingToPickup(c);
    emitted = [];
    synced = [];

    const inc = await post(w.driverToken, '/incidents', {
      orderId: id, type: 'CUSTOMER_ABSENT', severity: 'MEDIUM', description: 'No responde', holdOrder: true,
    }).expect(201);
    assert.deepEqual(statusesFor(id), ['INCIDENT']);
    assert.deepEqual(syncedFor(id), ['INCIDENT']);
    const held = emitted.find((e) => e.orderId === id)!;
    assert.equal(held.activeLeg, null);
    assert.equal(held.customerUserId, await userIdOf(c));
    assert.ok((held.driverUserIds ?? []).length > 0, 'también avisa al chofer del tramo');

    // Pasar a revisión no cambia el estado del pedido: no hay aviso.
    await post(w.supervisor, `/incidents/${inc.body.id}/status`, { status: 'IN_REVIEW' }).expect(201);
    assert.deepEqual(statusesFor(id), ['INCIDENT']);

    await post(w.supervisor, `/incidents/${inc.body.id}/status`, {
      status: 'RESOLVED', resolution: 'Cliente contactado',
    }).expect(201);
    assert.deepEqual(statusesFor(id), ['INCIDENT', 'HEADING_TO_PICKUP']);
    assert.deepEqual(syncedFor(id), ['INCIDENT', 'HEADING_TO_PICKUP']);
    assert.equal(emitted.at(-1)!.activeLeg, 'INBOUND');
  });

  it('una incidencia sin retención no emite avisos de estado', async () => {
    const c = await w.newClient('rt-report@test.local');
    const id = await headingToPickup(c);
    emitted = [];
    await post(c.token, '/incidents', {
      orderId: id, type: 'CUSTOMER_REPORT', severity: 'LOW', description: 'Cambio de dirección',
    }).expect(201);
    assert.deepEqual(statusesFor(id), []);
  });
});

describe('cambios sin transición de estado también avisan', () => {
  const put = (token: string, path: string, body: object = {}) =>
    t.http.put(`${api}${path}`).set(bearer(token)).send(body);
  const get = (token: string, path: string) => t.http.get(`${api}${path}`).set(bearer(token));

  it('programar la entrega desde la app avisa a la web (Entregas)', async () => {
    const c = await w.newClient('rt-outbound@test.local');
    await w.credit(c.customerId, 100);
    const id = await w.order(c);
    await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(201);
    emitted = [];
    await put(c.token, `/orders/${id}/outbound`, {
      expectedVersion: await w.version(id), slotId: await w.slot('DRIVER_DELIVERY'),
    }).expect(200);
    assert.deepEqual(statusesFor(id), ['CONFIRMED']);
    assert.equal(emitted.find((e) => e.orderId === id)?.facilityId, w.facilityId);
  });

  it('registrar un ajuste avisa al cliente y su decisión avisa a planta', async () => {
    const c = await w.newClient('rt-adjust@test.local');
    await w.credit(c.customerId, 100);
    const id = await w.order(c);
    await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(201);
    // Atajo: el recorrido hasta planta ya lo cubre lifecycle.test; aquí importa el aviso.
    await t.prisma.order.update({ where: { id }, data: { status: 'PRICING_PENDING' } });

    emitted = [];
    await post(w.supervisor, `/orders/${id}/adjustments`, {
      type: 'EXTRA_ITEM', internalReason: 'Mancha especial', customerMessage: 'Tratamiento de mancha',
      amountDifference: 2, expectedVersion: await w.version(id),
    }).expect(201);
    assert.deepEqual(statusesFor(id), ['PRICING_PENDING']);
    assert.equal(emitted.find((e) => e.orderId === id)?.customerUserId, await userIdOf(c));

    await post(w.supervisor, `/orders/${id}/pricing/resolve`, { expectedVersion: await w.version(id) }).expect(201);
    const [adj] = (await get(c.token, `/orders/${id}/adjustments`).expect(200)).body;
    emitted = [];
    await post(c.token, `/orders/${id}/adjustments/${adj.id}/decision`, {
      approve: true, expectedVersion: await w.version(id),
    }).expect(201);
    assert.deepEqual(statusesFor(id), ['CUSTOMER_APPROVAL_PENDING']);
  });
});
