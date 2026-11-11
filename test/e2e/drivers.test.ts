import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bearer, bootApp, createUser, login, type TestApp } from '../helpers';
import { api, buildWorld, type World } from '../world';

let t: TestApp;
let w: World;

const get = (token: string, path: string) => t.http.get(`${api}${path}`).set(bearer(token));
const patch = (token: string, path: string, body: object) =>
  t.http.patch(`${api}${path}`).set(bearer(token)).send(body);

before(async () => {
  t = await bootApp();
  w = await buildWorld(t);
});
after(() => t.close());

describe('gestión de choferes', () => {
  it('el administrador lista choferes con sede y carga activa, y filtra por estado', async () => {
    const res = await get(w.admin, '/drivers').expect(200);
    assert.equal(res.body.length, 1);
    const d = res.body[0];
    assert.equal(d.id, w.driverId);
    assert.equal(d.facilityName, 'Sede');
    assert.equal(d.email, 'driver@test.local');
    assert.equal(d.status, 'OFFLINE');
    assert.equal(d.activeLegsCount, 0);
    assert.equal(d.latitude, null);
    assert.equal((await get(w.admin, '/drivers?status=AVAILABLE').expect(200)).body.length, 0);
    await get(w.admin, '/drivers?status=VOLANDO').expect(400);
  });

  it('el supervisor solo ve y edita choferes de su sede', async () => {
    const zone = await t.prisma.zone.findFirstOrThrow();
    const other = await t.prisma.facility.create({
      data: { zoneId: zone.id, name: 'Otra', address: 'x', latitude: 5, longitude: 5 },
    });
    const u = await createUser(t, { email: 'driver-otra@test.local', role: 'DRIVER' });
    const foreign = await t.prisma.driver.create({ data: { userId: u.id, facilityId: other.id } });

    const mine = await get(w.supervisor, `/drivers?facilityId=${other.id}`).expect(200);
    assert.deepEqual(mine.body.map((d: { id: string }) => d.id), [w.driverId]);
    await get(w.supervisor, `/drivers/${foreign.id}`).expect(404);
    await patch(w.supervisor, `/drivers/${w.driverId}`, { facilityId: other.id }).expect(403);

    const updated = await patch(w.supervisor, `/drivers/${w.driverId}`, {
      vehicle: 'Moto', plate: 'gye-123', status: 'AVAILABLE',
    }).expect(200);
    assert.equal(updated.body.plate, 'GYE-123');
    assert.equal(updated.body.status, 'AVAILABLE');
    assert.equal((await get(w.admin, '/drivers').expect(200)).body.length, 2);
  });

  it('el administrador puede reasignar la sede y no a una inexistente', async () => {
    await patch(w.admin, `/drivers/${w.driverId}`, {
      facilityId: '00000000-0000-4000-8000-000000000000',
    }).expect(404);
    await patch(w.admin, `/drivers/${w.driverId}`, { facilityId: w.facilityId }).expect(200);
  });
});

describe('telemetría del chofer', () => {
  it('el chofer consulta su perfil y reporta ubicación', async () => {
    const me = await get(w.driverToken, '/drivers/me').expect(200);
    assert.equal(me.body.id, w.driverId);
    assert.equal(me.body.facilityId, w.facilityId);

    await patch(w.driverToken, '/drivers/me/location', { latitude: 91, longitude: 0 }).expect(400);
    await patch(w.driverToken, '/drivers/me/location', { latitude: '5', longitude: 5 }).expect(400);
    const res = await patch(w.driverToken, '/drivers/me/location', {
      latitude: 5.123456, longitude: 5.654321, status: 'ON_SERVICE',
    }).expect(200);
    assert.equal(res.body.latitude, 5.123456);
    assert.equal(res.body.longitude, 5.654321);
    assert.equal(res.body.status, 'ON_SERVICE');
    assert.ok(res.body.locationAt);
  });

  it('una cuenta de chofer sin perfil recibe 404', async () => {
    await createUser(t, { email: 'sin-perfil@test.local', role: 'DRIVER' });
    const token = await login(t, 'sin-perfil@test.local');
    await get(token, '/drivers/me').expect(404);
  });
});

describe('seguimiento en vivo del pedido', () => {
  it('muestra el tramo activo y la ubicación del chofer asignado solo a quien puede ver el pedido', async () => {
    const c = await w.newClient('track@test.local');
    const other = await w.newClient('track-other@test.local');
    await w.credit(c.customerId, 100);
    const id = await w.order(c);

    const pending = await get(c.token, `/orders/${id}/tracking`).expect(200);
    assert.equal(pending.body.activeLeg, null);
    assert.equal(pending.body.assignedDriver, null);
    assert.equal(pending.body.customerAddress.text, 'Calle 1 #2-3');
    assert.equal(pending.body.facility.name, 'Sede');

    await t.http.post(`${api}/orders/${id}/pay`).set(bearer(c.token)).send({ expectedVersion: 1 }).expect(201);
    await t.http
      .post(`${api}/orders/${id}/assign`)
      .set(bearer(w.admin))
      .send({ expectedVersion: await w.version(id), leg: 'INBOUND', driverId: w.driverId })
      .expect(201);
    await patch(w.driverToken, '/drivers/me/location', { latitude: 4.5, longitude: 4.25 }).expect(200);

    const live = await get(c.token, `/orders/${id}/tracking`).expect(200);
    assert.equal(live.body.status, 'PICKUP_ASSIGNED');
    assert.equal(live.body.activeLeg, 'INBOUND');
    assert.equal(live.body.customerAddress.latitude, 5);
    assert.equal(live.body.assignedDriver.driverId, w.driverId);
    assert.equal(live.body.assignedDriver.latitude, 4.5);
    assert.equal(live.body.assignedDriver.longitude, 4.25);

    await get(w.driverToken, `/orders/${id}/tracking`).expect(200);
    await get(w.supervisor, `/orders/${id}/tracking`).expect(200);
    await get(other.token, `/orders/${id}/tracking`).expect(404);
    await t.http.get(`${api}/orders/${id}/tracking`).expect(401);

    const drivers = await get(w.admin, '/drivers').expect(200);
    const assigned = drivers.body.find((d: { id: string }) => d.id === w.driverId);
    assert.equal(assigned.activeLegsCount, 1);
  });
});
