import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { bearer, bootApp, type TestApp } from '../helpers';
import { api, buildWorld, FULL_POLICY, type World } from '../world';

let t: TestApp;
let w: World;

const CEDULA = '0912345675';
const jpeg = () =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(300)]);
const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    randomBytes(300),
  ]);

const get = (token: string, path: string) =>
  t.http.get(`${api}${path}`).set(bearer(token));
const post = (token: string, path: string, body: object = {}) =>
  t.http.post(`${api}${path}`).set(bearer(token)).send(body);
const upload = (token: string, type: string, file: Buffer = jpeg(), name = 'foto.jpg') =>
  t.http
    .put(`${api}/kyc/me/documents/${type}`)
    .set(bearer(token))
    .attach('file', file, { filename: name });

async function uploadAll(token: string) {
  for (const type of ['SELFIE', 'ID_FRONT', 'ID_BACK'])
    await upload(token, type).expect(200);
}

// Envío completo hasta dejarlo pendiente de revisión.
async function submitted(email: string) {
  const c = await w.newPendingClient(email);
  await uploadAll(c.token);
  await post(c.token, '/kyc/me/submit', { documentNumber: CEDULA }).expect(201);
  return c;
}

before(async () => {
  t = await bootApp();
  w = await buildWorld(t);
});
after(() => t.close());

describe('registro y estado de verificación', () => {
  it('el registro y el login informan el estado KYC y recortan nombre y apellido', async () => {
    const reg = await t.http
      .post(`${api}/auth/register`)
      .send({
        firstName: '  Ana ',
        lastName: ' Pérez ',
        email: 'ana@test.local',
        phone: '+593991234567',
        password: 'Cliente2026ok',
      })
      .expect(201);
    assert.equal(reg.body.user.name, 'Ana Pérez');
    assert.equal(reg.body.user.kycStatus, 'NOT_SUBMITTED');
    const login = await t.http
      .post(`${api}/auth/login`)
      .send({ email: 'ana@test.local', password: 'Cliente2026ok' })
      .expect(200);
    assert.equal(login.body.user.kycStatus, 'NOT_SUBMITTED');
    const me = await get(login.body.tokens.accessToken, '/auth/me').expect(200);
    assert.equal(me.body.kycStatus, 'NOT_SUBMITTED');
    // El personal no tiene estado de verificación.
    const staff = await get(w.admin, '/auth/me').expect(200);
    assert.equal(staff.body.kycStatus, null);
  });

  it('exige nombre y apellido', async () => {
    await t.http
      .post(`${api}/auth/register`)
      .send({ firstName: 'Solo', email: 'x@test.local', phone: '+593991234567', password: 'Cliente2026ok' })
      .expect(400);
  });
});

describe('cliente sin aprobar: puede entrar y consultar, no operar', () => {
  it('lee su información pero toda acción responde 403 hasta la aprobación', async () => {
    const c = await w.newPendingClient('bloqueado@test.local');
    await get(c.token, '/wallet').expect(200);
    await get(c.token, '/customers/me/addresses').expect(200);
    await get(c.token, '/notifications').expect(200);
    const blocked = await post(c.token, '/customers/me/addresses', {
      title: 'Casa', fullAddress: 'Calle 1', latitude: 5, longitude: 5,
    }).expect(403);
    assert.match(blocked.body.message, /identidad aún no está aprobada/);
    await post(c.token, '/orders', {}).expect(403);
    await post(c.token, '/wallet/charges/00000000-0000-4000-8000-000000000000/pay', {}).expect(403);
  });

  it('pendiente o rechazado sigue bloqueado; aprobado opera', async () => {
    const c = await submitted('flujo@test.local');
    await post(c.token, '/customers/me/addresses', {
      title: 'Casa', fullAddress: 'Calle 1', latitude: 5, longitude: 5,
    }).expect(403);
    await post(w.admin, `/kyc/${c.customerId}/review`, { approve: false, reason: 'Borrosa' }).expect(201);
    await post(c.token, '/customers/me/addresses', {
      title: 'Casa', fullAddress: 'Calle 1', latitude: 5, longitude: 5,
    }).expect(403);
    await upload(c.token, 'SELFIE').expect(200);
    await upload(c.token, 'ID_FRONT').expect(200);
    await upload(c.token, 'ID_BACK').expect(200);
    await post(c.token, '/kyc/me/submit', { documentNumber: CEDULA }).expect(201);
    await post(w.admin, `/kyc/${c.customerId}/review`, { approve: true }).expect(201);
    await post(c.token, '/customers/me/addresses', {
      title: 'Casa', fullAddress: 'Calle 1', latitude: 5, longitude: 5,
    }).expect(201);
  });
});

