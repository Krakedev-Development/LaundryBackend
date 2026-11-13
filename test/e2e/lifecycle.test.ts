import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bearer, bootApp, type TestApp } from '../helpers';
import { api, buildWorld, type Client, type World } from '../world';

let t: TestApp;
let w: World;

const post = (token: string, path: string, body: object = {}) =>
  t.http.post(`${api}${path}`).set(bearer(token)).send(body);
const get = (token: string, path: string) =>
  t.http.get(`${api}${path}`).set(bearer(token));
// Petición cuyo cuerpo (con la versión vigente) se resuelve al momento de ejecutarla.
const lazy = (build: () => Promise<[string, string, object]>) => ({
  async expect(status: number) {
    const [token, path, body] = await build();
    return post(token, path, body).expect(status);
  },
});
const move = (token: string, id: string, to: string) =>
  lazy(async () => [
    token,
    `/orders/${id}/transitions`,
    { to, expectedVersion: await w.version(id) },
  ]);

before(async () => {
  t = await bootApp();
  w = await buildWorld(t);
});
after(() => t.close());

describe('ciclo completo: recogida a domicilio, proceso y entrega a domicilio', () => {
  let c: Client;
  let id: string;

  it('crea el pedido, exige saldo y confirma al pagar con la billetera', async () => {
    c = await w.newClient('life@test.local');
    id = await w.order(c);
    // prendas 2 x 4.5 = 9; logística 5; IVA 1.4; total 15.4
    await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(409);
    await w.credit(c.customerId, 100);
    const paid = await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(201);
    assert.equal(paid.body.status, 'CONFIRMED');
    assert.equal(paid.body.paymentStatus, 'PAID');
    assert.equal(paid.body.total, '15.4');
    await post(c.token, `/orders/${id}/pay`, { expectedVersion: 2 }).expect(409);
    const wallet = await get(c.token, '/wallet').expect(200);
    assert.equal(wallet.body.balance, '84.6');
  });

  it('programa la entrega y asigna chofer a la recogida', async () => {
    await t.http
      .put(`${api}/orders/${id}/outbound`)
      .set(bearer(c.token))
      .send({ expectedVersion: await w.version(id), slotId: await w.slot('DRIVER_DELIVERY') })
      .expect(200);
    const res = await post(w.admin, `/orders/${id}/assign`, {
      expectedVersion: await w.version(id), leg: 'INBOUND', driverId: w.driverId,
    }).expect(201);
    assert.equal(res.body.status, 'PICKUP_ASSIGNED');
  });

  it('custodia en la recogida: cliente presenta, chofer verifica', async () => {
    await move(w.driverToken, id, 'HEADING_TO_PICKUP').expect(201);
    await move(w.driverToken, id, 'ARRIVED_FOR_PICKUP').expect(201);

    // Roles y etapa correctos.
    await post(w.driverToken, `/orders/${id}/handoffs/issue`, { type: 'CUSTOMER_TO_DRIVER' }).expect(403);
    await post(c.token, `/orders/${id}/handoffs/issue`, { type: 'DRIVER_TO_FACILITY' }).expect(409);

    const issued = await post(c.token, `/orders/${id}/handoffs/issue`, { type: 'CUSTOMER_TO_DRIVER' }).expect(201);
    assert.match(issued.body.code, /^\d{6}$/);
    const wrong = issued.body.code === '000000' ? '111111' : '000000';
    const verify = (body: object) =>
      lazy(async () => [
        w.driverToken,
        `/orders/${id}/handoffs/verify`,
        { type: 'CUSTOMER_TO_DRIVER', expectedVersion: await w.version(id), ...body },
      ]);
    await verify({ code: wrong }).expect(422);
    // El cliente no puede verificar su propio traspaso.
    await post(c.token, `/orders/${id}/handoffs/verify`, {
      type: 'CUSTOMER_TO_DRIVER', expectedVersion: await w.version(id), code: issued.body.code,
    }).expect(403);
    const ok = await verify({ code: issued.body.code, declaredCount: 2, receivedCount: 2 }).expect(201);
    assert.equal(ok.body.status, 'PICKED_UP');
    // Un código usado no sirve de nuevo.
    await verify({ code: issued.body.code }).expect(409);

    // Nada sensible se expone en la consulta.
    const list = await get(c.token, `/orders/${id}/handoffs`).expect(200);
    assert.equal(list.body[0].status, 'USED');
    assert.equal(list.body[0].codeHash, undefined);
    assert.equal(list.body[0].qrTokenHash, undefined);
  });

  it('chofer entrega en la sede con QR; el personal verifica', async () => {
    await move(w.driverToken, id, 'HEADING_TO_FACILITY').expect(201);
    const issued = await post(w.driverToken, `/orders/${id}/handoffs/issue`, { type: 'DRIVER_TO_FACILITY' }).expect(201);
    const res = await post(w.supervisor, `/orders/${id}/handoffs/verify`, {
      type: 'DRIVER_TO_FACILITY', expectedVersion: await w.version(id), qrToken: issued.body.qrToken,
    }).expect(201);
    assert.equal(res.body.status, 'AT_FACILITY');
    const inbound = res.body.legs.find((l: { kind: string }) => l.kind === 'INBOUND');
    assert.equal(inbound.status, 'COMPLETED');
  });

  it('pesaje, ajuste con aprobación del cliente y precio final', async () => {
    await move(w.supervisor, id, 'WEIGHING').expect(201);
    // Un cliente no pesa.
    await post(c.token, `/orders/${id}/weight`, { weightGrams: 3000, expectedVersion: await w.version(id) }).expect(403);
    const weighed = await post(w.supervisor, `/orders/${id}/weight`, {
      weightGrams: 3000, expectedVersion: await w.version(id),
    }).expect(201);
    assert.equal(weighed.body.status, 'INSPECTION');
    // Precio fijo: el peso no cambia el total.
    assert.equal(weighed.body.total, '15.4');
    await post(w.supervisor, `/orders/${id}/weight`, { weightGrams: 3000, expectedVersion: await w.version(id) }).expect(409);

    await move(w.supervisor, id, 'PRICING_PENDING').expect(201);
    await post(w.supervisor, `/orders/${id}/adjustments`, {
      type: 'EXTRA_ITEM', internalReason: 'Mancha especial', customerMessage: 'Tratamiento de mancha',
      amountDifference: 2, expectedVersion: await w.version(id),
    }).expect(201);

    // No se fija precio con ajustes sin decidir: pasa a espera del cliente.
    const waiting = await post(w.supervisor, `/orders/${id}/pricing/resolve`, { expectedVersion: await w.version(id) }).expect(201);
    assert.equal(waiting.body.status, 'CUSTOMER_APPROVAL_PENDING');
    await post(w.supervisor, `/orders/${id}/pricing/resolve`, { expectedVersion: await w.version(id) }).expect(409);

    const adjustments = await get(c.token, `/orders/${id}/adjustments`).expect(200);
    assert.equal(adjustments.body[0].internalReason, undefined);
    await post(c.token, `/orders/${id}/adjustments/${adjustments.body[0].id}/decision`, {
      approve: true, expectedVersion: await w.version(id),
    }).expect(201);

    const final = await post(w.supervisor, `/orders/${id}/pricing/resolve`, { expectedVersion: await w.version(id) }).expect(201);
    assert.equal(final.body.status, 'IN_PROCESS');
    assert.equal(final.body.total, '17.4');
    assert.equal(final.body.pricingStatus, 'FINAL');
    // Lo pagado (15.4) no cubre el total: queda diferencia por cobrar.
    assert.equal(final.body.paymentStatus, 'PENDING');
    const paid = await post(c.token, `/orders/${id}/pay`, { expectedVersion: await w.version(id) }).expect(201);
    assert.equal(paid.body.paymentStatus, 'PAID');
  });

  it('proceso, entrega con custodia y cierre', async () => {
    await move(w.supervisor, id, 'QUALITY_CONTROL').expect(201);
    // Cierre prematuro y saltos de etapa no se permiten.
    await move(w.supervisor, id, 'DELIVERED').expect(409);
    await move(w.supervisor, id, 'READY_FOR_DELIVERY').expect(201);
    await post(w.admin, `/orders/${id}/assign`, {
      expectedVersion: await w.version(id), leg: 'OUTBOUND', driverId: w.driverId,
    }).expect(201);

    // Salir a entregar exige recibir la ropa de la sede con custodia.
    const blocked = await move(w.driverToken, id, 'OUT_FOR_DELIVERY').expect(409);
    assert.match(blocked.body.message, /custodia/);
    const out = await post(w.driverToken, `/orders/${id}/handoffs/issue`, { type: 'FACILITY_TO_DRIVER' }).expect(201);
    const left = await post(w.supervisor, `/orders/${id}/handoffs/verify`, {
      type: 'FACILITY_TO_DRIVER', expectedVersion: await w.version(id), code: out.body.code,
    }).expect(201);
    assert.equal(left.body.status, 'OUT_FOR_DELIVERY');

    await move(w.driverToken, id, 'ARRIVED_FOR_DELIVERY').expect(201);
    const pin = await post(c.token, `/orders/${id}/handoffs/issue`, { type: 'DRIVER_TO_CUSTOMER' }).expect(201);
    const delivered = await post(w.driverToken, `/orders/${id}/handoffs/verify`, {
      type: 'DRIVER_TO_CUSTOMER', expectedVersion: await w.version(id), code: pin.body.code,
      recipientName: 'Titular', recipientRelationship: 'Titular',
    }).expect(201);
    assert.equal(delivered.body.status, 'DELIVERED');
    assert.ok(delivered.body.legs.every((l: { status: string }) => l.status === 'COMPLETED'));

    const done = await post(w.admin, `/orders/${id}/complete`, { expectedVersion: await w.version(id) }).expect(201);
    assert.equal(done.body.status, 'COMPLETED');
    assert.ok(done.body.events.length >= 18);
    assert.equal((await get(c.token, '/wallet').expect(200)).body.balance, '82.6');
  });
});

