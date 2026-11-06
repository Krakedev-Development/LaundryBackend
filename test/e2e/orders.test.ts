import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  bearer,
  bootApp,
  createUser,
  login,
  type TestApp,
} from '../helpers';

const api = '/api/v1';
const DAY = '2099-06-15';
const square = [
  { lat: 0, lng: 0 },
  { lat: 0, lng: 10 },
  { lat: 10, lng: 10 },
  { lat: 10, lng: 0 },
];
const FULL_POLICY = {
  timezone: 'America/Bogota',
  reason: 'Prueba',
  taxRate: 0.1,
  taxIncluded: false,
  pickupFee: 2,
  deliveryFee: 3,
  pricePerPound: 1.5,
  cutoffMinutes: 120,
  lateCancellationFee: 5,
  blockNewOrdersOnCharges: true,
  enforceDriverLimit: true,
  driverLimit: 1,
  driverMayReorder: false,
  requireStorePickupSlot: false,
};

let t: TestApp;
let admin: string;
let facilityId: string;
let garmentId: string;
let serviceId: string;
let extraId: string;
let driverId: string;
let driverToken: string;
let otherDriverToken: string;
let slotCounter = 0;

const as = (token: string) => bearer(token);
const publish = (over: Record<string, unknown> = {}) =>
  t.http.post(`${api}/policy`).set(as(admin)).send({ ...FULL_POLICY, ...over });

// Cada franja usa un horario propio de 10 minutos para no solaparse.
async function slot(context: string, capacity = 5): Promise<string> {
  const n = slotCounter++;
  const hh = String(Math.floor(n / 6)).padStart(2, '0');
  const start = `${hh}:${String((n % 6) * 10).padStart(2, '0')}`;
  const endMin = (n % 6) * 10 + 9;
  const end = `${hh}:${String(endMin).padStart(2, '0')}`;
  const res = await t.http
    .post(`${api}/slots`)
    .set(as(admin))
    .send({ facilityId, context, date: DAY, startTime: start, endTime: end, capacity })
    .expect(201);
  return res.body.id;
}

async function newClient(email: string) {
  const reg = await t.http
    .post(`${api}/auth/register`)
    .send({ name: email, email, phone: '+5712345678', password: 'Cliente2026ok' })
    .expect(201);
  const token = reg.body.tokens.accessToken as string;
  const addr = await t.http
    .post(`${api}/customers/me/addresses`)
    .set(as(token))
    .send({ title: 'Casa', fullAddress: 'Calle 1 #2-3', latitude: 5, longitude: 5 })
    .expect(201);
  const far = await t.http
    .post(`${api}/customers/me/addresses`)
    .set(as(token))
    .send({ title: 'Lejos', fullAddress: 'Otra ciudad', latitude: 20, longitude: 20 })
    .expect(201);
  return { token, addressId: addr.body.id as string, farAddressId: far.body.id as string };
}

const body = async (
  c: { addressId: string },
  over: Record<string, unknown> = {},
) => ({
  facilityId,
  mode: 'HOME_HOME',
  pickupAddressId: c.addressId,
  pickupSlotId: await slot('DRIVER_PICKUP'),
  items: [{ garmentId, serviceId, quantity: 2 }],
  ...over,
});

const createOrder = (token: string, b: object, key?: string) => {
  const req = t.http.post(`${api}/orders`).set(as(token));
  if (key) req.set('Idempotency-Key', key);
  return req.send(b);
};

before(async () => {
  t = await bootApp();
  await createUser(t, { email: 'admin@test.local', role: 'ADMIN' });
  admin = await login(t, 'admin@test.local');
  await publish().expect(201);

  const zone = await t.http
    .post(`${api}/zones`)
    .set(as(admin))
    .send({ name: 'Zona', polygon: square })
    .expect(201);
  const fac = await t.http
    .post(`${api}/facilities`)
    .set(as(admin))
    .send({ zoneId: zone.body.id, name: 'Sede', address: 'Av 1', latitude: 5, longitude: 5 })
    .expect(201);
  facilityId = fac.body.id;

  const mk = async (path: string, b: object) =>
    (await t.http.post(`${api}/catalog/${path}`).set(as(admin)).send(b).expect(201)).body.id as string;
  garmentId = await mk('garments', { name: 'Camisa', basePrice: 3.5 });
  serviceId = await mk('services', { name: 'Lavado', extraPrice: 1 });
  extraId = await mk('extras', { name: 'Perfume', price: 2 });
  await mk('promotions', { code: 'DIEZ', discountType: 'PERCENTAGE', discountValue: 10 });

  const d1 = await createUser(t, { email: 'driver1@test.local', role: 'DRIVER' });
  const d2 = await createUser(t, { email: 'driver2@test.local', role: 'DRIVER' });
  driverId = (await t.prisma.driver.create({ data: { userId: d1.id, facilityId } })).id;
  await t.prisma.driver.create({ data: { userId: d2.id, facilityId } });
  driverToken = await login(t, 'driver1@test.local');
  otherDriverToken = await login(t, 'driver2@test.local');
});
after(() => t.close());