describe('subida de documentos', () => {
  it('acepta JPEG, PNG y WebP por su contenido y rechaza lo demás', async () => {
    const c = await w.newPendingClient('subida@test.local');
    await upload(c.token, 'SELFIE', png(), 'a.png').expect(200);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP'), randomBytes(50)]);
    await upload(c.token, 'ID_FRONT', webp, 'a.webp').expect(200);
    // Una extensión de imagen no basta: se valida el contenido.
    const fake = await upload(c.token, 'ID_BACK', Buffer.from('<script>alert(1)</script>'), 'a.jpg').expect(400);
    assert.match(fake.body.message, /JPEG, PNG o WebP/);
    await upload(c.token, 'ID_BACK', Buffer.alloc(0), 'vacio.jpg').expect(400);
    await upload(c.token, 'PASAPORTE').expect(400);
    await t.http.put(`${api}/kyc/me/documents/SELFIE`).set(bearer(c.token)).expect(400);
  });

  it('rechaza imágenes por encima del tope de tamaño', async () => {
    const c = await w.newPendingClient('grande@test.local');
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(7 * 1024 * 1024)]);
    await upload(c.token, 'SELFIE', big).expect(413);
  });

  it('subir de nuevo el mismo tipo reemplaza la imagen anterior', async () => {
    const c = await w.newPendingClient('reemplazo@test.local');
    const status = await upload(c.token, 'SELFIE').expect(200);
    assert.deepEqual(status.body.uploaded, ['SELFIE']);
    await upload(c.token, 'SELFIE').expect(200);
    assert.equal(await t.prisma.kycDocument.count({ where: { customerId: c.customerId } }), 1);
  });

  it('no se envía con documentos faltantes ni con una cédula inválida', async () => {
    const c = await w.newPendingClient('incompleto@test.local');
    await upload(c.token, 'SELFIE').expect(200);
    const missing = await post(c.token, '/kyc/me/submit', { documentNumber: CEDULA }).expect(400);
    assert.match(missing.body.message, /cédula/);
    await uploadAll(c.token);
    await post(c.token, '/kyc/me/submit', { documentNumber: '1234567890' }).expect(400);
    await post(c.token, '/kyc/me/submit', { documentNumber: '123' }).expect(400);
    await post(c.token, '/kyc/me/submit', {}).expect(400);
    assert.equal((await get(c.token, '/kyc/me')).body.status, 'NOT_SUBMITTED');
    await post(c.token, '/kyc/me/submit', { documentNumber: CEDULA }).expect(201);
    assert.equal((await get(c.token, '/kyc/me')).body.status, 'PENDING');
  });

  it('en revisión no se reenvía ni se cambian las imágenes', async () => {
    const c = await submitted('enrevision@test.local');
    await post(c.token, '/kyc/me/submit', { documentNumber: CEDULA }).expect(409);
    await upload(c.token, 'SELFIE').expect(409);
  });
});

