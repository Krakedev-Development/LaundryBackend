import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bearer, bootApp, createUser, login, type TestApp } from '../helpers';
import { api, buildWorld, FULL_POLICY, type Client, type World } from '../world';

let t: TestApp;
let w: World;

const post = (token: string, path: string, body: object = {}) =>
  t.http.post(`${api}${path}`).set(bearer(token)).send(body);
const put = (token: string, path: string, body: object = {}) =>
  t.http.put(`${api}${path}`).set(bearer(token)).send(body);
const move = async (token: string, id: string, to: string) =>
  post(token, `/orders/${id}/transitions`, { to, expectedVersion: await w.version(id) }).expect(201);

// Pedido pagado, con chofer asignado y el chofer ya en el domicilio.
async function arrived(c: Client) {
  await w.credit(c.customerId, 100);
  const id = await w.order(c);
  await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(201);
  await post(w.admin, `/orders/${id}/assign`, {
    expectedVersion: await w.version(id), leg: 'INBOUND', driverId: w.driverId,
  }).expect(201);
  await move(w.driverToken, id, 'HEADING_TO_PICKUP');
  await move(w.driverToken, id, 'ARRIVED_FOR_PICKUP');
  return id;
}
// Resuelve la versión vigente justo al enviar.
const failed = (id: string, token = w.driverToken, reason = 'Cliente ausente') => ({
  async expect(status: number) {
    return post(token, `/orders/${id}/failed-pickup`, {
      expectedVersion: await w.version(id),
      reason,
    }).expect(status);
  },
});

before(async () => {
  t = await bootApp();
  w = await buildWorld(t);
  await post(w.admin, '/policy', { ...FULL_POLICY, failedPickupFee: 3 }).expect(201);
});
after(() => t.close());