describe('creación de pedidos', () => {
  let c: Awaited<ReturnType<typeof newClient>>;
  before(async () => {
    c = await newClient('c1@test.local');
  });

  it('con política incompleta se rechaza indicando qué falta', async () => {
    await publish({ taxRate: undefined, taxIncluded: undefined }).expect(201);
    const res = await createOrder(c.token, await body(c)).expect(422);
    assert.match(res.body.message, /tasa de IVA/);
    await publish().expect(201);
  });

  it('calcula el precio en el servidor y congela la versión de política', async () => {
    const res = await createOrder(c.token, await body(c, { extraIds: [extraId] })).expect(201);
    // prendas 2 x (3.5+1) = 9; extras 2; logística 2+3; base 16; IVA 1.6
    assert.equal(res.body.itemsSubtotal, '9');
    assert.equal(res.body.tax, '1.6');
    assert.equal(res.body.total, '17.6');
    assert.equal(res.body.status, 'PAYMENT_PENDING');
    assert.equal(res.body.paymentStatus, 'PENDING');
    assert.equal(res.body.version, 1);
    const policy = await t.prisma.businessPolicy.findFirstOrThrow({ where: { active: true } });
    assert.equal(res.body.policyVersion, policy.version);
    assert.equal(res.body.legs.length, 2);
    assert.equal(res.body.events.length, 1);
  });

  it('aplica la promoción y rechaza códigos inexistentes', async () => {
    const ok = await createOrder(c.token, await body(c, { promotionCode: 'diez' })).expect(201);
    // 9 - 10% = 8.1; +5 = 13.1; IVA 1.31; total 14.41
    assert.equal(ok.body.discount, '0.9');
    assert.equal(ok.body.total, '14.41');
    await createOrder(c.token, await body(c, { promotionCode: 'NOEXISTE' })).expect(404);
  });

  it('por peso usa el precio por libra de la política', async () => {
    const res = await createOrder(
      c.token,
      await body(c, { items: undefined, estimatedWeightLb: 10 }),
    ).expect(201);
    assert.equal(res.body.pricingModel, 'PER_WEIGHT');
    assert.equal(res.body.pricingStatus, 'PENDING_WEIGHT');
    assert.equal(res.body.itemsSubtotal, '15');
  });

  it('exige exactamente items o peso', async () => {
    await createOrder(c.token, await body(c, { estimatedWeightLb: 3 })).expect(400);
    await createOrder(c.token, await body(c, { items: undefined })).expect(400);
  });

  it('rechaza el precio enviado por el cliente y datos fuera de cobertura', async () => {
    await createOrder(c.token, await body(c, { total: 1 })).expect(400);
    await createOrder(c.token, await body(c, { pickupAddressId: c.farAddressId })).expect(422);
  });

  it('la idempotencia evita pedidos duplicados', async () => {
    const b = await body(c);
    const before = await t.prisma.order.count();
    const first = await createOrder(c.token, b, 'clave-1').expect(201);
    const again = await createOrder(c.token, b, 'clave-1').expect(201);
    assert.equal(first.body.id, again.body.id);
    assert.equal((await t.prisma.order.count()) - before, 1);
    // Concurrentes con otra clave: un solo pedido y misma respuesta.
    const b2 = await body(c);
    const [r1, r2] = await Promise.all([
      createOrder(c.token, b2, 'clave-2'),
      createOrder(c.token, b2, 'clave-2'),
    ]);
    assert.equal(r1.body.id, r2.body.id);
  });

  it('la capacidad de la franja se respeta', async () => {
    const full = await slot('DRIVER_PICKUP', 1);
    await createOrder(c.token, await body(c, { pickupSlotId: full })).expect(201);
    await createOrder(c.token, await body(c, { pickupSlotId: full })).expect(409);
  });

  it('retiro en sede: sin tarifa de entrega y con tramo del cliente', async () => {
    const res = await createOrder(c.token, await body(c, { mode: 'HOME_STORE' })).expect(201);
    // 9 + 2 logística = 11; IVA 1.1; total 12.1
    assert.equal(res.body.total, '12.1');
    const out = res.body.legs.find((l: { kind: string }) => l.kind === 'OUTBOUND');
    assert.equal(out.method, 'CUSTOMER');
    assert.equal(out.status, 'PENDING');
  });

  it('la franja de otro tipo o sede se rechaza', async () => {
    const wrong = await slot('DRIVER_DELIVERY');
    await createOrder(c.token, await body(c, { pickupSlotId: wrong })).expect(400);
  });
});