describe('revisión del administrador', () => {
  it('el administrador ve la cola, la ficha y las imágenes; todo acceso queda auditado', async () => {
    const c = await w.newPendingClient('revisar@test.local');
    const selfie = jpeg();
    const front = png();
    const back = jpeg();
    await upload(c.token, 'SELFIE', selfie).expect(200);
    await upload(c.token, 'ID_FRONT', front, 'f.png').expect(200);
    await upload(c.token, 'ID_BACK', back).expect(200);
    await post(c.token, '/kyc/me/submit', { documentNumber: CEDULA }).expect(201);

    const queue = await get(w.admin, '/kyc').expect(200);
    const row = queue.body.find((x: { id: string }) => x.id === c.customerId);
    assert.ok(row);
    assert.equal(row.user.email, 'revisar@test.local');
    assert.equal(row.kycDocumentNumber, CEDULA);

    const detail = await get(w.admin, `/kyc/${c.customerId}`).expect(200);
    assert.deepEqual(
      detail.body.documents.map((d: { type: string }) => d.type).sort(),
      ['ID_BACK', 'ID_FRONT', 'SELFIE'],
    );
    assert.equal(JSON.stringify(detail.body).includes('data'), false);

    const img = await get(w.admin, `/kyc/${c.customerId}/documents/ID_FRONT`).expect(200);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.match(img.headers['cache-control'], /no-store/);
    assert.equal(img.headers['x-content-type-options'], 'nosniff');
    assert.ok(Buffer.compare(img.body, front) === 0);

    const audits = await t.prisma.auditLog.findMany({
      where: { action: 'KYC_DOCUMENT_VIEWED', entityId: c.customerId },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].reason, 'ID_FRONT');
  });

  it('solo el administrador accede a la cola y a los documentos', async () => {
    const c = await submitted('privado@test.local');
    for (const token of [c.token, w.supervisor, w.driverToken]) {
      await get(token, '/kyc').expect(403);
      await get(token, `/kyc/${c.customerId}`).expect(403);
      await get(token, `/kyc/${c.customerId}/documents/SELFIE`).expect(403);
      await post(token, `/kyc/${c.customerId}/review`, { approve: true }).expect(403);
    }
  });

  it('el rechazo exige motivo y el cliente ve el motivo con los reenvíos restantes', async () => {
    const c = await submitted('rechazo@test.local');
    await post(w.admin, `/kyc/${c.customerId}/review`, { approve: false }).expect(400);
    await post(w.admin, `/kyc/${c.customerId}/review`, { approve: false, reason: 'Selfie borrosa' }).expect(201);
    const mine = (await get(c.token, '/kyc/me')).body;
    assert.equal(mine.status, 'REJECTED');
    assert.equal(mine.rejectionReason, 'Selfie borrosa');
    assert.equal(mine.canSubmit, true);
    assert.equal(mine.resubmissionsLeft, 3);
    assert.deepEqual(mine.uploaded, []);
    const notes = await get(c.token, '/notifications').expect(200);
    assert.ok(notes.body.data.some((n: { category: string }) => n.category === 'KYC'));
    // Ya revisado: no se revisa dos veces.
    await post(w.admin, `/kyc/${c.customerId}/review`, { approve: true }).expect(409);
  });

  it('no existe ficha ni documento de quien nunca envió', async () => {
    const c = await w.newPendingClient('nada@test.local');
    await get(w.admin, `/kyc/${c.customerId}`).expect(404);
    await get(w.admin, `/kyc/${c.customerId}/documents/SELFIE`).expect(404);
    await get(w.admin, '/kyc/no-es-uuid').expect(400);
  });
});

