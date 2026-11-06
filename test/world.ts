import { bearer, createUser, login, type TestApp } from './helpers';

export const api = '/api/v1';
const DAY = '2099-06-15';
const square = [
  { lat: 0, lng: 0 },
  { lat: 0, lng: 10 },
  { lat: 10, lng: 10 },
  { lat: 10, lng: 0 },
];

export const FULL_POLICY = {
  timezone: 'America/Bogota',
  reason: 'Prueba',
  taxRate: 0.1,
  taxIncluded: false,
  pickupFee: 2,
  deliveryFee: 3,
  pricePerPound: 1.5,
  cutoffMinutes: 120,
  lateCancellationFee: 5,
  handoffTtlMinutes: 30,
  handoffMaxAttempts: 3,
  blockNewOrdersOnCharges: true,
  enforceDriverLimit: false,
  driverMayReorder: false,
  requireStorePickupSlot: false,
};

export interface World {
  t: TestApp;
  admin: string;
  supervisor: string;
  driverToken: string;
  driverId: string;
  facilityId: string;
  garmentId: string;
  serviceId: string;
  slot(context: string, capacity?: number): Promise<string>;
  newClient(email: string): Promise<Client>;
  order(c: Client, over?: Record<string, unknown>): Promise<string>;
  version(orderId: string): Promise<number>;
  credit(customerId: string, amount: number): Promise<void>;
}

export interface Client {
  token: string;
  addressId: string;
  customerId: string;
}

// Escenario base sin datos preexistentes: todo se crea por la API como lo haría un operador.
export async function buildWorld(t: TestApp): Promise<World> {
  await createUser(t, { email: 'admin@test.local', role: 'ADMIN' });
  const admin = await login(t, 'admin@test.local');
  const as = bearer(admin);
  await t.http.post(`${api}/policy`).set(as).send(FULL_POLICY).expect(201);

  const zone = await t.http.post(`${api}/zones`).set(as).send({ name: 'Zona', polygon: square }).expect(201);
  const fac = await t.http
    .post(`${api}/facilities`)
    .set(as)
    .send({ zoneId: zone.body.id, name: 'Sede', address: 'Av 1', latitude: 5, longitude: 5 })
    .expect(201);
  const facilityId = fac.body.id as string;

  const mk = async (path: string, b: object) =>
    (await t.http.post(`${api}/catalog/${path}`).set(as).send(b).expect(201)).body.id as string;
  const garmentId = await mk('garments', { name: 'Camisa', basePrice: 3.5 });
  const serviceId = await mk('services', { name: 'Lavado', extraPrice: 1 });

  const sup = await createUser(t, { email: 'sup@test.local', role: 'SUPERVISOR' });
  await t.prisma.user.update({ where: { id: sup.id }, data: { facilityId } });
  const drv = await createUser(t, { email: 'driver@test.local', role: 'DRIVER' });
  const driverId = (await t.prisma.driver.create({ data: { userId: drv.id, facilityId } })).id;

  let n = 0;
  const slot = async (context: string, capacity = 5) => {
    const i = n++;
    const hh = String(Math.floor(i / 6)).padStart(2, '0');
    const startM = (i % 6) * 10;
    const res = await t.http
      .post(`${api}/slots`)
      .set(as)
      .send({
        facilityId, context, date: DAY, capacity,
        startTime: `${hh}:${String(startM).padStart(2, '0')}`,
        endTime: `${hh}:${String(startM + 9).padStart(2, '0')}`,
      })
      .expect(201);
    return res.body.id as string;
  };

  const newClient = async (email: string): Promise<Client> => {
    const reg = await t.http
      .post(`${api}/auth/register`)
      .send({ name: email, email, phone: '+5712345678', password: 'Cliente2026ok' })
      .expect(201);
    const token = reg.body.tokens.accessToken as string;
    const addr = await t.http
      .post(`${api}/customers/me/addresses`)
      .set(bearer(token))
      .send({ title: 'Casa', fullAddress: 'Calle 1 #2-3', latitude: 5, longitude: 5 })
      .expect(201);
    const customer = await t.prisma.customer.findFirstOrThrow({ where: { userId: reg.body.user.id } });
    return { token, addressId: addr.body.id, customerId: customer.id };
  };

  const world: World = {
    t, admin, facilityId, garmentId, serviceId, driverId, slot, newClient,
    supervisor: await login(t, 'sup@test.local'),
    driverToken: await login(t, 'driver@test.local'),
    async order(c, over = {}) {
      const res = await t.http
        .post(`${api}/orders`)
        .set(bearer(c.token))
        .send({
          facilityId,
          mode: 'HOME_HOME',
          pickupAddressId: c.addressId,
          pickupSlotId: await slot('DRIVER_PICKUP'),
          items: [{ garmentId, serviceId, quantity: 2 }],
          ...over,
        })
        .expect(201);
      return res.body.id as string;
    },
    async version(orderId) {
      return (await t.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).version;
    },
    async credit(customerId, amount) {
      await t.http
        .post(`${api}/wallet/credits`)
        .set(as)
        .send({ customerId, amount, reference: 'TRANSFERENCIA-TEST' })
        .expect(201);
    },
  };
  return world;
}