describe('recogida fallida', () => {
  it('retiene la solicitud, libera franja y chofer, cobra el cargo y avisa al cliente', async () => {
    const c = await w.newClient('fp1@test.local');
    const id = await arrived(c);
    const before = await t.prisma.fulfillmentLeg.findFirstOrThrow({ where: { orderId: id, kind: 'INBOUND' } });
    const slotId = before.slotId!;
    const reservedBefore = (await t.prisma.timeSlot.findUniqueOrThrow({ where: { id: slotId } })).reservedCount;

    const res = await failed(id).expect(201);
    assert.equal(res.body.status, 'INCIDENT');
    // La sede lista los pedidos retenidos por estado (Planta, Incidencias).
    const held = await t.http.get(`${api}/orders?status=INCIDENT`).set(bearer(w.admin)).expect(200);
    assert.ok(held.body.data.some((o: { id: string }) => o.id === id));

    const leg = await t.prisma.fulfillmentLeg.findFirstOrThrow({ where: { orderId: id, kind: 'INBOUND' } });
    assert.deepEqual([leg.status, leg.driverId, leg.slotId], ['PENDING', null, null]);
    assert.equal(
      (await t.prisma.timeSlot.findUniqueOrThrow({ where: { id: slotId } })).reservedCount,
      reservedBefore - 1,
    );
    const charge = await t.prisma.customerCharge.findFirstOrThrow({ where: { orderId: id } });
    assert.deepEqual([charge.type, charge.amount.toString(), charge.status], ['FAILED_PICKUP', '3', 'PENDING']);
    const incident = await t.prisma.incident.findFirstOrThrow({ where: { orderId: id } });
    assert.deepEqual(
      [incident.type, incident.status, incident.previousStatus, incident.description],
      ['FAILED_PICKUP', 'OPEN', 'CONFIRMED', 'Cliente ausente'],
    );
    const event = await t.prisma.orderEvent.findFirstOrThrow({ where: { orderId: id, status: 'INCIDENT' } });
    assert.equal(event.title, 'Recogida fallida');
    const notice = await t.prisma.notification.findFirstOrThrow({
      where: { customerId: c.customerId, category: 'INCIDENT' },
    });
    assert.match(notice.body, /cargo de \$3\.00/);
    // El chofer ya no ve el pedido como asignado.
    await t.http.get(`${api}/orders/${id}`).set(bearer(w.driverToken)).expect(404);
  });

  it('exige motivo, estar en el domicilio, ser el chofer asignado y la versión vigente', async () => {
    const c = await w.newClient('fp2@test.local');
    await w.credit(c.customerId, 100);
    const id = await w.order(c);
    await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(201);
    await post(w.admin, `/orders/${id}/assign`, {
      expectedVersion: await w.version(id), leg: 'INBOUND', driverId: w.driverId,
    }).expect(201);
    // Antes de llegar no se reporta.
    await failed(id).expect(409);
    await move(w.driverToken, id, 'HEADING_TO_PICKUP');
    await move(w.driverToken, id, 'ARRIVED_FOR_PICKUP');
    await failed(id, w.driverToken, '   ').expect(400);
    await post(w.driverToken, `/orders/${id}/failed-pickup`, { expectedVersion: 1, reason: 'x' }).expect(409);
    await failed(id, c.token).expect(403);
    await failed(id, w.admin).expect(403);
    // Otro chofer no puede reportarla.
    const other = await createUser(t, { email: 'otro-fp@test.local', role: 'DRIVER' });
    await t.prisma.driver.create({ data: { userId: other.id, facilityId: w.facilityId } });
    await failed(id, await login(t, 'otro-fp@test.local')).expect(404);
  });

  it('la sede reprograma la recogida y, al resolver la incidencia, vuelve a Confirmada para asignar', async () => {
    const c = await w.newClient('fp3@test.local');
    const id = await arrived(c);
    await failed(id).expect(201);

    const newSlot = await w.slot('DRIVER_PICKUP');
    // El cliente no reprograma la recogida; la sede sí.
    await put(c.token, `/orders/${id}/inbound`, { expectedVersion: await w.version(id), slotId: newSlot }).expect(403);
    const res = await put(w.admin, `/orders/${id}/inbound`, {
      expectedVersion: await w.version(id), slotId: newSlot,
    }).expect(200);
    assert.equal(res.body.status, 'INCIDENT');
    const leg = await t.prisma.fulfillmentLeg.findFirstOrThrow({ where: { orderId: id, kind: 'INBOUND' } });
    assert.deepEqual([leg.status, leg.slotId], ['SCHEDULED', newSlot]);
    assert.equal((await t.prisma.timeSlot.findUniqueOrThrow({ where: { id: newSlot } })).reservedCount, 1);
    // No se programa dos veces.
    await put(w.admin, `/orders/${id}/inbound`, {
      expectedVersion: await w.version(id), slotId: await w.slot('DRIVER_PICKUP'),
    }).expect(409);

    const incident = await t.prisma.incident.findFirstOrThrow({ where: { orderId: id } });
    await post(w.admin, `/incidents/${incident.id}/status`, {
      status: 'RESOLVED', resolution: 'Recogida reprogramada con el cliente',
    }).expect(201);
    assert.equal((await t.prisma.order.findUniqueOrThrow({ where: { id } })).status, 'CONFIRMED');
    await post(w.admin, `/orders/${id}/assign`, {
      expectedVersion: await w.version(id), leg: 'INBOUND', driverId: w.driverId,
    }).expect(201);
    assert.equal((await t.prisma.order.findUniqueOrThrow({ where: { id } })).status, 'PICKUP_ASSIGNED');
  });

  it('la sede puede cancelar la solicitud retenida; se reembolsa lo pagado y se cierra la incidencia', async () => {
    const c = await w.newClient('fp4@test.local');
    const id = await arrived(c);
    await failed(id).expect(201);
    // El cliente no puede cancelar una solicitud retenida.
    await post(c.token, `/orders/${id}/cancel`, { expectedVersion: await w.version(id), reason: 'Ya no' }).expect(409);
    const res = await post(w.admin, `/orders/${id}/cancel`, {
      expectedVersion: await w.version(id), reason: 'El cliente desistió',
    }).expect(201);
    assert.equal(res.body.status, 'CANCELLED');
    assert.equal(res.body.paymentStatus, 'REFUNDED');
    const incident = await t.prisma.incident.findFirstOrThrow({ where: { orderId: id } });
    assert.equal(incident.status, 'CLOSED');
    // El cargo por recogida fallida se mantiene aparte del reembolso.
    const charge = await t.prisma.customerCharge.findFirstOrThrow({ where: { orderId: id } });
    assert.equal(charge.status, 'PENDING');
  });

  it('una retención por otra incidencia no habilita la cancelación', async () => {
    const c = await w.newClient('fp5@test.local');
    const id = await arrived(c);
    await post(w.driverToken, '/incidents', {
      orderId: id, type: 'DAMAGE', severity: 'HIGH', description: 'Prenda dañada', holdOrder: true,
    }).expect(201);
    await post(w.admin, `/orders/${id}/cancel`, {
      expectedVersion: await w.version(id), reason: 'Prueba',
    }).expect(409);
  });

  it('si la nueva recogida queda después de la entrega programada, la entrega se libera', async () => {
    const c = await w.newClient('fp6@test.local');
    await w.credit(c.customerId, 100);
    const pickup = await w.slot('DRIVER_PICKUP');
    const delivery = await w.slot('DRIVER_DELIVERY');
    const id = await w.order(c, { pickupSlotId: pickup, outbound: { slotId: delivery } });
    await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(201);
    await post(w.admin, `/orders/${id}/assign`, {
      expectedVersion: await w.version(id), leg: 'INBOUND', driverId: w.driverId,
    }).expect(201);
    await move(w.driverToken, id, 'HEADING_TO_PICKUP');
    await move(w.driverToken, id, 'ARRIVED_FOR_PICKUP');
    await failed(id).expect(201);
    const later = await w.slot('DRIVER_PICKUP'); // posterior a la franja de entrega
    await put(w.admin, `/orders/${id}/inbound`, { expectedVersion: await w.version(id), slotId: later }).expect(200);
    const out = await t.prisma.fulfillmentLeg.findFirstOrThrow({ where: { orderId: id, kind: 'OUTBOUND' } });
    assert.deepEqual([out.slotId, out.status], [null, 'PENDING']);
    assert.equal((await t.prisma.timeSlot.findUniqueOrThrow({ where: { id: delivery } })).reservedCount, 0);
  });
});
