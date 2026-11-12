import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { MailService } from '../../src/mail/mail.service';
import { bearer, bootApp, createUser, type TestApp } from '../helpers';
import { api, buildWorld, type World } from '../world';

let t: TestApp;
let w: World;
let mail: MailService;

const GENERIC = /Si el correo está registrado/;
const request = (email: string) =>
  t.http.post(`${api}/auth/password-reset/request`).send({ email });
const confirm = (email: string, code: string, newPassword = 'NuevaClave2026') =>
  t.http.post(`${api}/auth/password-reset/confirm`).send({ email, code, newPassword });
const login = (email: string, password: string) =>
  t.http.post(`${api}/auth/login`).send({ email, password });

// El último código enviado a ese correo, leído del buzón en memoria.
function lastCode(email: string): string {
  const message = [...mail.outbox].reverse().find((m) => m.to === email);
  assert.ok(message, `no se envió correo a ${email}`);
  const match = message.text.match(/\b(\d{6})\b/);
  assert.ok(match, 'el correo trae un código de 6 dígitos');
  return match[1];
}

// Permite pedir otro código sin esperar el minuto de espera.
async function skipCooldown(email: string) {
  const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
  await t.prisma.passwordResetCode.updateMany({
    where: { userId: user.id },
    data: { createdAt: new Date(Date.now() - 2 * 60 * 1000) },
  });
}

before(async () => {
  t = await bootApp();
  w = await buildWorld(t);
  mail = t.app.get(MailService);
});
after(() => t.close());
beforeEach(() => {
  mail.outbox.length = 0;
});

describe('restablecer contraseña con código por correo', () => {
  it('el cliente recibe un código, cambia la contraseña y se cierran sus sesiones', async () => {
    const c = await w.newClient('olvido@test.local');
    const oldSession = await login('olvido@test.local', 'Cliente2026ok').expect(200);

    const res = await request('  Olvido@Test.local ').expect(200);
    assert.match(res.body.message, GENERIC);
    const code = lastCode('olvido@test.local');
    assert.match(mail.outbox[0].subject, /restablecer tu contraseña/);

    const done = await confirm('olvido@test.local', code).expect(200);
    assert.match(done.body.message, /actualizada/);
    await login('olvido@test.local', 'Cliente2026ok').expect(401);
    await login('olvido@test.local', 'NuevaClave2026').expect(200);
    // La sesión anterior ya no se puede renovar.
    await t.http
      .post(`${api}/auth/refresh`)
      .send({ refreshToken: oldSession.body.tokens.refreshToken })
      .expect(401);
    // El código es de un solo uso.
    await confirm('olvido@test.local', code, 'OtraClave2026').expect(400);
    const audit = await t.prisma.auditLog.count({ where: { action: 'PASSWORD_RESET_BY_CODE' } });
    assert.equal(audit, 1);
    assert.ok(c.token);
  });

  it('no revela qué correos existen ni envía nada a cuentas que no son de clientes', async () => {
    const unknown = await request('nadie@test.local').expect(200);
    assert.match(unknown.body.message, GENERIC);
    await createUser(t, { email: 'chofer-olvido@test.local', role: 'DRIVER' });
    const staff = await request('chofer-olvido@test.local').expect(200);
    assert.equal(staff.body.message, unknown.body.message);
    assert.deepEqual(mail.outbox, []);
    await confirm('nadie@test.local', '123456').expect(400);
  });

  it('un código incorrecto cuenta como intento y al quinto queda inutilizado', async () => {
    await w.newClient('intentos@test.local');
    await request('intentos@test.local').expect(200);
    const code = lastCode('intentos@test.local');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      const res = await confirm('intentos@test.local', wrong).expect(400);
      assert.match(res.body.message, /no es válido o ya venció/);
    }
    // Ni siquiera el código correcto sirve después del bloqueo.
    await confirm('intentos@test.local', code).expect(400);
    await login('intentos@test.local', 'Cliente2026ok').expect(200);
  });

  it('el código vence a los 15 minutos', async () => {
    await w.newClient('vence@test.local');
    await request('vence@test.local').expect(200);
    const code = lastCode('vence@test.local');
    const user = await t.prisma.user.findUniqueOrThrow({ where: { email: 'vence@test.local' } });
    await t.prisma.passwordResetCode.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await confirm('vence@test.local', code).expect(400);
  });

  it('pedir otro código invalida el anterior y hay un minuto de espera entre envíos', async () => {
    await w.newClient('reenvio@test.local');
    await request('reenvio@test.local').expect(200);
    const first = lastCode('reenvio@test.local');
    // Antes del minuto no se envía otro correo, pero la respuesta es la misma.
    await request('reenvio@test.local').expect(200);
    assert.equal(mail.outbox.filter((m) => m.to === 'reenvio@test.local').length, 1);

    await skipCooldown('reenvio@test.local');
    await request('reenvio@test.local').expect(200);
    const second = lastCode('reenvio@test.local');
    if (first !== second) await confirm('reenvio@test.local', first).expect(400);
    await confirm('reenvio@test.local', second).expect(200);
  });

  it('valida el formato del código y la nueva contraseña', async () => {
    await confirm('olvido@test.local', '12345').expect(400);
    await confirm('olvido@test.local', 'abcdef').expect(400);
    const weak = await confirm('olvido@test.local', '123456', 'corta').expect(400);
    assert.match(weak.text, /entre 8 y 72 caracteres/);
    await request('no-es-correo').expect(400);
  });

  it('un cliente suspendido no puede restablecer', async () => {
    await w.newClient('suspendido@test.local');
    await t.prisma.user.update({ where: { email: 'suspendido@test.local' }, data: { status: 'SUSPENDED' } });
    await request('suspendido@test.local').expect(200);
    assert.deepEqual(mail.outbox, []);
  });

  it('las rutas de recuperación no requieren sesión', async () => {
    const res = await t.http
      .post(`${api}/auth/password-reset/request`)
      .set(bearer('token-invalido'))
      .send({ email: 'olvido@test.local' });
    assert.notEqual(res.status, 401);
  });
});
