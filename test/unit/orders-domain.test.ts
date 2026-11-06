import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma } from '../../src/generated/prisma/client';
import {
  findTransition,
  legKindFor,
  TRANSITIONS,
} from '../../src/orders/order-state-machine';
import { computePricing, type PricingInput } from '../../src/orders/pricing';

const D = (v: number | string) => new Prisma.Decimal(v);
const base: PricingInput = {
  items: [{ unitPrice: D('3.50'), quantity: 4 }],
  extras: [D('2')],
  membershipPercent: D(0),
  promotion: null,
  logisticsFee: D('5'),
  taxRate: D('0.15'),
  taxIncluded: false,
};

describe('computePricing', () => {
  it('prendas + extras + logística + IVA no incluido', () => {
    const r = computePricing(base);
    assert.equal(r.itemsSubtotal.toString(), '14');
    assert.equal(r.extrasTotal.toString(), '2');
    // base = 14 + 2 + 5 = 21; IVA = 3.15; total = 24.15
    assert.equal(r.tax.toString(), '3.15');
    assert.equal(r.total.toString(), '24.15');
  });
  it('IVA incluido: el total no cambia y el impuesto se extrae', () => {
    const r = computePricing({ ...base, taxIncluded: true });
    assert.equal(r.total.toString(), '21');
    assert.equal(r.tax.toString(), '2.74'); // 21 - 21/1.15 = 2.739...
  });
  it('membresía solo descuenta prendas; la promoción % se aplica después', () => {
    const r = computePricing({
      ...base,
      membershipPercent: D(10),
      promotion: { type: 'PERCENTAGE', value: D(10) },
    });
    assert.equal(r.membershipDiscount.toString(), '1.4'); // 10% de 14
    // (14 + 2 - 1.4) = 14.6 ; promo 10% = 1.46
    assert.equal(r.discount.toString(), '1.46');
    assert.equal(r.merchandiseNet.toString(), '13.14');
  });
  it('el descuento fijo nunca supera el subtotal', () => {
    const r = computePricing({
      ...base,
      promotion: { type: 'FIXED', value: D(500) },
    });
    assert.equal(r.merchandiseNet.toString(), '0');
    assert.equal(r.total.toString(), (5 * 1.15).toFixed(2).replace(/0+$/, ''));
  });
  it('por peso usa libras por precio vigente', () => {
    const r = computePricing({
      ...base,
      items: [],
      extras: [],
      weightLb: D('7.5'),
      pricePerPound: D('1.2'),
      logisticsFee: D(0),
      taxRate: D(0),
    });
    assert.equal(r.itemsSubtotal.toString(), '9');
    assert.equal(r.total.toString(), '9');
  });
  it('redondea half-up a 2 decimales', () => {
    const r = computePricing({
      ...base,
      items: [{ unitPrice: D('0.335'), quantity: 1 }],
      extras: [],
      logisticsFee: D(0),
      taxRate: D(0),
    });
    assert.equal(r.itemsSubtotal.toString(), '0.34');
  });
});

describe('máquina de estados', () => {
  it('no hay transiciones duplicadas', () => {
    const keys = TRANSITIONS.map((t) => `${t.from}>${t.to}>${t.mode ?? '*'}`);
    assert.equal(new Set(keys).size, keys.length);
  });
  it('la salida de calidad depende del modo de entrega', () => {
    assert.ok(findTransition('QUALITY_CONTROL', 'READY_FOR_DELIVERY', 'HOME_HOME'));
    assert.equal(findTransition('QUALITY_CONTROL', 'READY_FOR_DELIVERY', 'HOME_STORE'), undefined);
    assert.ok(findTransition('QUALITY_CONTROL', 'READY_FOR_PICKUP', 'HOME_STORE'));
  });
  it('no se puede saltar etapas', () => {
    assert.equal(findTransition('CONFIRMED', 'PICKED_UP', 'HOME_HOME'), undefined);
    assert.equal(findTransition('IN_PROCESS', 'DELIVERED', 'HOME_HOME'), undefined);
  });
  it('los cambios de custodia están protegidos por la puerta HANDOFF', () => {
    for (const to of ['PICKED_UP', 'AT_FACILITY', 'OUT_FOR_DELIVERY', 'DELIVERED'] as const) {
      const ts = TRANSITIONS.filter((t) => t.to === to);
      assert.ok(ts.length > 0);
      assert.ok(ts.every((t) => t.gate === 'HANDOFF'));
    }
  });
  it('el pago protege la confirmación y el cierre', () => {
    assert.equal(findTransition('PAYMENT_PENDING', 'CONFIRMED', 'HOME_HOME')?.gate, 'PAYMENT');
    assert.equal(findTransition('DELIVERED', 'COMPLETED', 'HOME_HOME')?.gate, 'PAYMENT');
  });
  it('el tramo responsable cambia tras la recogida', () => {
    assert.equal(legKindFor('HEADING_TO_FACILITY'), 'INBOUND');
    assert.equal(legKindFor('OUT_FOR_DELIVERY'), 'OUTBOUND');
  });
});
