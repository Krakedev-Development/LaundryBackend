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

describe('catálogo y membresías reales', () => {
  it('persiste campos completos en prendas, extras y membresías y expone suscriptores', async () => {
    const garment = (
      await t.http
        .post(`${api}/catalog/garments`)
        .set(as(w.admin))
        .send({
          name: 'Chaqueta de Lino',
          description: 'Lavado delicado al vapor',
          category: 'Prendas exteriores',
          estimatedHours: 36,
          basePrice: 6.5,
        })
        .expect(201)
    ).body;
    assert.equal(garment.description, 'Lavado delicado al vapor');
    assert.equal(garment.category, 'Prendas exteriores');
    assert.equal(garment.estimatedHours, 36);

    const extra = (
      await t.http
        .post(`${api}/catalog/extras`)
        .set(as(w.admin))
        .send({ name: 'Empaque Especial', description: 'Funda protectora', price: 1.25 })
        .expect(201)
    ).body;
    const clearedExtra = (
      await t.http
        .patch(`${api}/catalog/extras/${extra.id}`)
        .set(as(w.admin))
        .send({ description: null })
        .expect(200)
    ).body;
    assert.equal(clearedExtra.description, null);

    const limitedPlan = (
      await t.http
        .post(`${api}/catalog/memberships`)
        .set(as(w.admin))
        .send({
          name: 'Plan Mensual 1 Envío',
          description: 'Incluye 1 envío gratis semanal',
          priceMonthly: 15,
          interval: 'MONTHLY',
          includedWeight: 10,
          weightUnit: 'KG',
          weeklyPickups: 1,
          garmentDiscountPercent: 10,
          priorityService: true,
          benefits: ['10% dto', 'Prioridad'],
        })
        .expect(201)
    ).body;
    assert.equal(limitedPlan.interval, 'MONTHLY');
    assert.equal(limitedPlan.priorityService, true);
    assert.equal(limitedPlan.weeklyPickups, 1);

    const unlimitedPlan = (
      await t.http
        .post(`${api}/catalog/memberships`)
        .set(as(w.admin))
        .send({
          name: 'Plan Anual Ilimitado',
          priceMonthly: 0,
          interval: 'YEARLY',
          weeklyPickups: null,
          garmentDiscountPercent: 20,
          priorityService: false,
          benefits: ['Envíos gratis ilimitados'],
        })
        .expect(201)
    ).body;
    assert.equal(unlimitedPlan.weeklyPickups, null);

    const c = await w.newClient('membresia.real@test.local');

    // Sin saldo en billetera falla con 409.
    await t.http
      .put(`${api}/customers/me/membership`)
      .set(as(c.token))
      .send({ planId: limitedPlan.id })
      .expect(409);

    // Con saldo suficiente descuenta de la billetera, crea vigencia y aplica beneficios.
    await w.credit(c.customerId, 40);
    const subscribed = (
      await t.http
        .put(`${api}/customers/me/membership`)
        .set(as(c.token))
        .send({ planId: limitedPlan.id })
        .expect(200)
    ).body;
    assert.equal(subscribed.status, 'ACTIVE');
    assert.equal(subscribed.priceCharged, '15');
    assert.equal(subscribed.walletBalance, '25');
    assert.ok(subscribed.expiresAt);

    // Re-contratar el mismo plan activo devuelve 409.
    await t.http
      .put(`${api}/customers/me/membership`)
      .set(as(c.token))
      .send({ planId: limitedPlan.id })
      .expect(409);

    const current = (
      await t.http.get(`${api}/customers/me/membership`).set(as(c.token)).expect(200)
    ).body;
    assert.equal(current.membershipPlan.id, limitedPlan.id);
    assert.equal(current.weeklyPickupsLimit, 1);
    assert.equal(current.weeklyPickupsUsed, 0);

    // 1er pedido usa el cupo semanal gratis (logisticsFee = 0) y priority = true.
    const o1 = (
      await t.http
        .post(`${api}/orders`)
        .set(as(c.token))
        .send({
          facilityId: w.facilityId,
          mode: 'HOME_HOME',
          pickupAddressId: c.addressId,
          pickupSlotId: await w.slot('DRIVER_PICKUP'),
          items: [{ garmentId: garment.id, serviceId: w.serviceId, quantity: 1 }],
          extraIds: [extra.id],
        })
        .expect(201)
    ).body;
    assert.equal(o1.logisticsFee, '0');
    assert.equal(o1.freeLogisticsApplied, true);
    assert.equal(o1.priority, true);
    assert.equal(o1.items[0].garment.name, 'Chaqueta de Lino');
    assert.equal(o1.items[0].service.name, 'Lavado');
    assert.equal(o1.extras[0].extra.name, 'Empaque Especial');
    assert.equal(o1.facility.name, 'Sede');

    // 2do pedido en la misma semana cobra logística normal (2 + 3 = 5).
    const o2 = (
      await t.http
        .post(`${api}/orders`)
        .set(as(c.token))
        .send({
          facilityId: w.facilityId,
          mode: 'HOME_HOME',
          pickupAddressId: c.addressId,
          pickupSlotId: await w.slot('DRIVER_PICKUP'),
          items: [{ garmentId: garment.id, serviceId: w.serviceId, quantity: 1 }],
        })
        .expect(201)
    ).body;
    assert.equal(o2.logisticsFee, '5');
    assert.equal(o2.freeLogisticsApplied, false);

    // Suscriptores visibles en catálogo para staff; denegado para cliente/driver.
    await t.http
      .get(`${api}/catalog/memberships/${limitedPlan.id}/subscribers`)
      .set(as(c.token))
      .expect(403);
    const subs = (
      await t.http
        .get(`${api}/catalog/memberships/${limitedPlan.id}/subscribers`)
        .set(as(w.admin))
        .expect(200)
    ).body;
    assert.equal(subs.length, 1);
    assert.equal(subs[0].customerId, c.customerId);
    assert.equal(subs[0].weeklyPickupsUsed, 1);

    // Cambio a plan gratis (weeklyPickups: null -> ilimitados) sin débito.
    await t.http
      .put(`${api}/customers/me/membership`)
      .set(as(c.token))
      .send({ planId: unlimitedPlan.id })
      .expect(200);
    const o3 = (
      await t.http
        .post(`${api}/orders`)
        .set(as(c.token))
        .send({
          facilityId: w.facilityId,
          mode: 'HOME_HOME',
          pickupAddressId: c.addressId,
          pickupSlotId: await w.slot('DRIVER_PICKUP'),
          items: [{ garmentId: garment.id, serviceId: w.serviceId, quantity: 1 }],
        })
        .expect(201)
    ).body;
    assert.equal(o3.logisticsFee, '0');
    assert.equal(o3.freeLogisticsApplied, true);

    // Cancelación de membresía por el cliente.
    await t.http.delete(`${api}/customers/me/membership`).set(as(c.token)).expect(200);
    const afterCancel = (
      await t.http.get(`${api}/customers/me/membership`).set(as(c.token)).expect(200)
    ).body;
    assert.equal(afterCancel.membershipPlan, null);
    assert.equal(afterCancel.status, 'CANCELLED');

    // Asignación y retiro administrativo de membresía.
    await t.http
      .put(`${api}/customers/${c.customerId}/membership`)
      .set(as(w.supervisor))
      .send({ planId: limitedPlan.id })
      .expect(403);
    const adminAssigned = (
      await t.http
        .put(`${api}/customers/${c.customerId}/membership`)
        .set(as(w.admin))
        .send({ planId: limitedPlan.id, reason: 'Cortesía' })
        .expect(200)
    ).body;
    assert.equal(adminAssigned.membershipPlan.id, limitedPlan.id);

    const adminRemoved = (
      await t.http
        .put(`${api}/customers/${c.customerId}/membership`)
        .set(as(w.admin))
        .send({ planId: null, reason: 'Fin de cortesía' })
        .expect(200)
    ).body;
    assert.equal(adminRemoved.membershipPlan, null);
    assert.equal(adminRemoved.membershipStatus, 'CANCELLED');
  });
});
