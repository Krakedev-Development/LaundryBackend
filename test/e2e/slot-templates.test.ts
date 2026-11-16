import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { nowIn } from '../../src/common/time';
import { SLOT_HORIZON_DAYS, SlotTemplatesService } from '../../src/slots/slot-templates.service';
import { bearer, bootApp, createUser, login, type TestApp } from '../helpers';

const api = '/api/v1';
const TZ = 'America/Guayaquil';
let t: TestApp;
let admin: string;
let client: string;
let supervisor: string;
let facilityId: string;
let otherFacilityId: string;

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const today = () => nowIn(TZ).date;
const tomorrow = () => addDays(today(), 1);
const weekdayOf = (day: string) => new Date(`${day}T00:00:00.000Z`).getUTCDay();

const template = (over: Record<string, unknown> = {}) => ({
  facilityId,
  context: 'DRIVER_PICKUP',
  weekday: weekdayOf(tomorrow()),
  startTime: '08:00',
  endTime: '12:00',
  capacity: 6,
  ...over,
});
const post = (body: object, token = admin) =>
  t.http.post(`${api}/slot-templates`).set(bearer(token)).send(body);
const slotsOf = (context: string) =>
  t.prisma.timeSlot.findMany({ where: { facilityId, context: context as never }, orderBy: { date: 'asc' } });

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
    t.prisma.facility.create({ data: { zoneId: zone.id, name, address: 'x', latitude: 1, longitude: 1 } });
  facilityId = (await mk('Sede A')).id;
  otherFacilityId = (await mk('Sede B')).id;
  await t.prisma.user.update({ where: { id: sup.id }, data: { facilityId } });
  supervisor = await login(t, 'sup@test.local');
});
after(() => t.close());

describe('plantilla semanal sin política', () => {
  it('no genera franjas hasta que exista una política activa', async () => {
    const r = await t.app.get(SlotTemplatesService).generate();
    assert.equal(r.created, 0);
    assert.match(r.skippedReason ?? '', /política/);
  });
});

