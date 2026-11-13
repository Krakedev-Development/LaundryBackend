import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bearer, bootApp, createUser, login, type TestApp } from '../helpers';
import { api, buildWorld, type World } from '../world';

let t: TestApp;
let w: World;

const confirm = (token: string, id: string, body: object) =>
  t.http.post(`${api}/orders/${id}/confirm-payment`).set(bearer(token)).send(body);
const balance = async (token: string) =>
  Number((await t.http.get(`${api}/wallet`).set(bearer(token)).expect(200)).body.balance);

before(async () => {
  t = await bootApp();
  w = await buildWorld(t);
});
after(() => t.close());

describe('confirmación manual de pago por el personal', () => {
  it('el administrador confirma un pedido pendiente y pasa a CONFIRMED pagado', async () => {
    const c = await w.newClient('manual@test.local');
    const id = await w.order(c);

    await confirm(c.token, id, { expectedVersion: 1 }).expect(403);
    await confirm(w.admin, id, { expectedVersion: 99 }).expect(409);

    const res = await confirm(w.admin, id, {
      expectedVersion: 1,
      note: 'Transferencia Banco Pichincha #123',
    }).expect(201);
    assert.equal(res.body.status, 'CONFIRMED');
    assert.equal(res.body.paymentStatus, 'PAID');
    assert.equal(res.body.paymentMethodKind, 'TRANSFER');
    assert.equal(res.body.version, 2);
    assert.ok(
      res.body.events.some(
        (e: { description: string | null }) => e.description === 'Transferencia Banco Pichincha #123',
      ),
    );

    // El dinero externo no altera el saldo de la billetera del cliente.
    assert.equal(await balance(c.token), 0);
    // No se confirma dos veces.
    await confirm(w.admin, id, { expectedVersion: 2 }).expect(409);

    // Ya en la cola de despacho: se puede asignar chofer.
    await t.http
      .post(`${api}/orders/${id}/assign`)
      .set(bearer(w.admin))
      .send({ expectedVersion: 2, leg: 'INBOUND', driverId: w.driverId })
      .expect(201);
  });

  it('el supervisor confirma solo pedidos de su sede', async () => {
    const c = await w.newClient('manual-sup@test.local');
    const id = await w.order(c);

    const zone = await t.prisma.zone.findFirstOrThrow();
    const other = await t.prisma.facility.create({
      data: { zoneId: zone.id, name: 'Otra', address: 'x', latitude: 5, longitude: 5 },
    });
    const sup2 = await createUser(t, { email: 'sup-otra@test.local', role: 'SUPERVISOR' });
    await t.prisma.user.update({ where: { id: sup2.id }, data: { facilityId: other.id } });
    await confirm(await login(t, 'sup-otra@test.local'), id, { expectedVersion: 1 }).expect(404);

    const res = await confirm(w.supervisor, id, { expectedVersion: 1 }).expect(201);
    assert.equal(res.body.status, 'CONFIRMED');
    assert.ok(
      res.body.events.some(
        (e: { description: string | null }) => e.description === 'Pago confirmado por administración',
      ),
    );
  });

  it('si el personal cancela un pedido confirmado manualmente, lo pagado vuelve a la billetera', async () => {
    const c = await w.newClient('manual-cancel@test.local');
    const id = await w.order(c);
    const total = Number((await confirm(w.admin, id, { expectedVersion: 1 }).expect(201)).body.total);
    const res = await t.http
      .post(`${api}/orders/${id}/cancel`)
      .set(bearer(w.admin))
      .send({ expectedVersion: 2, reason: 'Cliente desiste' })
      .expect(201);
    assert.equal(res.body.paymentStatus, 'REFUNDED');
    assert.equal(await balance(c.token), total);
  });
});
