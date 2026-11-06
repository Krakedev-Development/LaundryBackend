import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bearer, bootApp, type TestApp } from '../helpers';
import { api, buildWorld, FULL_POLICY, type Client, type World } from '../world';

let t: TestApp;
let w: World;

const post = (token: string, path: string, body: object = {}) =>
  t.http.post(`${api}${path}`).set(bearer(token)).send(body);
const get = (token: string, path: string) =>
  t.http.get(`${api}${path}`).set(bearer(token));
const publish = (over: Record<string, unknown> = {}) =>
  post(w.admin, '/policy', { ...FULL_POLICY, ...over }).expect(201);
// Resuelve la versión vigente justo al ejecutar la petición.
const move = (token: string, id: string, to: string) => ({
  async expect(status: number) {
    const expectedVersion = await w.version(id);
    return post(token, `/orders/${id}/transitions`, { to, expectedVersion }).expect(status);
  },
});

// Pedido pagado y con el chofer asignado a la recogida.
async function assigned(c: Client) {
  await w.credit(c.customerId, 100);
  const id = await w.order(c);
  await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(201);
  await post(w.admin, `/orders/${id}/assign`, {
    expectedVersion: await w.version(id), leg: 'INBOUND', driverId: w.driverId,
  }).expect(201);
  return id;
}

before(async () => {
  t = await bootApp();
  w = await buildWorld(t);
});
after(() => t.close());

describe('KYC', () => {
  it('el cliente envía, el personal revisa y se notifica el resultado', async () => {
    const c = await w.newClient('kyc@test.local');
    assert.equal((await get(c.token, '/kyc/me')).body.status, 'NOT_SUBMITTED');
    await post(c.token, '/kyc/me', { documentType: 'CC', documentNumber: '123' }).expect(201);
    assert.equal((await get(c.token, '/kyc/me')).body.status, 'PENDING');
    await post(c.token, '/kyc/me', { documentType: 'CC', documentNumber: '123' }).expect(409);

    await get(c.token, '/kyc').expect(403);
    const queue = await get(w.supervisor, '/kyc').expect(200);
    assert.ok(queue.body.some((x: { id: string }) => x.id === c.customerId));

    await post(w.supervisor, `/kyc/${c.customerId}/review`, { approve: false }).expect(400);
    await post(w.supervisor, `/kyc/${c.customerId}/review`, { approve: false, reason: 'Foto borrosa' }).expect(201);
    const rejected = (await get(c.token, '/kyc/me')).body;
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.rejectionReason, 'Foto borrosa');

    await post(c.token, '/kyc/me', { documentType: 'CC', documentNumber: '123' }).expect(201);
    await post(w.supervisor, `/kyc/${c.customerId}/review`, { approve: true }).expect(201);
    // Ya revisado: no se revisa dos veces.
    await post(w.supervisor, `/kyc/${c.customerId}/review`, { approve: true }).expect(409);
    assert.equal((await get(c.token, '/kyc/me')).body.status, 'APPROVED');
    const notes = await get(c.token, '/notifications').expect(200);
    assert.equal(notes.body.data.filter((n: { category: string }) => n.category === 'KYC').length, 2);
  });

  it('si la política lo exige, solo clientes verificados crean pedidos', async () => {
    await publish({ requireKycForOrders: true });
    const c = await w.newClient('kyc2@test.local');
    const body = async () => ({
      facilityId: w.facilityId, mode: 'HOME_HOME', pickupAddressId: c.addressId,
      pickupSlotId: await w.slot('DRIVER_PICKUP'),
      items: [{ garmentId: w.garmentId, serviceId: w.serviceId, quantity: 1 }],
    });
    await post(c.token, '/orders', await body()).expect(403);
    await post(c.token, '/kyc/me', { documentType: 'CC', documentNumber: '9' }).expect(201);
    await post(w.admin, `/kyc/${c.customerId}/review`, { approve: true }).expect(201);
    await post(c.token, '/orders', await body()).expect(201);
    await publish();
  });
});