describe('programar entrega', () => {
  it('el cliente programa la entrega pendiente una sola vez', async () => {
    const c = await newClient('c2@test.local');
    const o = await createOrder(c.token, await body(c)).expect(201);
    const deliverySlot = await slot('DRIVER_DELIVERY', 1);
    const res = await t.http
      .put(`${api}/orders/${o.body.id}/outbound`)
      .set(as(c.token))
      .send({ expectedVersion: 1, slotId: deliverySlot })
      .expect(200);
    assert.equal(res.body.version, 2);
    const out = res.body.legs.find((l: { kind: string }) => l.kind === 'OUTBOUND');
    assert.equal(out.status, 'SCHEDULED');
    await t.http
      .put(`${api}/orders/${o.body.id}/outbound`)
      .set(as(c.token))
      .send({ expectedVersion: 2, slotId: deliverySlot })
      .expect(409);
    // Tipo de franja equivocado.
    const o2 = await createOrder(c.token, await body(c)).expect(201);
    await t.http
      .put(`${api}/orders/${o2.body.id}/outbound`)
      .set(as(c.token))
      .send({ expectedVersion: 1, slotId: await slot('FACILITY_PICKUP') })
      .expect(400);
  });
});

describe('flujo operativo y máquina de estados', () => {
  let c: Awaited<ReturnType<typeof newClient>>;
  let orderId: string;
  before(async () => {
    c = await newClient('c3@test.local');
    orderId = (await createOrder(c.token, await body(c)).expect(201)).body.id;
  });

  it('otro cliente no ve el pedido; cada cliente lista solo los suyos', async () => {
    const other = await newClient('c4@test.local');
    await t.http.get(`${api}/orders/${orderId}`).set(as(other.token)).expect(404);
    const mine = await t.http.get(`${api}/orders`).set(as(c.token)).expect(200);
    assert.equal(mine.body.total, 1);
    const all = await t.http.get(`${api}/orders`).set(as(admin)).expect(200);
    assert.ok(all.body.total > 1);
  });

  it('el pago es requisito para confirmar: no se fuerza por la API genérica', async () => {
    const res = await t.http
      .post(`${api}/orders/${orderId}/transitions`)
      .set(as(admin))
      .send({ expectedVersion: 1, to: 'CONFIRMED' })
      .expect(409);
    assert.match(res.body.message, /pago/);
    // Fixture: el módulo de pagos (fase siguiente) hará esta transición.
    await t.prisma.order.update({
      where: { id: orderId },
      data: { status: 'CONFIRMED', paymentStatus: 'PAID', version: 2 },
    });
  });

  it('la asignación valida versión, rol y límite de servicios del chofer', async () => {
    const post = (token: string, b: object, id = orderId) =>
      t.http.post(`${api}/orders/${id}/assign`).set(as(token)).send(b);
    await post(c.token, { expectedVersion: 2, leg: 'INBOUND', driverId }).expect(403);
    await post(admin, { expectedVersion: 1, leg: 'INBOUND', driverId }).expect(409);
    await post(admin, { expectedVersion: 2, leg: 'INBOUND', driverId }).expect(201);

    // Con límite 1, un segundo pedido para el mismo chofer se rechaza.
    const o2 = (await createOrder(c.token, await body(c)).expect(201)).body.id;
    await t.prisma.order.update({ where: { id: o2 }, data: { status: 'CONFIRMED', version: 2 } });
    await post(admin, { expectedVersion: 2, leg: 'INBOUND', driverId }, o2).expect(409);
  });

  it('solo el chofer asignado avanza el pedido y la custodia no se salta', async () => {
    const go = (token: string, to: string, v: number) =>
      t.http.post(`${api}/orders/${orderId}/transitions`).set(as(token)).send({ expectedVersion: v, to });
    const current = async () =>
      (await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).version;

    await go(otherDriverToken, 'HEADING_TO_PICKUP', await current()).expect(404);
    await go(c.token, 'HEADING_TO_PICKUP', await current()).expect(403);
    await go(driverToken, 'HEADING_TO_PICKUP', 1).expect(409); // versión obsoleta
    await go(driverToken, 'ARRIVED_FOR_PICKUP', await current()).expect(409); // salta etapa
    const a = await go(driverToken, 'HEADING_TO_PICKUP', await current()).expect(201);
    assert.equal(a.body.status, 'HEADING_TO_PICKUP');
    const leg = a.body.legs.find((l: { kind: string }) => l.kind === 'INBOUND');
    assert.equal(leg.status, 'IN_PROGRESS');
    const b = await go(driverToken, 'ARRIVED_FOR_PICKUP', await current()).expect(201);
    assert.equal(b.body.legs.find((l: { kind: string }) => l.kind === 'INBOUND').status, 'AWAITING_HANDOFF');
    // Recoger exige verificación de custodia (módulo siguiente).
    const res = await go(driverToken, 'PICKED_UP', await current()).expect(409);
    assert.match(res.body.message, /custodia/);
    assert.ok(b.body.events.length >= 4);
  });
});

