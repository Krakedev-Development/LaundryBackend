import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bearer, bootApp, type TestApp } from '../helpers';
import { api, buildWorld, type World } from '../world';

let t: TestApp;
let w: World;

const TEMP = 'Temp2026ok';
const NEW = 'Definitiva2026ok';

const get = (token: string, path: string) => t.http.get(`${api}${path}`).set(bearer(token));
const post = (token: string, path: string, body: object = {}) =>
  t.http.post(`${api}${path}`).set(bearer(token)).send(body);
const patch = (token: string, path: string, body: object = {}) =>
  t.http.patch(`${api}${path}`).set(bearer(token)).send(body);
const loginAs = (email: string, password: string) =>
  t.http.post(`${api}/auth/login`).send({ email, password });

async function newSupervisor(email: string) {
  const res = await post(w.admin, '/users/staff', {
    name: 'Sara Ruiz',
    email,
    phone: '0991234567',
    temporaryPassword: TEMP,
    role: 'SUPERVISOR',
    facilityId: w.facilityId,
  }).expect(201);
  return res.body.id as string;
}

before(async () => {
  t = await bootApp();
  w = await buildWorld(t);
});
after(() => t.close());

describe('gestión de personal', () => {
  it('el supervisor creado entra con su contraseña temporal y debe cambiarla', async () => {
    await newSupervisor('sara@test.local');
    const first = await loginAs('sara@test.local', TEMP).expect(200);
    assert.equal(first.body.user.status, 'PASSWORD_CHANGE_REQUIRED');
    const token = first.body.tokens.accessToken as string;
    // Hasta cambiarla no puede operar.
    await get(token, '/orders').expect(403);
    await post(token, '/auth/change-password', { currentPassword: TEMP, newPassword: NEW }).expect(200);
    const second = await loginAs('sara@test.local', NEW).expect(200);
    assert.equal(second.body.user.status, 'ACTIVE');
    assert.equal(second.body.user.facilityId, w.facilityId);
  });

  it('lista solo supervisores y administradores, con su sede y último ingreso', async () => {
    const res = await get(w.admin, '/users/staff').expect(200);
    const roles = new Set(res.body.map((u: { role: string }) => u.role));
    assert.deepEqual([...roles].sort(), ['ADMIN', 'SUPERVISOR']);
    const sara = res.body.find((u: { email: string }) => u.email === 'sara@test.local');
    assert.equal(sara.facility.id, w.facilityId);
    assert.equal(sara.status, 'ACTIVE');
    assert.ok(sara.lastLoginAt, 'el ingreso queda registrado');
    assert.equal('passwordHash' in sara, false);
  });

  it('suspender cierra sus sesiones y reactivar devuelve el acceso', async () => {
    const id = await newSupervisor('leo@test.local');
    await post(
      (await loginAs('leo@test.local', TEMP).expect(200)).body.tokens.accessToken,
      '/auth/change-password',
      { currentPassword: TEMP, newPassword: NEW },
    ).expect(200);
    const session = await loginAs('leo@test.local', NEW).expect(200);
    const token = session.body.tokens.accessToken as string;
    await get(token, '/orders').expect(200);

    await patch(w.admin, `/users/${id}/status`, { status: 'SUSPENDED', reason: 'Fin de contrato' }).expect(200);
    await get(token, '/orders').expect(401);
    await t.http.post(`${api}/auth/refresh`).send({ refreshToken: session.body.tokens.refreshToken }).expect(401);
    await loginAs('leo@test.local', NEW).expect(401);
    await patch(w.admin, `/users/${id}/status`, { status: 'SUSPENDED' }).expect(409);

    const back = await patch(w.admin, `/users/${id}/status`, { status: 'ACTIVE' }).expect(200);
    assert.equal(back.body.status, 'ACTIVE');
    await loginAs('leo@test.local', NEW).expect(200);
  });

  it('reactivar no salta el cambio de una contraseña temporal pendiente', async () => {
    const id = await newSupervisor('ines@test.local');
    await patch(w.admin, `/users/${id}/status`, { status: 'SUSPENDED' }).expect(200);
    const back = await patch(w.admin, `/users/${id}/status`, { status: 'ACTIVE' }).expect(200);
    assert.equal(back.body.status, 'PASSWORD_CHANGE_REQUIRED');
  });

  it('restablecer la contraseña obliga a cambiarla y cierra las sesiones', async () => {
    const id = await newSupervisor('ana@test.local');
    const old = await loginAs('ana@test.local', TEMP).expect(200);
    const res = await post(w.admin, `/users/${id}/reset-password`, { temporaryPassword: 'Otra2026tmp' }).expect(201);
    assert.equal(res.body.status, 'PASSWORD_CHANGE_REQUIRED');
    await t.http.post(`${api}/auth/refresh`).send({ refreshToken: old.body.tokens.refreshToken }).expect(401);
    await loginAs('ana@test.local', TEMP).expect(401);
    await loginAs('ana@test.local', 'Otra2026tmp').expect(200);
    await post(w.admin, `/users/${id}/reset-password`, { temporaryPassword: 'corta' }).expect(400);
  });

  it('no permite modificar la propia cuenta, ni clientes, ni cuentas inexistentes', async () => {
    const me = await get(w.admin, '/auth/me').expect(200);
    await patch(w.admin, `/users/${me.body.id}/status`, { status: 'SUSPENDED' }).expect(400);
    const client = await w.newClient('cli@test.local');
    const clientUser = await t.prisma.user.findUniqueOrThrow({ where: { email: 'cli@test.local' } });
    await patch(w.admin, `/users/${clientUser.id}/status`, { status: 'SUSPENDED' }).expect(404);
    await patch(w.admin, '/users/00000000-0000-4000-8000-000000000000/status', { status: 'SUSPENDED' }).expect(404);
    await patch(w.admin, `/users/${clientUser.id}/status`, { status: 'BORRADO' }).expect(400);
    assert.ok(client.token);
  });

  it('valida teléfono de 10 dígitos, contraseña de 8 a 12, correo y longitudes', async () => {
    const ok = {
      name: 'Nuevo Supervisor',
      email: 'nuevo@test.local',
      phone: '0991234567',
      temporaryPassword: TEMP,
      role: 'SUPERVISOR',
      facilityId: w.facilityId,
    };
    const rejects = async (patch: object, message: RegExp) => {
      const res = await post(w.admin, '/users/staff', { ...ok, ...patch }).expect(400);
      assert.match(res.text, message);
    };
    await rejects({ phone: '991234567' }, /10 dígitos y empezar por 0/);
    await rejects({ phone: '09912345678' }, /10 dígitos y empezar por 0/);
    await rejects({ phone: '1991234567' }, /10 dígitos y empezar por 0/);
    await rejects({ phone: '+593991234567' }, /10 dígitos y empezar por 0/);
    await rejects({ temporaryPassword: '123456789' }, /entre 8 y 12 caracteres/);
    await rejects({ temporaryPassword: 'Clave2026larga' }, /entre 8 y 12 caracteres/);
    await rejects({ email: 'no-es-correo' }, /correo válido/);
    await rejects({ email: `${'a'.repeat(40)}@test.local` }, /como máximo 50/);
    await rejects({ name: 'N'.repeat(51) }, /como máximo 50/);
    await post(w.admin, '/users/staff', ok).expect(201);
  });

  it('el supervisor requiere sede y el correo no se repite', async () => {
    const base = { name: 'X', phone: '0991234567', temporaryPassword: TEMP, role: 'SUPERVISOR' };
    await post(w.admin, '/users/staff', { ...base, email: 'x@test.local' }).expect(400);
    await post(w.admin, '/users/staff', { ...base, email: 'sara@test.local', facilityId: w.facilityId }).expect(409);
  });

  it('las acciones quedan en la auditoría con quién las hizo', async () => {
    const actions = await t.prisma.auditLog.findMany({
      where: { action: { in: ['SUPERVISOR_CREATED', 'USER_SUSPENDED', 'USER_REACTIVATED', 'PASSWORD_RESET'] } },
    });
    const kinds = new Set(actions.map((a) => a.action));
    assert.equal(kinds.size, 4);
    assert.ok(actions.every((a) => a.actorRole === 'ADMIN'));
  });
});