describe('puntos y canjes', () => {
  it('suma al completar según la política del pedido y no duplica', async () => {
    await publish({ pointsPerCurrencyUnit: 2 });
    const c = await w.newClient('points@test.local');
    await w.credit(c.customerId, 100);
    const id = await w.order(c); // total 15.4
    await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(201);
    await t.prisma.order.update({ where: { id }, data: { status: 'DELIVERED' } });
    await post(w.admin, `/orders/${id}/complete`, { expectedVersion: await w.version(id) }).expect(201);
    assert.equal((await get(c.token, '/points')).body.balance, 30); // floor(15.4 * 2)
    await post(w.admin, `/orders/${id}/complete`, { expectedVersion: await w.version(id) }).expect(409);
    assert.equal((await get(c.token, '/points')).body.balance, 30);

    // Una política posterior no altera pedidos ya creados.
    await publish({ pointsPerCurrencyUnit: 100 });
    assert.equal((await get(c.token, '/points')).body.balance, 30);
    await publish();
  });

  it('sin tasa configurada no se acumulan puntos', async () => {
    const c = await w.newClient('nopoints@test.local');
    await w.credit(c.customerId, 100);
    const id = await w.order(c);
    await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(201);
    await t.prisma.order.update({ where: { id }, data: { status: 'DELIVERED' } });
    await post(w.admin, `/orders/${id}/complete`, { expectedVersion: await w.version(id) }).expect(201);
    assert.equal((await get(c.token, '/points')).body.balance, 0);
  });

  it('canjear reserva puntos; el rechazo los devuelve y la aprobación los consume', async () => {
    const c = await w.newClient('redeem@test.local');
    await t.prisma.pointsLedgerEntry.create({
      data: { customerId: c.customerId, points: 30, reason: 'FIXTURE' },
    });
    const reward = await post(w.admin, '/catalog/rewards', { title: 'Descuento', pointsCost: 20 }).expect(201);
    await post(c.token, '/points/redeem', { rewardId: '00000000-0000-4000-8000-000000000000' }).expect(404);
    const r1 = await post(c.token, '/points/redeem', { rewardId: reward.body.id }).expect(201);
    assert.equal((await get(c.token, '/points')).body.balance, 10);
    await post(c.token, '/points/redeem', { rewardId: reward.body.id }).expect(409); // sin puntos

    await post(c.token, `/redemptions/${r1.body.id}/review`, { approve: true }).expect(403);
    await post(w.supervisor, `/redemptions/${r1.body.id}/review`, { approve: false }).expect(400);
    await post(w.supervisor, `/redemptions/${r1.body.id}/review`, { approve: false, reason: 'Sin stock' }).expect(201);
    assert.equal((await get(c.token, '/points')).body.balance, 30);
    await post(w.supervisor, `/redemptions/${r1.body.id}/review`, { approve: true }).expect(409);

    const r2 = await post(c.token, '/points/redeem', { rewardId: reward.body.id }).expect(201);
    await post(w.supervisor, `/redemptions/${r2.body.id}/review`, { approve: true }).expect(201);
    assert.equal((await get(c.token, '/points')).body.balance, 10);
    const mine = await get(c.token, '/redemptions?status=APPROVED').expect(200);
    assert.equal(mine.body.length, 1);
  });

  it('dos canjes simultáneos no gastan puntos que no hay', async () => {
    const c = await w.newClient('redeemrace@test.local');
    await t.prisma.pointsLedgerEntry.create({
      data: { customerId: c.customerId, points: 25, reason: 'FIXTURE' },
    });
    const reward = await post(w.admin, '/catalog/rewards', { title: 'Otro', pointsCost: 20 }).expect(201);
    const rs = await Promise.all([
      post(c.token, '/points/redeem', { rewardId: reward.body.id }),
      post(c.token, '/points/redeem', { rewardId: reward.body.id }),
    ]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
    assert.equal((await get(c.token, '/points')).body.balance, 5);
  });
});

describe('incidencias', () => {
  it('el chofer retiene el pedido, el flujo se pausa y se reanuda al resolver', async () => {
    const c = await w.newClient('inc@test.local');
    const id = await assigned(c);
    await move(w.driverToken, id, 'HEADING_TO_PICKUP').expect(201);

    // El cliente puede reportar, pero no retener.
    await post(c.token, '/incidents', {
      orderId: id, type: 'CUSTOMER_REPORT', severity: 'LOW', description: 'Cambio de dirección', holdOrder: true,
    }).expect(403);
    await post(c.token, '/incidents', {
      orderId: id, type: 'CUSTOMER_REPORT', severity: 'LOW', description: 'Cambio de dirección',
    }).expect(201);
    assert.equal((await t.prisma.order.findUniqueOrThrow({ where: { id } })).status, 'HEADING_TO_PICKUP');

    const inc = await post(w.driverToken, '/incidents', {
      orderId: id, type: 'CUSTOMER_ABSENT', severity: 'MEDIUM', description: 'No responde', holdOrder: true,
    }).expect(201);
    assert.equal(inc.body.previousStatus, 'HEADING_TO_PICKUP');
    assert.equal((await t.prisma.order.findUniqueOrThrow({ where: { id } })).status, 'INCIDENT');
    // Retenido: no avanza ni se cancela por el flujo normal.
    await move(w.driverToken, id, 'ARRIVED_FOR_PICKUP').expect(409);
    await post(w.admin, `/orders/${id}/cancel`, { expectedVersion: await w.version(id), reason: 'x' }).expect(409);

    await post(w.supervisor, `/incidents/${inc.body.id}/status`, { status: 'CLOSED' }).expect(409);
    await post(w.supervisor, `/incidents/${inc.body.id}/status`, { status: 'IN_REVIEW' }).expect(201);
    await post(w.supervisor, `/incidents/${inc.body.id}/status`, { status: 'RESOLVED' }).expect(400);
    await post(c.token, `/incidents/${inc.body.id}/status`, { status: 'RESOLVED', resolution: 'x' }).expect(403);
    const resolved = await post(w.supervisor, `/incidents/${inc.body.id}/status`, {
      status: 'RESOLVED', resolution: 'Cliente contactado',
    }).expect(201);
    assert.equal(resolved.body.status, 'RESOLVED');
    assert.equal((await t.prisma.order.findUniqueOrThrow({ where: { id } })).status, 'HEADING_TO_PICKUP');
    await move(w.driverToken, id, 'ARRIVED_FOR_PICKUP').expect(201);
    await post(w.supervisor, `/incidents/${inc.body.id}/status`, { status: 'CLOSED' }).expect(201);

    // Visibilidad: el cliente solo ve lo que reportó; el personal ve todo.
    assert.equal((await get(c.token, '/incidents')).body.length, 1);
    assert.equal((await get(w.supervisor, `/incidents?orderId=${id}`)).body.length, 2);
  });

  it('no se retiene un pedido sin pagar ni se retiene dos veces', async () => {
    const c = await w.newClient('inc2@test.local');
    const unpaid = await w.order(c);
    await post(w.supervisor, '/incidents', {
      orderId: unpaid, type: 'X', severity: 'LOW', description: 'd', holdOrder: true,
    }).expect(409);
    const id = await assigned(c);
    const body = { orderId: id, type: 'X', severity: 'HIGH', description: 'd', holdOrder: true };
    await post(w.supervisor, '/incidents', body).expect(201);
    await post(w.supervisor, '/incidents', body).expect(409);
  });
});

describe('chat y notificaciones', () => {
  it('solo participantes escriben y leen; el cliente recibe aviso del personal', async () => {
    const c = await w.newClient('chat@test.local');
    const other = await w.newClient('chat-other@test.local');
    const id = await assigned(c);

    await post(other.token, `/orders/${id}/messages`, { text: 'hola' }).expect(404);
    await get(other.token, `/orders/${id}/messages`).expect(404);

    const first = await post(c.token, `/orders/${id}/messages`, { text: 'Toco el timbre' }).expect(201);
    await post(w.driverToken, `/orders/${id}/messages`, { text: 'Voy en camino' }).expect(201);
    await post(w.supervisor, `/orders/${id}/messages`, { text: '   ' }).expect(400);

    const all = await get(c.token, `/orders/${id}/messages`).expect(200);
    assert.deepEqual(all.body.map((m: { text: string }) => m.text), ['Toco el timbre', 'Voy en camino']);
    const after = await get(c.token, `/orders/${id}/messages?after=${encodeURIComponent(first.body.createdAt)}`).expect(200);
    assert.equal(after.body.length, 1);

    const notes = (await get(c.token, '/notifications')).body.data;
    assert.ok(notes.some((n: { category: string }) => n.category === 'CHAT'));

    // Cancelado: el hilo se cierra.
    await post(c.token, `/orders/${id}/cancel`, { expectedVersion: await w.version(id), reason: 'x' }).expect(201);
    await post(c.token, `/orders/${id}/messages`, { text: 'otra vez' }).expect(409);
  });

  it('las notificaciones se leen una a una o todas, y son privadas', async () => {
    const c = await w.newClient('notif@test.local');
    const other = await w.newClient('notif-other@test.local');
    await w.credit(c.customerId, 100);
    const id = await w.order(c);
    await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(201);
    await post(w.admin, `/orders/${id}/assign`, {
      expectedVersion: await w.version(id), leg: 'INBOUND', driverId: w.driverId,
    }).expect(201);

    const list = (await get(c.token, '/notifications')).body;
    assert.ok(list.unread >= 2);
    const titles = list.data.map((n: { title: string }) => n.title);
    assert.ok(titles.includes('Pedido confirmado'));
    assert.ok(titles.includes('Chofer asignado'));

    await post(other.token, `/notifications/${list.data[0].id}/read`).expect(404);
    await post(c.token, `/notifications/${list.data[0].id}/read`).expect(201);
    assert.equal((await get(c.token, '/notifications')).body.unread, list.unread - 1);
    await post(c.token, '/notifications/read-all').expect(201);
    assert.equal((await get(c.token, '/notifications?unread=true')).body.total, 0);
  });
});
