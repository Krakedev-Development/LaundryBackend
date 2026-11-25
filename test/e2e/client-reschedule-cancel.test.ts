import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { OrderEtaService } from '../../src/tracking/order-eta.service';
import { TrackingGateway, type OrderStatusBroadcast } from '../../src/tracking/tracking.gateway';
import { bearer, bootApp, type TestApp } from '../helpers';
import { api, buildWorld, type Client, type World } from '../world';

// Cancelar y reprogramar desde la app del cliente: el servidor es la fuente de verdad y avisa en
// tiempo real a la web y al chofer (también al chofer que queda liberado).
let t: TestApp;
let w: World;
let emitted: OrderStatusBroadcast[] = [];
let driverUserId: string;

const post = (token: string, path: string, body: object = {}) =>
  t.http.post(`${api}${path}`).set(bearer(token)).send(body);
const put = (token: string, path: string, body: object = {}) =>
  t.http.put(`${api}${path}`).set(bearer(token)).send(body);
const reschedule = async (c: Client, id: string, body: Record<string, unknown>) =>
  put(c.token, `/orders/${id}/reschedule`, { expectedVersion: await w.version(id), ...body });
// Reprograma y comprueba el código; en el fallo muestra el mensaje del servidor.
async function rescheduleExpect(status: number, c: Client, id: string, body: Record<string, unknown>) {
  const res = await reschedule(c, id, body);
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res;
}
const eventsFor = (id: string) => emitted.filter((e) => e.orderId === id);
const reserved = async (slotId: string) =>
  (await t.prisma.timeSlot.findUniqueOrThrow({ where: { id: slotId } })).reservedCount;
const legOf = (orderId: string, kind: 'INBOUND' | 'OUTBOUND') =>
  t.prisma.fulfillmentLeg.findFirstOrThrow({ where: { orderId, kind } });

async function confirmed(c: Client, over: Record<string, unknown> = {}) {
  await w.credit(c.customerId, 100);
  const id = await w.order(c, over);
  await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(201);
  return id;
}
async function assigned(c: Client, over: Record<string, unknown> = {}) {
  const id = await confirmed(c, over);
  await post(w.admin, `/orders/${id}/assign`, {
    expectedVersion: await w.version(id), leg: 'INBOUND', driverId: w.driverId,
  }).expect(201);
  return id;
}

before(async () => {
  t = await bootApp();
  w = await buildWorld(t);
  driverUserId = (await t.prisma.driver.findUniqueOrThrow({ where: { id: w.driverId } })).userId;
  const gateway = t.app.get(TrackingGateway);
  gateway.emitOrderStatusChanged = (payload) => void emitted.push(payload);
  t.app.get(OrderEtaService).syncTrackingForStatus = () => undefined;
});
after(() => t.close());
beforeEach(() => {
  emitted = [];
});

describe('cancelación desde la app del cliente', () => {
  it('con chofer asignado cancela en el servidor y avisa al chofer', async () => {
    const c = await w.newClient('cx-cancel@test.local');
    const id = await assigned(c);
    emitted = [];
    const res = await post(c.token, `/orders/${id}/cancel`, {
      expectedVersion: await w.version(id), reason: 'Ya no necesito el servicio',
    }).expect(201);
    assert.equal(res.body.status, 'CANCELLED');
    const [event] = eventsFor(id);
    assert.equal(event?.status, 'CANCELLED');
    assert.ok((event?.driverUserIds ?? []).includes(driverUserId));
    assert.equal((await legOf(id, 'INBOUND')).status, 'CANCELLED');
  });

  it('exige un motivo', async () => {
    const c = await w.newClient('cx-cancel-reason@test.local');
    const id = await confirmed(c);
    await post(c.token, `/orders/${id}/cancel`, { expectedVersion: await w.version(id) }).expect(400);
  });
});