describe('cancelación y cargos', () => {
  it('antes del corte cancela sin cargo y libera el cupo', async () => {
    const c = await newClient('c5@test.local');
    const pickup = await slot('DRIVER_PICKUP', 1);
    const o = await createOrder(c.token, await body(c, { pickupSlotId: pickup })).expect(201);
    assert.equal(
      (await t.prisma.timeSlot.findUniqueOrThrow({ where: { id: pickup } })).reservedCount,
      1,
    );
    const res = await t.http
      .post(`${api}/orders/${o.body.id}/cancel`)
      .set(as(c.token))
      .send({ expectedVersion: 1, reason: 'Cambié de planes' })
      .expect(201);
    assert.equal(res.body.status, 'CANCELLED');
    assert.equal(await t.prisma.customerCharge.count(), 0);
    assert.equal(
      (await t.prisma.timeSlot.findUniqueOrThrow({ where: { id: pickup } })).reservedCount,
      0,
    );
    // El cupo vuelve a estar disponible.
    await createOrder(c.token, await body(c, { pickupSlotId: pickup })).expect(201);
    // Un pedido cancelado no se cancela de nuevo.
    await t.http
      .post(`${api}/orders/${o.body.id}/cancel`)
      .set(as(c.token))
      .send({ expectedVersion: 2, reason: 'otra vez' })
      .expect(409);
  });

  it('pasado el corte genera cargo y, según la política, bloquea nuevos pedidos', async () => {
    const c = await newClient('c6@test.local');
    const o = await createOrder(c.token, await body(c)).expect(201);
    // Corte enorme: la franja de 2099 queda dentro del corte.
    await publish({ cutoffMinutes: 60_000_000 }).expect(201);
    const res = await t.http
      .post(`${api}/orders/${o.body.id}/cancel`)
      .set(as(c.token))
      .send({ expectedVersion: 1, reason: 'Tarde' })
      .expect(201);
    assert.equal(res.body.status, 'CANCELLED');
    const charge = await t.prisma.customerCharge.findFirstOrThrow({ where: { orderId: o.body.id } });
    assert.equal(charge.type, 'LATE_CANCELLATION');
    assert.equal(charge.amount.toString(), '5');
    assert.equal(charge.status, 'PENDING');

    await createOrder(c.token, await body(c)).expect(409);
    // Si el administrador desactiva el bloqueo, el cliente puede volver a pedir.
    await publish({ blockNewOrdersOnCharges: false }).expect(201);
    await createOrder(c.token, await body(c)).expect(201);
  });

  it('el personal cancela sin cargo aun pasado el corte', async () => {
    const c = await newClient('c7@test.local');
    const o = await createOrder(c.token, await body(c)).expect(201);
    await publish({ cutoffMinutes: 60_000_000 }).expect(201);
    await t.http
      .post(`${api}/orders/${o.body.id}/cancel`)
      .set(as(admin))
      .send({ expectedVersion: 1, reason: 'Operación' })
      .expect(201);
    assert.equal(await t.prisma.customerCharge.count({ where: { orderId: o.body.id } }), 0);
  });

  it('un chofer no cancela pedidos', async () => {
    const c = await newClient('c8@test.local');
    const o = await createOrder(c.token, await body(c)).expect(201);
    await t.http
      .post(`${api}/orders/${o.body.id}/cancel`)
      .set(as(driverToken))
      .send({ expectedVersion: 1, reason: 'x' })
      .expect(403);
  });
});
