import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  ADMIN_PASSWORD,
  bearer,
  bootApp,
  createUser,
  login,
  type TestApp,
} from '../helpers';

let t: TestApp;
let admin: string;
let client: string;
const policyBase = {
  timezone: 'America/Bogota',
  reason: 'Prueba',
  blockNewOrdersOnCharges: false,
  enforceDriverLimit: false,
  driverMayReorder: false,
  requireStorePickupSlot: false,
};
const api = '/api/v1';

const square = [
  { lat: 0, lng: 0 },
  { lat: 0, lng: 10 },
  { lat: 10, lng: 10 },
  { lat: 10, lng: 0 },
];

before(async () => {
  t = await bootApp();
  await createUser(t, { email: 'admin@test.local', role: 'ADMIN' });
  await createUser(t, { email: 'client@test.local', role: 'CLIENT' });
  admin = await login(t, 'admin@test.local');
  client = await login(t, 'client@test.local');
});
after(() => t.close());

describe('autenticación y roles', () => {
  it('rechaza rutas protegidas sin token', async () => {
    await t.http.get(`${api}/orders`).expect(401);
  });
  it('un cliente no puede escribir en geografía ni promociones', async () => {
    await t.http
      .post(`${api}/zones`)
      .set(bearer(client))
      .send({ name: 'X', polygon: square })
      .expect(403);
    await t.http
      .post(`${api}/catalog/promotions`)
      .set(bearer(client))
      .send({ code: 'PROMO', discountType: 'PERCENTAGE', discountValue: 10 })
      .expect(403);
  });
  it('registro, login incorrecto y refresh con detección de reuso', async () => {
    await t.http
      .post(`${api}/auth/register`)
      .send({
        name: 'Nueva',
        email: 'nueva@test.local',
        phone: '+5712345678',
        password: 'Cliente2026ok',
      })
      .expect(201);
    await t.http
      .post(`${api}/auth/login`)
      .send({ email: 'nueva@test.local', password: 'mala' })
      .expect(401);
    const first = await t.http
      .post(`${api}/auth/login`)
      .send({ email: 'nueva@test.local', password: 'Cliente2026ok' });
    const rotated = await t.http
      .post(`${api}/auth/refresh`)
      .send({ refreshToken: first.body.tokens.refreshToken })
      .expect(200);
    // Reusar el token anterior invalida toda la familia.
    await t.http
      .post(`${api}/auth/refresh`)
      .send({ refreshToken: first.body.tokens.refreshToken })
      .expect(401);
    await t.http
      .post(`${api}/auth/refresh`)
      .send({ refreshToken: rotated.body.refreshToken })
      .expect(401);
  });
  it('rechaza campos no declarados', async () => {
    await t.http
      .post(`${api}/auth/login`)
      .send({
        email: 'admin@test.local',
        password: ADMIN_PASSWORD,
        role: 'ADMIN',
      })
      .expect(400);
  });
});

describe('política de negocio', () => {
  it('publicar incrementa la versión y deja una sola activa', async () => {
    const a = await t.http
      .post(`${api}/policy`)
      .set(bearer(admin))
      .send({ ...policyBase, cutoffMinutes: 60 });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const b = await t.http
      .post(`${api}/policy`)
      .set(bearer(admin))
      .send({ ...policyBase, cutoffMinutes: 90 });
    assert.equal(b.body.version, a.body.version + 1);
    assert.equal(await t.prisma.businessPolicy.count({ where: { active: true } }), 1);
  });
});

describe('zonas y sedes', () => {
  let zoneId: string;
  it('valida polígono y nombre único', async () => {
    await t.http
      .post(`${api}/zones`)
      .set(bearer(admin))
      .send({ name: 'Z', polygon: [{ lat: 1, lng: 1 }] })
      .expect(400);
    const ok = await t.http
      .post(`${api}/zones`)
      .set(bearer(admin))
      .send({ name: 'Norte', polygon: square })
      .expect(201);
    zoneId = ok.body.id;
    await t.http
      .post(`${api}/zones`)
      .set(bearer(admin))
      .send({ name: 'Norte', polygon: square })
      .expect(409);
  });
  it('crea sede, rechaza zona inexistente y bloquea desactivar zona con sedes', async () => {
    await t.http
      .post(`${api}/facilities`)
      .set(bearer(admin))
      .send({ zoneId, name: 'Sede 1', address: 'Calle 1', latitude: 5, longitude: 5 })
      .expect(201);
    await t.http
      .post(`${api}/facilities`)
      .set(bearer(admin))
      .send({
        zoneId: '00000000-0000-4000-8000-000000000000',
        name: 'S',
        address: 'A',
        latitude: 5,
        longitude: 5,
      })
      .expect(404);
    await t.http
      .patch(`${api}/zones/${zoneId}`)
      .set(bearer(admin))
      .send({ active: false })
      .expect(409);
  });
  it('los cambios quedan auditados', async () => {
    assert.ok((await t.prisma.auditLog.count({ where: { entity: 'Zone' } })) >= 1);
    assert.ok((await t.prisma.auditLog.count({ where: { entity: 'Facility' } })) >= 1);
  });
});