describe('reprogramación desde la app del cliente', () => {
  it('cambiar la franja con chofer asignado libera al chofer, mueve el cupo y avisa', async () => {
    const c = await w.newClient('rs-assigned@test.local');
    const id = await assigned(c);
    const oldSlot = (await legOf(id, 'INBOUND')).slotId!;
    const newSlot = await w.slot('DRIVER_PICKUP');
    emitted = [];

    const res = await rescheduleExpect(200, c, id, { leg: 'INBOUND', slotId: newSlot });
    assert.equal(res.body.status, 'CONFIRMED');
    const leg = await legOf(id, 'INBOUND');
    assert.equal(leg.slotId, newSlot);
    assert.equal(leg.driverId, null);
    assert.equal(await reserved(oldSlot), 0);
    assert.equal(await reserved(newSlot), 1);
    const [event] = eventsFor(id);
    assert.equal(event?.status, 'CONFIRMED');
    assert.ok((event?.driverUserIds ?? []).includes(driverUserId), 'el chofer liberado recibe el aviso');
    const last = await t.prisma.orderEvent.findFirstOrThrow({
      where: { orderId: id }, orderBy: { createdAt: 'desc' },
    });
    assert.equal(last.title, 'Recogida reprogramada');
  });

  it('cambiar solo la dirección conserva al chofer y el estado', async () => {
    const c = await w.newClient('rs-address@test.local');
    const id = await assigned(c);
    const other = await t.http
      .post(`${api}/customers/me/addresses`)
      .set(bearer(c.token))
      .send({ title: 'Oficina', fullAddress: 'Calle 9 #8-7', latitude: 5.001, longitude: 5.001 })
      .expect(201);
    const slotId = (await legOf(id, 'INBOUND')).slotId!;
    emitted = [];

    const res = await rescheduleExpect(200, c, id, { leg: 'INBOUND', slotId, addressId: other.body.id });
    assert.equal(res.body.status, 'PICKUP_ASSIGNED');
    const leg = await legOf(id, 'INBOUND');
    assert.equal(leg.addressText, 'Calle 9 #8-7');
    assert.equal(leg.driverId, w.driverId);
    assert.ok((eventsFor(id)[0]?.driverUserIds ?? []).includes(driverUserId));
  });

  it('sin cambios responde 400 y con otra versión 409', async () => {
    const c = await w.newClient('rs-same@test.local');
    const id = await confirmed(c);
    const slotId = (await legOf(id, 'INBOUND')).slotId!;
    await rescheduleExpect(400, c, id, { leg: 'INBOUND', slotId });
    await put(c.token, `/orders/${id}/reschedule`, {
      expectedVersion: 1, leg: 'INBOUND', slotId: await w.slot('DRIVER_PICKUP'),
    }).expect(409);
  });

  it('con la recogida en camino ya no se reprograma', async () => {
    const c = await w.newClient('rs-started@test.local');
    const id = await assigned(c);
    await post(w.driverToken, `/orders/${id}/transitions`, {
      to: 'HEADING_TO_PICKUP', expectedVersion: await w.version(id),
    }).expect(201);
    await rescheduleExpect(409, c, id, { leg: 'INBOUND', slotId: await w.slot('DRIVER_PICKUP') });
  });

  it('una recogida posterior a la entrega programada obliga a reprogramar la entrega', async () => {
    const c = await w.newClient('rs-push@test.local');
    const pickupSlotId = await w.slot('DRIVER_PICKUP');
    const deliverySlot = await w.slot('DRIVER_DELIVERY');
    const id = await confirmed(c, { pickupSlotId, outbound: { slotId: deliverySlot } });
    const later = await w.slot('DRIVER_PICKUP');

    await rescheduleExpect(200, c, id, { leg: 'INBOUND', slotId: later });
    const outbound = await legOf(id, 'OUTBOUND');
    assert.equal(outbound.slotId, null);
    assert.equal(outbound.status, 'PENDING');
    assert.equal(await reserved(deliverySlot), 0);
  });

  it('la entrega se reprograma, pero nunca antes de que termine la recogida', async () => {
    const c = await w.newClient('rs-outbound@test.local');
    const early = await w.slot('DRIVER_DELIVERY');
    const pickupSlotId = await w.slot('DRIVER_PICKUP');
    const first = await w.slot('DRIVER_DELIVERY');
    const id = await confirmed(c, { pickupSlotId, outbound: { slotId: first } });

    await rescheduleExpect(422, c, id, { leg: 'OUTBOUND', slotId: early });
    const next = await w.slot('DRIVER_DELIVERY');
    await rescheduleExpect(200, c, id, { leg: 'OUTBOUND', slotId: next });
    assert.equal((await legOf(id, 'OUTBOUND')).slotId, next);
    assert.equal(await reserved(first), 0);
    assert.equal(await reserved(next), 1);
  });

  it('solo el dueño del pedido reprograma', async () => {
    const owner = await w.newClient('rs-owner@test.local');
    const other = await w.newClient('rs-other@test.local');
    const id = await confirmed(owner);
    const slotId = await w.slot('DRIVER_PICKUP');
    const status = (await reschedule(other, id, { leg: 'INBOUND', slotId })).status;
    assert.ok([403, 404].includes(status));
    await put(w.admin, `/orders/${id}/reschedule`, {
      expectedVersion: await w.version(id), leg: 'INBOUND', slotId,
    }).expect(403);
  });
});
