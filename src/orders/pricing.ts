import { Prisma } from '../generated/prisma/client';

const D = Prisma.Decimal;
type Dec = Prisma.Decimal;
const round2 = (v: Dec) => v.toDecimalPlaces(2, D.ROUND_HALF_UP);

export interface PricingInput {
  // Prendas: precio unitario ya compuesto (prenda + servicio) y cantidad. Vacío si es por peso.
  items: { unitPrice: Dec; quantity: number }[];
  // Por peso: libras estimadas y precio por libra vigente.
  weightLb?: Dec;
  pricePerPound?: Dec;
  extras: Dec[];
  membershipPercent: Dec;
  promotion: { type: 'PERCENTAGE' | 'FIXED'; value: Dec } | null;
  logisticsFee: Dec;
  taxRate: Dec;
  taxIncluded: boolean;
}

export interface PricingResult {
  itemsSubtotal: Dec;
  extrasTotal: Dec;
  membershipDiscount: Dec;
  discount: Dec;
  // Subtotal tras descuentos y antes de logística e impuesto (base del monto mínimo).
  merchandiseNet: Dec;
  logisticsFee: Dec;
  tax: Dec;
  total: Dec;
}

// Cálculo monetario en Decimal (nunca float). Es la única fuente de precios: el cliente jamás
// envía importes, solo identificadores y cantidades.
export function computePricing(i: PricingInput): PricingResult {
  const itemsSubtotal = round2(
    i.weightLb && i.pricePerPound
      ? i.weightLb.mul(i.pricePerPound)
      : i.items.reduce((s, it) => s.add(it.unitPrice.mul(it.quantity)), new D(0)),
  );
  const extrasTotal = i.extras.reduce((s, p) => s.add(p), new D(0));
  // La membresía descuenta únicamente prendas.
  const membershipDiscount = round2(itemsSubtotal.mul(i.membershipPercent).div(100));
  const afterMembership = itemsSubtotal.add(extrasTotal).sub(membershipDiscount);

  let discount = new D(0);
  if (i.promotion) {
    discount =
      i.promotion.type === 'PERCENTAGE'
        ? round2(afterMembership.mul(i.promotion.value).div(100))
        : i.promotion.value;
    if (discount.gt(afterMembership)) discount = afterMembership;
  }
  const merchandiseNet = afterMembership.sub(discount);
  const base = merchandiseNet.add(i.logisticsFee);

  let tax: Dec;
  let total: Dec;
  if (i.taxIncluded) {
    tax = round2(base.sub(base.div(i.taxRate.add(1))));
    total = base;
  } else {
    tax = round2(base.mul(i.taxRate));
    total = base.add(tax);
  }
  return {
    itemsSubtotal,
    extrasTotal,
    membershipDiscount,
    discount,
    merchandiseNet,
    logisticsFee: i.logisticsFee,
    tax,
    total,
  };
}