describe('catálogo y promociones', () => {
  it('valida precios y duplicados; el cliente solo ve activos', async () => {
    await t.http
      .post(`${api}/catalog/garments`)
      .set(bearer(admin))
      .send({ name: 'Camisa', basePrice: -1 })
      .expect(400);
    const g = await t.http
      .post(`${api}/catalog/garments`)
      .set(bearer(admin))
      .send({ name: 'Camisa', basePrice: 3.5 })
      .expect(201);
    await t.http
      .post(`${api}/catalog/garments`)
      .set(bearer(admin))
      .send({ name: 'Camisa', basePrice: 4 })
      .expect(409);
    const visible = () =>
      t.http.get(`${api}/catalog/garments`).set(bearer(client));
    assert.equal((await visible()).body.length, 1);
    await t.http
      .patch(`${api}/catalog/garments/${g.body.id}`)
      .set(bearer(admin))
      .send({ active: false })
      .expect(200);
    assert.equal((await visible()).body.length, 0);
    const all = await t.http.get(`${api}/catalog/garments`).set(bearer(admin));
    assert.equal(all.body.length, 1);
  });
  it('valida promociones', async () => {
    const base = { code: 'PROMO1', discountType: 'PERCENTAGE', discountValue: 10 };
    const post = (body: object) =>
      t.http.post(`${api}/catalog/promotions`).set(bearer(admin)).send(body);
    await post({ ...base, discountValue: 150 }).expect(400);
    await post({ ...base, validFrom: '2027-01-02', validUntil: '2027-01-01' }).expect(400);
    await post(base).expect(201);
    await post(base).expect(409);
  });
  it('permite consultar catálogo y geografía sin token (público) y con tokens CLIENT y ADMIN', async () => {
    await t.http
      .post(`${api}/catalog/services`)
      .set(bearer(admin))
      .send({ name: 'Lavado y Planchado por Prenda', extraPrice: 2.5 })
      .expect(201);
    await t.http
      .post(`${api}/catalog/extras`)
      .set(bearer(admin))
      .send({ name: 'Desmanchado Profundo', price: 1.5 })
      .expect(201);
    await t.http
      .post(`${api}/catalog/memberships`)
      .set(bearer(admin))
      .send({
        name: 'Estándar',
        priceMonthly: 9.99,
        weeklyPickups: 2,
        garmentDiscountPercent: 10,
        benefits: ['Tier 2', '10% descuento'],
      })
      .expect(201);
    await t.http
      .post(`${api}/catalog/rewards`)
      .set(bearer(admin))
      .send({
        title: 'Bolsa Ecológica de Lavandería',
        description: 'Bolsa reutilizable de alta resistencia para tus entregas',
        category: 'Productos',
        pointsCost: 150,
      })
      .expect(201);

    const endpoints = [
      `${api}/catalog/garments`,
      `${api}/catalog/services`,
      `${api}/catalog/extras`,
      `${api}/catalog/memberships`,
      `${api}/catalog/rewards`,
      `${api}/catalog/promotions`,
      `${api}/zones`,
      `${api}/facilities`,
    ];

    // Acceso anónimo (sin Authorization)
    for (const endpoint of endpoints) {
      const res = await t.http.get(endpoint).expect(200);
      assert.ok(Array.isArray(res.body));
    }

    // Acceso autenticado (CLIENT y ADMIN)
    for (const token of [client, admin]) {
      for (const endpoint of endpoints) {
        const res = await t.http.get(endpoint).set(bearer(token)).expect(200);
        assert.ok(Array.isArray(res.body));
      }
    }
  });
});