describe('límite de reenvíos', () => {
  it('permite el primer envío y 3 reenvíos; el cuarto rechazo bloquea', async () => {
    const c = await w.newPendingClient('limite@test.local');
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const before = (await get(c.token, '/kyc/me')).body;
      assert.equal(before.canSubmit, true, `envío ${attempt}`);
      await uploadAll(c.token);
      await post(c.token, '/kyc/me/submit', { documentNumber: CEDULA }).expect(201);
      await post(w.admin, `/kyc/${c.customerId}/review`, { approve: false, reason: `Intento ${attempt}` }).expect(201);
    }
    const mine = (await get(c.token, '/kyc/me')).body;
    assert.equal(mine.status, 'REJECTED');
    assert.equal(mine.canSubmit, false);
    assert.equal(mine.resubmissionsLeft, 0);
    await upload(c.token, 'SELFIE').expect(409);
    await post(c.token, '/kyc/me/submit', { documentNumber: CEDULA }).expect(409);
  });

  it('el administrador puede cambiar el límite con la política', async () => {
    await post(w.admin, '/policy', { ...FULL_POLICY, kycMaxResubmissions: 0 }).expect(201);
    const c = await submitted('sinreenvios@test.local');
    await post(w.admin, `/kyc/${c.customerId}/review`, { approve: false, reason: 'No coincide' }).expect(201);
    const mine = (await get(c.token, '/kyc/me')).body;
    assert.equal(mine.canSubmit, false);
    assert.equal(mine.resubmissionsLeft, 0);
    await post(w.admin, '/policy', { ...FULL_POLICY }).expect(201);
  });
});

describe('directorio de clientes y membresía', () => {
  it('lista solo clientes aprobados, al administrador y al supervisor', async () => {
    const pending = await submitted('directorio-pendiente@test.local');
    const approved = await w.newClient('directorio-aprobado@test.local');

    const rows = (await get(w.admin, '/customers').expect(200)).body;
    const ids = rows.map((r: { id: string }) => r.id);
    assert.ok(ids.includes(approved.customerId));
    assert.ok(!ids.includes(pending.customerId), 'un pendiente no aparece en el directorio');
    assert.ok(rows.every((r: { kycStatus: string }) => r.kycStatus === 'APPROVED'));

    await post(w.admin, `/kyc/${pending.customerId}/review`, { approve: true }).expect(201);
    const after = (await get(w.admin, '/customers').expect(200)).body;
    assert.ok(after.some((r: { id: string }) => r.id === pending.customerId));

    // El supervisor ve el mismo directorio, pero no la cola ni los documentos de KYC.
    const supervisorRows = (await get(w.supervisor, '/customers').expect(200)).body;
    assert.deepEqual(
      supervisorRows.map((r: { id: string }) => r.id).sort(),
      after.map((r: { id: string }) => r.id).sort(),
    );
    await get(w.supervisor, '/kyc').expect(403);
    await get(pending.token, '/customers').expect(403);
    await get(w.driverToken, '/customers').expect(403);
  });

  it('sin plan elegido no hay membresía; el cliente la elige y se refleja en todas partes', async () => {
    const plan = (
      await post(w.admin, '/catalog/memberships', {
        name: 'Plan de prueba',
        priceMonthly: 12.5,
        weeklyPickups: 2,
        garmentDiscountPercent: 8,
        benefits: ['8% de descuento'],
      }).expect(201)
    ).body;
    const c = await w.newClient('con-plan@test.local');

    const me = (await get(c.token, '/auth/me').expect(200)).body;
    assert.equal(me.membershipPlan, null);
    const listed = (await get(w.admin, '/customers').expect(200)).body.find(
      (r: { id: string }) => r.id === c.customerId,
    );
    assert.equal(listed.membershipPlan, null);

    await t.http.put(`${api}/customers/me/membership`).set(bearer(c.token))
      .send({ planId: '00000000-0000-4000-8000-000000000000' }).expect(404);
    await t.http.put(`${api}/customers/me/membership`).set(bearer(c.token))
      .send({ planId: plan.id }).expect(200);

    assert.equal((await get(c.token, '/auth/me').expect(200)).body.membershipPlan.name, 'Plan de prueba');
    const after = (await get(w.admin, '/customers').expect(200)).body.find(
      (r: { id: string }) => r.id === c.customerId,
    );
    assert.equal(after.membershipPlan.name, 'Plan de prueba');

    // Un cliente sin verificación aprobada no puede elegir plan.
    const pending = await w.newPendingClient('pendiente-plan@test.local');
    await t.http.put(`${api}/customers/me/membership`).set(bearer(pending.token))
      .send({ planId: plan.id }).expect(403);
  });
});
