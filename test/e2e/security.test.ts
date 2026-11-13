import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bearer, bootApp, createUser, login, type TestApp } from '../helpers';
import { api, buildWorld, type Client, type World } from '../world';

type Role = 'CLIENT' | 'DRIVER' | 'SUPERVISOR' | 'ADMIN';
const ALL: Role[] = ['CLIENT', 'DRIVER', 'SUPERVISOR', 'ADMIN'];
const ID = '00000000-0000-4000-8000-000000000000';

// Matriz de permisos: [método, ruta, roles autorizados]. Los guards se ejecutan antes de la
// validación, así que un rol no autorizado recibe 403 y quien no tiene sesión recibe 401, sin
// importar el cuerpo. "ANY" = cualquier usuario autenticado.
const MATRIX: [string, string, Role[] | 'ANY'][] = [
  ['get', '/policy', 'ANY'],
  ['get', '/policy/history', ['ADMIN']],
  ['post', '/policy', ['ADMIN']],
  ['post', '/users/drivers', ['ADMIN']],
  ['post', '/users/staff', ['ADMIN']],
  ['get', '/users/staff', ['ADMIN']],
  ['patch', `/users/${ID}/status`, ['ADMIN']],
  ['post', `/users/${ID}/reset-password`, ['ADMIN']],
  ['get', `/users/${ID}/activity`, ['ADMIN']],
  ['post', '/zones', ['ADMIN']],
  ['patch', `/zones/${ID}`, ['ADMIN']],
  ['post', '/facilities', ['ADMIN']],
  ['patch', `/facilities/${ID}`, ['ADMIN']],
  ['post', '/catalog/garments', ['ADMIN']],
  ['post', '/catalog/services', ['ADMIN']],
  ['post', '/catalog/extras', ['ADMIN']],
  ['post', '/catalog/memberships', ['ADMIN']],
  ['post', '/catalog/rewards', ['ADMIN']],
  ['post', '/catalog/promotions', ['ADMIN']],
  ['patch', `/catalog/promotions/${ID}`, ['ADMIN']],
  ['post', '/catalog/weight-tiers', ['ADMIN']],
  ['patch', `/catalog/weight-tiers/${ID}`, ['ADMIN']],
  ['post', '/catalog/weight-restrictions', ['ADMIN']],
  ['patch', `/catalog/weight-restrictions/${ID}`, ['ADMIN']],
  ['post', '/slots', ['ADMIN', 'SUPERVISOR']],
  ['patch', `/slots/${ID}`, ['ADMIN', 'SUPERVISOR']],
  ['get', '/customers/me', ['CLIENT']],
  ['get', '/customers/me/addresses', ['CLIENT']],
  ['post', '/customers/me/addresses', ['CLIENT']],
  ['post', '/orders', ['CLIENT']],
  ['post', `/orders/${ID}/assign`, ['ADMIN', 'SUPERVISOR']],
  ['put', `/orders/${ID}/outbound`, ['CLIENT']],
  ['post', `/orders/${ID}/cancel`, ['CLIENT', 'ADMIN', 'SUPERVISOR']],
  ['post', `/orders/${ID}/pay`, ['CLIENT']],
  ['post', `/orders/${ID}/complete`, ['ADMIN', 'SUPERVISOR']],
  ['post', `/orders/${ID}/weight`, ['ADMIN', 'SUPERVISOR']],
  ['post', `/orders/${ID}/adjustments`, ['ADMIN', 'SUPERVISOR']],
  ['post', `/orders/${ID}/adjustments/${ID}/decision`, ['CLIENT']],
  ['post', `/orders/${ID}/pricing/resolve`, ['ADMIN', 'SUPERVISOR']],
  ['post', `/orders/${ID}/handoffs/issue`, ['CLIENT', 'DRIVER']],
  ['post', `/orders/${ID}/handoffs/verify`, ['DRIVER', 'ADMIN', 'SUPERVISOR']],
  ['post', `/handoffs/${ID}/revoke`, ['ADMIN', 'SUPERVISOR']],
  ['get', '/wallet', ['CLIENT']],
  ['get', '/wallet/charges', ['CLIENT']],
  ['post', `/wallet/charges/${ID}/pay`, ['CLIENT']],
  ['post', '/wallet/credits', ['ADMIN']],
  ['post', `/wallet/charges/${ID}/waive`, ['ADMIN']],
  ['get', '/kyc/me', ['CLIENT']],
  ['put', '/kyc/me/documents/SELFIE', ['CLIENT']],
  ['post', '/kyc/me/submit', ['CLIENT']],
  ['get', '/kyc', ['ADMIN']],
  ['get', `/kyc/${ID}`, ['ADMIN']],
  ['get', `/kyc/${ID}/documents/SELFIE`, ['ADMIN']],
  ['post', `/kyc/${ID}/review`, ['ADMIN']],
  ['get', '/points', ['CLIENT']],
  ['post', '/points/redeem', ['CLIENT']],
  ['get', '/redemptions', ['CLIENT', 'ADMIN', 'SUPERVISOR']],
  ['post', `/redemptions/${ID}/review`, ['ADMIN', 'SUPERVISOR']],
  ['post', `/incidents/${ID}/status`, ['ADMIN', 'SUPERVISOR']],
  ['get', '/notifications', ['CLIENT']],
  ['post', '/notifications/read-all', ['CLIENT']],
];

