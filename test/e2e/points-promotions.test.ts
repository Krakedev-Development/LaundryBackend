import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bearer, bootApp, type TestApp } from '../helpers';
import { api, buildWorld, type World } from '../world';

let t: TestApp;
let w: World;

const as = (token: string) => bearer(token);

before(async () => {
  t = await bootApp();
  w = await buildWorld(t);
});
after(() => t.close());

describe('puntos y promociones reales', () => {
  it('filtra promociones para clientes y valida cupones por vigencia, monto, límite y primera orden', async () => {
    const promo = (
      await t.http
        .post(`${api}/catalog/promotions`)
        .set(as(w.admin))
        .send({
          name: 'Bienvenida',
          code: 'BIENVENIDO2',
          discountType: 'PERCENTAGE',
          discountValue: 15,
          minOrderAmount: 10,
          maxUses: 5,
          maxUsesPerCustomer: 1,
          firstOrderOnly: true,
        })
        .expect(201)
    ).body;
    assert.equal(promo.firstOrderOnly, true);

    await t.http
      .post(`${api}/catalog/promotions`)
      .set(as(w.admin))
      .send({
        code: 'VENCIDA',
        discountType: 'FIXED',
        discountValue: 3,
        validFrom: '2020-01-01T00:00:00.000Z',
        validUntil: '2020-01-02T00:00:00.000Z',
      })
      .expect(201);

    const c = await w.newClient('promo.client@test.local');
    const cList = (
      await t.http.get(`${api}/catalog/promotions`).set(as(c.token)).expect(200)
    ).body;
    assert.ok(cList.some((p: { code: string }) => p.code === 'BIENVENIDO2'));
    assert.ok(!cList.some((p: { code: string }) => p.code === 'VENCIDA'));

    const adminList = (
      await t.http.get(`${api}/catalog/promotions`).set(as(w.admin)).expect(200)
    ).body;
    assert.ok(adminList.some((p: { code: string }) => p.code === 'VENCIDA'));

    // Monto mínimo no alcanzado -> 422.
    await t.http
      .post(`${api}/catalog/promotions/validate`)
      .set(as(c.token))
      .send({ code: 'BIENVENIDO2', subtotal: 5 })
      .expect(422);

    // Monto válido -> 201 con descuento estimado.
    const valid = (
      await t.http
        .post(`${api}/catalog/promotions/validate`)
        .set(as(c.token))
        .send({ code: 'bienvenido2', subtotal: 20 })
        .expect(201)
    ).body;
    assert.equal(valid.valid, true);
    assert.equal(valid.estimatedDiscount, 3);

    // Usar la promoción en primera orden -> funciona.
    await t.http
      .post(`${api}/orders`)
      .set(as(c.token))
      .send({
        facilityId: w.facilityId,
        mode: 'HOME_HOME',
        pickupAddressId: c.addressId,
        pickupSlotId: await w.slot('DRIVER_PICKUP'),
        items: [{ garmentId: w.garmentId, serviceId: w.serviceId, quantity: 3 }],
        promotionCode: 'BIENVENIDO2',
      })
      .expect(201);

    // Ya no aplica en segunda orden.
    await t.http
      .post(`${api}/catalog/promotions/validate`)
      .set(as(c.token))
      .send({ code: 'BIENVENIDO2', subtotal: 20 })
      .expect(422);
    await t.http
      .post(`${api}/orders`)
      .set(as(c.token))
      .send({
        facilityId: w.facilityId,
        mode: 'HOME_HOME',
        pickupAddressId: c.addressId,
        pickupSlotId: await w.slot('DRIVER_PICKUP'),
        items: [{ garmentId: w.garmentId, serviceId: w.serviceId, quantity: 3 }],
        promotionCode: 'BIENVENIDO2',
      })
      .expect(422);
  });

  it('ajuste manual de puntos, consulta en directorio/me y generación de crédito o cupón al aprobar canje', async () => {
    const c = await w.newClient('rewards.real@test.local');
    const other = await w.newClient('rewards.other@test.local');

    // Supervisor no puede ajustar puntos (403); negativo por debajo de 0 -> 409.
    await t.http
      .post(`${api}/points/adjust`)
      .set(as(w.supervisor))
      .send({ customerId: c.customerId, points: 50, reason: 'No autorizado' })
      .expect(403);
    await t.http
      .post(`${api}/points/adjust`)
      .set(as(w.admin))
      .send({ customerId: c.customerId, points: -10, reason: 'Negativo' })
      .expect(409);

    const adj = (
      await t.http
        .post(`${api}/points/adjust`)
        .set(as(w.admin))
        .send({ customerId: c.customerId, points: 500, reason: 'Bono bienvenida' })
        .expect(201)
    ).body;
    assert.equal(adj.balance, 500);

    const me = (await t.http.get(`${api}/auth/me`).set(as(c.token)).expect(200)).body;
    assert.equal(me.pointsBalance, 500);

    const dir = (await t.http.get(`${api}/customers`).set(as(w.admin)).expect(200)).body;
    const row = dir.find((r: { id: string }) => r.id === c.customerId);
    assert.equal(row.pointsBalance, 500);

    const ledger = (
      await t.http.get(`${api}/customers/${c.customerId}/points`).set(as(w.admin)).expect(200)
    ).body;
    assert.equal(ledger.balance, 500);
    assert.equal(ledger.entries[0].note, 'Bono bienvenida');

    // Recompensa con crédito en billetera.
    const walletReward = (
      await t.http
        .post(`${api}/catalog/rewards`)
        .set(as(w.admin))
        .send({
          title: 'Crédito $5 en Billetera',
          pointsCost: 100,
          fulfillmentType: 'WALLET_CREDIT',
          walletCreditAmount: 5,
        })
        .expect(201)
    ).body;

    // Recompensa con cupón personal.
    const couponReward = (
      await t.http
        .post(`${api}/catalog/rewards`)
        .set(as(w.admin))
        .send({
          title: 'Cupón $4 de descuento',
          pointsCost: 150,
          fulfillmentType: 'PROMO_COUPON',
          couponDiscountType: 'FIXED',
          couponDiscountValue: 4,
          couponMinOrderAmount: 5,
          couponValidityDays: 15,
        })
        .expect(201)
    ).body;

    const red1 = (
      await t.http
        .post(`${api}/points/redeem`)
        .set(as(c.token))
        .send({ rewardId: walletReward.id })
        .expect(201)
    ).body;
    const red2 = (
      await t.http
        .post(`${api}/points/redeem`)
        .set(as(c.token))
        .send({ rewardId: couponReward.id })
        .expect(201)
    ).body;

    const staffList = (
      await t.http.get(`${api}/redemptions`).set(as(w.admin)).expect(200)
    ).body;
    assert.ok(
      staffList.some(
        (r: { id: string; customer?: { user?: { name?: string } } }) =>
          r.id === red1.id && Boolean(r.customer?.user?.name),
      ),
    );

    // Aprobar walletReward -> acredita $5 en billetera.
    const approvedWallet = (
      await t.http
        .post(`${api}/redemptions/${red1.id}/review`)
        .set(as(w.admin))
        .send({ approve: true })
        .expect(201)
    ).body;
    assert.equal(Number(approvedWallet.walletCreditAmount), 5);
    const walletAfter = (
      await t.http.get(`${api}/wallet`).set(as(c.token)).expect(200)
    ).body;
    assert.equal(Number(walletAfter.balance), 5);

    // Aprobar couponReward -> genera cupón personal CANJE-... utilizable solo por `c`.
    const approvedCoupon = (
      await t.http
        .post(`${api}/redemptions/${red2.id}/review`)
        .set(as(w.admin))
        .send({ approve: true })
        .expect(201)
    ).body;
    const personalCode = approvedCoupon.generatedPromoCode as string;
    assert.ok(personalCode.startsWith('CANJE-'));

    // Otro cliente no puede validar ni usar ese cupón personal (404).
    await t.http
      .post(`${api}/catalog/promotions/validate`)
      .set(as(other.token))
      .send({ code: personalCode, subtotal: 10 })
      .expect(404);

    // El cliente dueño sí lo valida y lo aplica en una orden.
    await t.http
      .post(`${api}/catalog/promotions/validate`)
      .set(as(c.token))
      .send({ code: personalCode, subtotal: 10 })
      .expect(201);
    const ord = (
      await t.http
        .post(`${api}/orders`)
        .set(as(c.token))
        .send({
          facilityId: w.facilityId,
          mode: 'HOME_HOME',
          pickupAddressId: c.addressId,
          pickupSlotId: await w.slot('DRIVER_PICKUP'),
          items: [{ garmentId: w.garmentId, serviceId: w.serviceId, quantity: 2 }],
          promotionCode: personalCode,
        })
        .expect(201)
    ).body;
    assert.equal(ord.discount, '4');

    // Al tener maxUses: 1, un segundo intento con el cupón personal falla (422).
    await t.http
      .post(`${api}/catalog/promotions/validate`)
      .set(as(c.token))
      .send({ code: personalCode, subtotal: 10 })
      .expect(422);
  });
});