describe('seguridad de la custodia', () => {
  let c: Client;
  let id: string;
  before(async () => {
    c = await w.newClient('custody@test.local');
    await w.credit(c.customerId, 100);
    id = await w.order(c);
    await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(201);
    await post(w.admin, `/orders/${id}/assign`, {
      expectedVersion: await w.version(id), leg: 'INBOUND', driverId: w.driverId,
    }).expect(201);
    await move(w.driverToken, id, 'HEADING_TO_PICKUP').expect(201);
    await move(w.driverToken, id, 'ARRIVED_FOR_PICKUP').expect(201);
  });

  it('bloquea tras agotar los intentos y obliga a reemitir', async () => {
    const issued = await post(c.token, `/orders/${id}/handoffs/issue`, { type: 'CUSTOMER_TO_DRIVER' }).expect(201);
    const wrong = issued.body.code === '000000' ? '111111' : '000000';
    const verify = (code: string) =>
      lazy(async () => [
        w.driverToken,
        `/orders/${id}/handoffs/verify`,
        { type: 'CUSTOMER_TO_DRIVER', expectedVersion: await w.version(id), code },
      ]);
    await verify(wrong).expect(422);
    await verify(wrong).expect(422);
    await verify(wrong).expect(423);
    // Ni el código correcto sirve ya.
    await verify(issued.body.code).expect(409);
    assert.equal((await t.prisma.order.findUniqueOrThrow({ where: { id } })).status, 'ARRIVED_FOR_PICKUP');
    const audits = await t.prisma.handoffAudit.findMany({ where: { handoffId: issued.body.handoffId } });
    assert.ok(audits.some((a) => a.action === 'LOCKED'));

    // Al reemitir, el anterior queda revocado y el nuevo funciona.
    const again = await post(c.token, `/orders/${id}/handoffs/issue`, { type: 'CUSTOMER_TO_DRIVER' }).expect(201);
    assert.notEqual(again.body.handoffId, issued.body.handoffId);
    const ok = await verify(again.body.code).expect(201);
    assert.equal(ok.body.status, 'PICKED_UP');
  });

  it('un código vencido se rechaza con 410', async () => {
    const c2 = await w.newClient('expiry@test.local');
    await w.credit(c2.customerId, 100);
    const id2 = await w.order(c2);
    await post(c2.token, `/orders/${id2}/pay`, { expectedVersion: 1 }).expect(201);
    await post(w.admin, `/orders/${id2}/assign`, {
      expectedVersion: await w.version(id2), leg: 'INBOUND', driverId: w.driverId,
    }).expect(201);
    await move(w.driverToken, id2, 'HEADING_TO_PICKUP').expect(201);
    await move(w.driverToken, id2, 'ARRIVED_FOR_PICKUP').expect(201);
    const issued = await post(c2.token, `/orders/${id2}/handoffs/issue`, { type: 'CUSTOMER_TO_DRIVER' }).expect(201);
    await t.prisma.handoff.update({
      where: { id: issued.body.handoffId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await post(w.driverToken, `/orders/${id2}/handoffs/verify`, {
      type: 'CUSTOMER_TO_DRIVER', expectedVersion: await w.version(id2), code: issued.body.code,
    }).expect(410);
  });

  it('el código guardado no es el código en claro', async () => {
    const h = await t.prisma.handoff.findFirstOrThrow({ where: { orderId: id, status: 'USED' } });
    assert.match(h.codeHash, /^[0-9a-f]{64}$/);
    assert.match(h.qrTokenHash, /^[0-9a-f]{64}$/);
  });
});

describe('billetera, cargos y reembolsos', () => {
  it('cancelar un pedido pagado devuelve el dinero a la billetera', async () => {
    const c = await w.newClient('refund@test.local');
    await w.credit(c.customerId, 50);
    const id = await w.order(c);
    await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(201);
    assert.equal((await get(c.token, '/wallet')).body.balance, '34.6');
    const res = await post(c.token, `/orders/${id}/cancel`, {
      expectedVersion: await w.version(id), reason: 'Ya no lo necesito',
    }).expect(201);
    assert.equal(res.body.paymentStatus, 'REFUNDED');
    assert.equal((await get(c.token, '/wallet')).body.balance, '50');
  });

  it('dos pagos simultáneos no pueden sobregirar la billetera', async () => {
    const c = await w.newClient('race@test.local');
    await w.credit(c.customerId, 20); // alcanza para un pedido de 15.4, no para dos
    const a = await w.order(c);
    const b = await w.order(c);
    const results = await Promise.all([
      post(c.token, `/orders/${a}/pay`, { expectedVersion: 1 }),
      post(c.token, `/orders/${b}/pay`, { expectedVersion: 1 }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal((await get(c.token, '/wallet')).body.balance, '4.6');
  });

  it('un abono manual es idempotente y solo lo hace el administrador', async () => {
    const c = await w.newClient('credit@test.local');
    const body = { customerId: c.customerId, amount: 10, reference: 'TRF-1', idempotencyKey: 'abc' };
    await post(c.token, '/wallet/credits', body).expect(403);
    await post(w.admin, '/wallet/credits', body).expect(201);
    await post(w.admin, '/wallet/credits', body).expect(409);
    assert.equal((await get(c.token, '/wallet')).body.balance, '10');
  });

  it('un cargo pendiente se paga con saldo o lo condona el administrador', async () => {
    const c = await w.newClient('charge@test.local');
    const mk = (amount: number) =>
      t.prisma.customerCharge.create({
        data: { customerId: c.customerId, type: 'OTHER', amount, reason: 'Prueba' },
      });
    const [c1, c2] = [await mk(7), await mk(3)];
    await post(c.token, `/wallet/charges/${c1.id}/pay`).expect(409); // sin saldo
    await w.credit(c.customerId, 10);
    const paid = await post(c.token, `/wallet/charges/${c1.id}/pay`).expect(201);
    assert.equal(paid.body.status, 'PAID');
    await post(c.token, `/wallet/charges/${c1.id}/pay`).expect(409); // ya pagado
    assert.equal((await get(c.token, '/wallet')).body.balance, '3');
    await post(c.token, `/wallet/charges/${c2.id}/waive`, { reason: 'x' }).expect(403);
    const waived = await post(w.admin, `/wallet/charges/${c2.id}/waive`, { reason: 'Cortesía' }).expect(201);
    assert.equal(waived.body.status, 'WAIVED');
    assert.equal((await get(c.token, '/wallet')).body.balance, '3');
  });
});

describe('pedidos por peso', () => {
  // Fixture: el pedido se coloca en pesaje (el recorrido previo ya está cubierto arriba).
  async function weighable(email: string, grams: number) {
    const c = await w.newClient(email);
    await w.credit(c.customerId, 100);
    const id = await w.order(c, { items: undefined, weightTierId: w.weightTierId });
    // 10 lb x 1.5 = 15; logística 5; IVA 2; total 22
    await post(c.token, `/orders/${id}/pay`, { expectedVersion: 1 }).expect(201);
    await t.prisma.order.update({ where: { id }, data: { status: 'WEIGHING' } });
    const res = await post(w.supervisor, `/orders/${id}/weight`, {
      weightGrams: grams, expectedVersion: await w.version(id),
    }).expect(201);
    return { c, id, res };
  }

  it('si pesa más, el aumento requiere aprobación y se cobra la diferencia', async () => {
    const { c, id, res } = await weighable('heavy@test.local', 6000);
    assert.equal(res.body.pricingStatus, 'ADJUSTMENT_PENDING');
    await move(w.supervisor, id, 'PRICING_PENDING').expect(201);
    await post(w.supervisor, `/orders/${id}/pricing/resolve`, { expectedVersion: await w.version(id) }).expect(201);
    const adj = (await get(c.token, `/orders/${id}/adjustments`)).body[0];
    assert.equal(adj.type, 'WEIGHT_ADJUSTMENT');
    // 6000 g = 13.23 lb -> 19.85; base 24.85; IVA 2.49; total 27.34 (+5.34)
    assert.equal(adj.amountDifference, '5.34');
    await post(c.token, `/orders/${id}/adjustments/${adj.id}/decision`, {
      approve: true, expectedVersion: await w.version(id),
    }).expect(201);
    const final = await post(w.supervisor, `/orders/${id}/pricing/resolve`, { expectedVersion: await w.version(id) }).expect(201);
    assert.equal(final.body.total, '27.34');
    assert.equal(final.body.itemsSubtotal, '19.85');
    assert.equal(final.body.paymentStatus, 'PENDING');
  });

  it('si pesa menos, se ajusta solo y se devuelve la diferencia a la billetera', async () => {
    const { c, id } = await weighable('light@test.local', 2000);
    await move(w.supervisor, id, 'PRICING_PENDING').expect(201);
    // 2000 g = 4.41 lb -> 6.62; base 11.62; IVA 1.16; total 12.78 (-9.22): sin aprobación.
    const final = await post(w.supervisor, `/orders/${id}/pricing/resolve`, { expectedVersion: await w.version(id) }).expect(201);
    assert.equal(final.body.status, 'IN_PROCESS');
    assert.equal(final.body.total, '12.78');
    assert.equal(final.body.paymentStatus, 'PAID');
    // 100 - 22 pagado + 9.22 devuelto
    assert.equal((await get(c.token, '/wallet')).body.balance, '87.22');
  });

  it('un rechazo del cliente deja el precio original y requiere revisión del personal', async () => {
    const { c, id } = await weighable('reject@test.local', 6000);
    await move(w.supervisor, id, 'PRICING_PENDING').expect(201);
    await post(w.supervisor, `/orders/${id}/pricing/resolve`, { expectedVersion: await w.version(id) }).expect(201);
    const adj = (await get(c.token, `/orders/${id}/adjustments`)).body[0];
    const decided = await post(c.token, `/orders/${id}/adjustments/${adj.id}/decision`, {
      approve: false, expectedVersion: await w.version(id),
    }).expect(201);
    assert.equal(decided.body.requiresStaffReview, true);
    const final = await post(w.supervisor, `/orders/${id}/pricing/resolve`, { expectedVersion: await w.version(id) }).expect(201);
    assert.equal(final.body.total, '22');
  });
});