let t: TestApp;
let w: World;
const tokens = {} as Record<Role, string>;

before(async () => {
  t = await bootApp();
  w = await buildWorld(t);
  tokens.ADMIN = w.admin;
  tokens.SUPERVISOR = w.supervisor;
  tokens.DRIVER = w.driverToken;
  tokens.CLIENT = (await w.newClient('sec@test.local')).token;
});
after(() => t.close());

const call = (method: string, path: string, token?: string) => {
  const req = (t.http as any)[method](`${api}${path}`);
  return token ? req.set(bearer(token)).send({}) : req.send({});
};

describe('matriz de permisos por rol', () => {
  it('toda ruta protegida rechaza con 401 a quien no tiene sesión', async () => {
    for (const [method, path] of MATRIX) {
      const res = await call(method, path);
      assert.equal(res.status, 401, `${method.toUpperCase()} ${path}`);
    }
  });

  it('cada rol no autorizado recibe 403 en cada ruta', async () => {
    const failures: string[] = [];
    for (const [method, path, allowed] of MATRIX) {
      if (allowed === 'ANY') continue;
      for (const role of ALL.filter((r) => !allowed.includes(r))) {
        const res = await call(method, path, tokens[role]);
        if (res.status !== 403)
          failures.push(`${role} ${method.toUpperCase()} ${path} -> ${res.status}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  it('una cuenta con contraseña temporal no opera fuera de cambiar la clave', async () => {
    const pending = await t.prisma.user.create({
      data: {
        email: 'temp@test.local',
        name: 'Temp',
        role: 'SUPERVISOR',
        status: 'PASSWORD_CHANGE_REQUIRED',
        passwordHash: (await t.prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } })).passwordHash,
      },
    });
    const token = await login(t, pending.email);
    await t.http.get(`${api}/orders`).set(bearer(token)).expect(403);
    await t.http.get(`${api}/policy`).set(bearer(token)).expect(403);
    await t.http.get(`${api}/auth/me`).set(bearer(token)).expect(200);
  });

  it('una cuenta suspendida pierde el acceso de inmediato aunque conserve el token', async () => {
    const c = await w.newClient('suspend@test.local');
    await t.http.get(`${api}/wallet`).set(bearer(c.token)).expect(200);
    await t.prisma.customer
      .findUniqueOrThrow({ where: { id: c.customerId } })
      .then((cu) => t.prisma.user.update({ where: { id: cu.userId }, data: { status: 'SUSPENDED' } }));
    await t.http.get(`${api}/wallet`).set(bearer(c.token)).expect(401);
  });
});

describe('aislamiento entre usuarios', () => {
  let a: Client;
  let b: Client;
  let orderOfA: string;
  before(async () => {
    a = await w.newClient('iso-a@test.local');
    b = await w.newClient('iso-b@test.local');
    orderOfA = await w.order(a);
  });

  it('otro cliente no ve ni opera sobre el pedido ajeno', async () => {
    await t.http.get(`${api}/orders/${orderOfA}`).set(bearer(b.token)).expect(404);
    await t.http
      .post(`${api}/orders/${orderOfA}/cancel`)
      .set(bearer(b.token))
      .send({ expectedVersion: 1, reason: 'x' })
      .expect(404);
    await t.http
      .post(`${api}/orders/${orderOfA}/pay`)
      .set(bearer(b.token))
      .send({ expectedVersion: 1 })
      .expect(404);
    await t.http.get(`${api}/orders/${orderOfA}/messages`).set(bearer(b.token)).expect(404);
    await t.http.get(`${api}/orders/${orderOfA}/handoffs`).set(bearer(b.token)).expect(404);
    await t.http.get(`${api}/orders/${orderOfA}/adjustments`).set(bearer(b.token)).expect(404);
    const mine = await t.http.get(`${api}/orders`).set(bearer(b.token)).expect(200);
    assert.equal(mine.body.total, 0);
  });

  it('no se usa la dirección de otro cliente al crear un pedido', async () => {
    const addressOfA = (
      await t.http.get(`${api}/customers/me/addresses`).set(bearer(a.token))
    ).body[0].id;
    await t.http
      .post(`${api}/orders`)
      .set(bearer(b.token))
      .send({
        facilityId: w.facilityId,
        mode: 'HOME_HOME',
        pickupAddressId: addressOfA,
        pickupSlotId: await w.slot('DRIVER_PICKUP'),
        items: [{ garmentId: w.garmentId, serviceId: w.serviceId, quantity: 1 }],
      })
      .expect(404);
  });

  it('el chofer no asignado y el supervisor de otra sede no ven el pedido', async () => {
    await t.http.get(`${api}/orders/${orderOfA}`).set(bearer(w.driverToken)).expect(404);
    const zone = await t.prisma.zone.findFirstOrThrow();
    const other = await t.prisma.facility.create({
      data: { zoneId: zone.id, name: 'Otra', address: 'x', latitude: 1, longitude: 1 },
    });
    const sup2 = await createUser(t, { email: 'sup2@test.local', role: 'SUPERVISOR' });
    await t.prisma.user.update({ where: { id: sup2.id }, data: { facilityId: other.id } });
    const token = await login(t, 'sup2@test.local');
    await t.http.get(`${api}/orders/${orderOfA}`).set(bearer(token)).expect(404);
    const list = await t.http.get(`${api}/orders`).set(bearer(token)).expect(200);
    assert.equal(list.body.total, 0);
  });

  it('el cliente no puede pagar ni condonar un cargo ajeno', async () => {
    const charge = await t.prisma.customerCharge.create({
      data: { customerId: a.customerId, type: 'OTHER', amount: 1, reason: 'x' },
    });
    await t.http.post(`${api}/wallet/charges/${charge.id}/pay`).set(bearer(b.token)).expect(404);
    await t.http
      .post(`${api}/wallet/charges/${charge.id}/waive`)
      .set(bearer(b.token))
      .send({ reason: 'x' })
      .expect(403);
  });
});

describe('exposición de datos', () => {
  it('el cliente no ve datos administrativos de la sede ni parámetros internos de la política', async () => {
    const client = tokens.CLIENT;
    const facilities = (await t.http.get(`${api}/facilities`).set(bearer(client)).expect(200)).body;
    const sede = (
      await t.http.get(`${api}/facilities/${w.facilityId}`).set(bearer(client)).expect(200)
    ).body;
    for (const f of [...facilities, sede]) {
      for (const hidden of ['taxId', 'managerName', 'dailyCapacity', 'createdAt'])
        assert.equal(f[hidden], undefined, hidden);
      assert.ok(f.name && f.address);
    }
    const policy = (await t.http.get(`${api}/policy`).set(bearer(client)).expect(200)).body;
    for (const hidden of [
      'enforceDriverLimit',
      'driverLimit',
      'driverMayReorder',
      'handoffMaxAttempts',
      'handoffTtlMinutes',
      'blockNewOrdersOnCharges',
      'createdById',
      'reason',
    ])
      assert.equal(policy[hidden], undefined, hidden);
    assert.equal(policy.taxRate, '0.1');

    // El personal sí ve todo.
    const full = (await t.http.get(`${api}/policy`).set(bearer(w.supervisor)).expect(200)).body;
    assert.notEqual(full.handoffMaxAttempts, undefined);
  });

  it('las respuestas de autenticación nunca incluyen hashes ni secretos', async () => {
    const me = (await t.http.get(`${api}/auth/me`).set(bearer(tokens.CLIENT)).expect(200)).body;
    assert.equal(me.passwordHash, undefined);
    const res = await t.http
      .post(`${api}/auth/login`)
      .send({ email: 'sec@test.local', password: 'Cliente2026ok' })
      .expect(200);
    assert.equal(JSON.stringify(res.body).includes('passwordHash'), false);
  });
});

describe('entradas', () => {
  it('rechaza una clave de idempotencia fuera de formato o demasiado larga', async () => {
    const c = await w.newClient('idem@test.local');
    const body = async () => ({
      facilityId: w.facilityId,
      mode: 'HOME_HOME',
      pickupAddressId: c.addressId,
      pickupSlotId: await w.slot('DRIVER_PICKUP'),
      items: [{ garmentId: w.garmentId, serviceId: w.serviceId, quantity: 1 }],
    });
    for (const key of ['corta', 'x'.repeat(200), 'con espacios y símbolos <>']) {
      await t.http
        .post(`${api}/orders`)
        .set(bearer(c.token))
        .set('Idempotency-Key', key)
        .send(await body())
        .expect(400);
    }
    await t.http
      .post(`${api}/orders`)
      .set(bearer(c.token))
      .set('Idempotency-Key', 'clave-valida-1')
      .send(await body())
      .expect(201);
  });

  it('un token manipulado o con otro algoritmo se rechaza', async () => {
    const [h, p] = tokens.CLIENT.split('.');
    await t.http.get(`${api}/wallet`).set(bearer(`${h}.${p}.firma-falsa`)).expect(401);
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    await t.http.get(`${api}/wallet`).set(bearer(`${none}.${p}.`)).expect(401);
  });

  it('los textos libres se almacenan como datos, sin interpretarse', async () => {
    const c = await w.newClient('inj@test.local');
    const hostile = `'; DROP TABLE "User"; -- <script>alert(1)</script>`;
    const res = await t.http
      .post(`${api}/customers/me/addresses`)
      .set(bearer(c.token))
      .send({ title: 'x', fullAddress: hostile, latitude: 5, longitude: 5 })
      .expect(201);
    assert.equal(res.body.fullAddress, hostile);
    assert.ok((await t.prisma.user.count()) > 0);
  });
});