describe('plantilla semanal', () => {
  before(async () => {
    await t.http
      .post(`${api}/policy`)
      .set(bearer(admin))
      .send({
        timezone: TZ,
        reason: 'Prueba',
        blockNewOrdersOnCharges: false,
        enforceDriverLimit: false,
        driverMayReorder: false,
        requireStorePickupSlot: false,
      })
      .expect(201);
  });

  it('valida día, horas, cupos y permisos', async () => {
    await post(template({ weekday: 7 })).expect(400);
    await post(template({ startTime: '8:00' })).expect(400);
    await post(template({ startTime: '12:00', endTime: '08:00' })).expect(400);
    await post(template({ capacity: 0 })).expect(400);
    await post(template(), client).expect(403);
    await post(template({ facilityId: otherFacilityId }), supervisor).expect(403);
    await t.http.get(`${api}/slot-templates`).set(bearer(client)).expect(403);
  });

  it(`crea la franja semanal y genera de inmediato las de los próximos ${SLOT_HORIZON_DAYS} días`, async () => {
    const res = await post(template()).expect(201);
    // El día de mañana aparece 4 veces en 28 días contados desde hoy.
    assert.equal(res.body.generated.created, 4);
    assert.equal(res.body.generated.until, addDays(today(), SLOT_HORIZON_DAYS - 1));
    const rows = await slotsOf('DRIVER_PICKUP');
    assert.deepEqual(
      rows.map((s) => s.date.toISOString().slice(0, 10)),
      [0, 7, 14, 21].map((n) => addDays(tomorrow(), n)),
    );
    assert.ok(rows.every((s) => s.capacity === 6 && s.startTime === '08:00' && s.active));

    // Generar otra vez no duplica nada.
    const again = await t.http
      .post(`${api}/slot-templates/generate`)
      .set(bearer(admin))
      .send({})
      .expect(201);
    assert.equal(again.body.created, 0);
    assert.equal(again.body.existing, 4);
    assert.equal((await slotsOf('DRIVER_PICKUP')).length, 4);
  });

  it('rechaza una franja semanal que se solapa con otra del mismo día y tramo', async () => {
    const res = await post(template({ startTime: '11:00', endTime: '13:00' })).expect(409);
    assert.match(res.body.message, /Se solapa con la franja semanal 08:00-12:00/);
    // En otro tramo el mismo horario es independiente.
    await post(template({ context: 'FACILITY_PICKUP', capacity: 3 })).expect(201);
  });

  it('respeta las franjas creadas a mano: no las duplica ni las pisa', async () => {
    const manual = await t.http
      .post(`${api}/slots`)
      .set(bearer(admin))
      .send({
        facilityId, context: 'DRIVER_DELIVERY', date: tomorrow(),
        startTime: '10:00', endTime: '11:00', capacity: 2,
      })
      .expect(201);
    const res = await post(template({ context: 'DRIVER_DELIVERY', startTime: '10:30', endTime: '12:00' })).expect(201);
    assert.equal(res.body.generated.created, 3);
    assert.equal(res.body.generated.conflicts, 1);
    const rows = await slotsOf('DRIVER_DELIVERY');
    const firstDay = rows.filter((s) => s.date.toISOString().slice(0, 10) === tomorrow());
    assert.deepEqual(firstDay.map((s) => s.id), [manual.body.id]);
  });

  it('cambiar o desactivar la plantilla no altera las franjas ya creadas', async () => {
    const [tpl] = (
      await t.http
        .get(`${api}/slot-templates?facilityId=${facilityId}&context=DRIVER_PICKUP`)
        .set(bearer(admin))
        .expect(200)
    ).body;
    const slot = (await slotsOf('DRIVER_PICKUP'))[0];
    await t.prisma.timeSlot.update({ where: { id: slot.id }, data: { reservedCount: 2 } });

    const updated = await t.http
      .patch(`${api}/slot-templates/${tpl.id}`)
      .set(bearer(admin))
      .send({ capacity: 9 })
      .expect(200);
    assert.equal(updated.body.capacity, 9);
    const off = await t.http
      .patch(`${api}/slot-templates/${tpl.id}`)
      .set(bearer(admin))
      .send({ active: false })
      .expect(200);
    assert.equal(off.body.generated, null);
    const after = await t.prisma.timeSlot.findUniqueOrThrow({ where: { id: slot.id } });
    assert.deepEqual([after.capacity, after.reservedCount, after.active], [6, 2, true]);
    assert.equal((await slotsOf('DRIVER_PICKUP')).length, 4);
  });

  it('el supervisor solo ve y genera la agenda de su sede', async () => {
    await t.prisma.slotTemplate.create({
      data: { facilityId: otherFacilityId, context: 'DRIVER_PICKUP', weekday: 1, startTime: '08:00', endTime: '09:00', capacity: 1 },
    });
    const mine = await t.http.get(`${api}/slot-templates`).set(bearer(supervisor)).expect(200);
    assert.ok(mine.body.length > 0);
    assert.ok(mine.body.every((x: { facilityId: string }) => x.facilityId === facilityId));
    await t.http
      .get(`${api}/slot-templates?facilityId=${otherFacilityId}`)
      .set(bearer(supervisor))
      .expect(403);
    await t.http
      .post(`${api}/slot-templates/generate`)
      .set(bearer(supervisor))
      .send({ facilityId: otherFacilityId })
      .expect(403);
    const own = await t.http
      .post(`${api}/slot-templates/generate`)
      .set(bearer(supervisor))
      .send({})
      .expect(201);
    assert.equal(
      await t.prisma.timeSlot.count({ where: { facilityId: otherFacilityId } }),
      0,
      'la sede de otro supervisor no se toca',
    );
    assert.equal(own.body.created, 0);
  });

  it('no crea franjas para una fecha que ya pasó ni para una sede inactiva', async () => {
    const svc = t.app.get(SlotTemplatesService);
    await t.prisma.facility.update({ where: { id: otherFacilityId }, data: { active: false } });
    const r = await svc.generate({ facilityId: otherFacilityId });
    assert.equal(r.created, 0);
    const all = await t.prisma.timeSlot.findMany({ where: { facilityId } });
    assert.ok(all.every((s) => s.date.toISOString().slice(0, 10) >= today()));
  });
});
