import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SlotsService } from '../../src/slots/slots.service';
import {
  bearer,
  bootApp,
  createUser,
  login,
  type TestApp,
} from '../helpers';

const api = '/api/v1';
const DAY = '2099-06-15';
let t: TestApp;
let admin: string;
let client: string;
let supervisor: string;
let facilityId: string;
let otherFacilityId: string;

const slot = (over: Record<string, unknown> = {}) => ({
  facilityId,
  context: 'DRIVER_PICKUP',
  date: DAY,
  startTime: '09:00',
  endTime: '11:00',
  capacity: 3,
  ...over,
});

before(async () => {
  t = await bootApp();
  await createUser(t, { email: 'admin@test.local', role: 'ADMIN' });
  await createUser(t, { email: 'client@test.local', role: 'CLIENT' });
  const sup = await createUser(t, { email: 'sup@test.local', role: 'SUPERVISOR' });
  admin = await login(t, 'admin@test.local');
  client = await login(t, 'client@test.local');

  const zone = await t.prisma.zone.create({
    data: { name: 'Z', polygon: [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }] },
  });
  const mk = (name: string) =>
    t.prisma.facility.create({
      data: { zoneId: zone.id, name, address: 'x', latitude: 1, longitude: 1 },
    });
  facilityId = (await mk('Sede A')).id;
  otherFacilityId = (await mk('Sede B')).id;
  await t.prisma.user.update({ where: { id: sup.id }, data: { facilityId } });
  supervisor = await login(t, 'sup@test.local');
});
after(() => t.close());

describe('agenda sin política activa', () => {
  it('se rechaza con 422 hasta que el administrador configure la política', async () => {
    await t.http.post(`${api}/slots`).set(bearer(admin)).send(slot()).expect(422);
  });
});

describe('franjas', () => {
  before(async () => {
    await t.http
      .post(`${api}/policy`)
      .set(bearer(admin))
      .send({
        timezone: 'America/Guayaquil',
        reason: 'Prueba',
        blockNewOrdersOnCharges: false,
        enforceDriverLimit: false,
        driverMayReorder: false,
        requireStorePickupSlot: false,
      })
      .expect(201);
  });

  it('valida formato, orden de horas, pasado y permisos', async () => {
    const post = (b: object, tok = admin) =>
      t.http.post(`${api}/slots`).set(bearer(tok)).send(b);
    await post(slot({ startTime: '9:00' })).expect(400);
    await post(slot({ startTime: '11:00', endTime: '09:00' })).expect(400);
    await post(slot({ date: '2000-01-01' })).expect(400);
    await post(slot({ capacity: 0 })).expect(400);
    await post(slot(), client).expect(403);
  });

  it('crea, rechaza duplicado y solapamiento; permite franjas contiguas', async () => {
    const post = (b: object) =>
      t.http.post(`${api}/slots`).set(bearer(admin)).send(b);
    const ok = await post(slot()).expect(201);
    assert.equal(ok.body.available, 3);
    await post(slot()).expect(409);
    await post(slot({ startTime: '10:00', endTime: '12:00' })).expect(409);
    await post(slot({ startTime: '11:00', endTime: '13:00' })).expect(201);
    // Otro contexto en el mismo horario es independiente.
    await post(slot({ context: 'DRIVER_DELIVERY' })).expect(201);
  });

  it('el supervisor solo gestiona su sede', async () => {
    const post = (b: object) =>
      t.http.post(`${api}/slots`).set(bearer(supervisor)).send(b);
    await post(slot({ facilityId: otherFacilityId })).expect(403);
    await post(slot({ startTime: '14:00', endTime: '15:00' })).expect(201);
  });

  it('el cliente y el visitante anónimo no ven capacidad interna y solo franjas con cupo', async () => {
    const resClient = await t.http
      .get(`${api}/slots?facilityId=${facilityId}&context=DRIVER_PICKUP`)
      .set(bearer(client))
      .expect(200);
    const resAnon = await t.http
      .get(`${api}/slots?facilityId=${facilityId}&context=DRIVER_PICKUP`)
      .expect(200);
    assert.ok(resClient.body.length >= 1);
    assert.deepEqual(resAnon.body, resClient.body);
    for (const s of resAnon.body) {
      assert.equal(s.capacity, undefined);
      assert.equal(s.reservedCount, undefined);
      assert.ok(s.available > 0);
    }
  });

  it('no permite bajar la capacidad por debajo de lo reservado', async () => {
    const created = await t.http
      .post(`${api}/slots`)
      .set(bearer(admin))
      .send(slot({ startTime: '16:00', endTime: '17:00', capacity: 5 }))
      .expect(201);
    await t.prisma.timeSlot.update({
      where: { id: created.body.id },
      data: { reservedCount: 4 },
    });
    await t.http
      .patch(`${api}/slots/${created.body.id}`)
      .set(bearer(admin))
      .send({ capacity: 3 })
      .expect(409);
    await t.http
      .patch(`${api}/slots/${created.body.id}`)
      .set(bearer(admin))
      .send({ capacity: 4 })
      .expect(200);
  });

  it('una franja inactiva deja de ofrecerse al cliente', async () => {
    const created = await t.http
      .post(`${api}/slots`)
      .set(bearer(admin))
      .send(slot({ startTime: '18:00', endTime: '19:00' }))
      .expect(201);
    await t.http
      .patch(`${api}/slots/${created.body.id}`)
      .set(bearer(admin))
      .send({ active: false })
      .expect(200);
    const res = await t.http
      .get(`${api}/slots?facilityId=${facilityId}&context=DRIVER_PICKUP`)
      .set(bearer(client));
    assert.equal(res.body.some((s: { id: string }) => s.id === created.body.id), false);
  });
});

describe('reserva atómica de cupos', () => {
  it('con 12 solicitudes concurrentes y capacidad 3, exactamente 3 tienen éxito', async () => {
    const created = await t.http
      .post(`${api}/slots`)
      .set(bearer(admin))
      .send(slot({ date: '2099-07-01', capacity: 3 }))
      .expect(201);
    const svc = t.app.get(SlotsService);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        t.prisma.$transaction((tx) => svc.reserveCapacity(tx, created.body.id)),
      ),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
    const row = await t.prisma.timeSlot.findUniqueOrThrow({ where: { id: created.body.id } });
    assert.equal(row.reservedCount, 3);

    await t.prisma.$transaction((tx) => svc.releaseCapacity(tx, created.body.id));
    assert.equal(
      (await t.prisma.timeSlot.findUniqueOrThrow({ where: { id: created.body.id } })).reservedCount,
      2,
    );
  });
});
