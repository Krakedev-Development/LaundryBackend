import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { Prisma } from '../generated/prisma/client';
import { OrdersService, type FullOrder } from '../orders/orders.service';
import { computePricing } from '../orders/pricing';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import type {
  CreateAdjustmentDto,
  DecideAdjustmentDto,
  RecordWeightDto,
} from './dto/adjustments.dto';

const D = Prisma.Decimal;
type Tx = Prisma.TransactionClient;
// Constante física de conversión, no una regla de negocio.
const GRAMS_PER_POUND = '453.59237';
const isStaff = (u: AuthUser) => u.role === 'ADMIN' || u.role === 'SUPERVISOR';

@Injectable()
export class AdjustmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly wallet: WalletService,
  ) {}

  // ---- Pesaje

  // Registra el peso y pasa a inspección. En pedidos por peso recalcula con las condiciones
  // congeladas al crear (versión de política y precio por libra) y genera el ajuste.
  async recordWeight(user: AuthUser, orderId: string, dto: RecordWeightDto) {
    const order = await this.staffOrder(user, orderId, dto.expectedVersion, ['WEIGHING']);
    if (await this.prisma.weightMeasurement.count({ where: { orderId } }))
      throw new ConflictException('El pedido ya fue pesado.');

    const recomputed =
      order.pricingModel === 'PER_WEIGHT'
        ? await this.recompute(order, dto.weightGrams)
        : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.weightMeasurement.create({
        data: { orderId, weightGrams: dto.weightGrams, measuredById: user.id },
      });
      if (recomputed) {
        const diff = recomputed.total.sub(order.total);
        if (!diff.isZero()) {
          const increase = diff.gt(0);
          await tx.priceAdjustment.create({
            data: {
              orderId,
              type: 'WEIGHT_ADJUSTMENT',
              internalReason: `Peso real ${dto.weightGrams} g frente a ${order.estimatedWeightLb} lb estimadas.`,
              customerMessage: 'Ajuste por peso real de tu ropa.',
              amountDifference: diff,
              // Solo un aumento exige aprobación del cliente.
              requiresCustomerApproval: increase,
              status: increase ? 'PENDING_CUSTOMER' : 'APPROVED',
              resolvedAt: increase ? null : new Date(),
              createdById: user.id,
            },
          });
        }
        await tx.order.update({
          where: { id: orderId },
          data: { pricingStatus: diff.gt(0) ? 'ADJUSTMENT_PENDING' : 'CALCULATED' },
        });
      }
      await this.orders.applyTransition(tx, order, 'INSPECTION', user, 'Peso registrado');
    });
    return this.orders.viewFor(user, orderId);
  }

  // ---- Ajustes de precio

  async create(user: AuthUser, orderId: string, dto: CreateAdjustmentDto) {
    const order = await this.staffOrder(user, orderId, dto.expectedVersion, [
      'INSPECTION',
      'PRICING_PENDING',
    ]);
    const diff = new D(dto.amountDifference);
    const increase = diff.gt(0);
    return this.prisma.$transaction(async (tx) => {
      const adjustment = await tx.priceAdjustment.create({
        data: {
          orderId,
          type: dto.type,
          internalReason: dto.internalReason.trim(),
          customerMessage: dto.customerMessage.trim(),
          amountDifference: diff,
          requiresCustomerApproval: increase,
          status: increase ? 'PENDING_CUSTOMER' : 'APPROVED',
          resolvedAt: increase ? null : new Date(),
          createdById: user.id,
        },
      });
      if (increase)
        await tx.order.update({
          where: { id: orderId },
          data: { pricingStatus: 'ADJUSTMENT_PENDING' },
        });
      await this.bump(tx, order, user, 'Ajuste de precio registrado');
      return adjustment;
    });
  }

  async list(user: AuthUser, orderId: string) {
    await this.orders.forUser(user, orderId);
    const rows = await this.prisma.priceAdjustment.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
    // El motivo interno es solo para el personal.
    return rows.map(({ internalReason, ...r }) =>
      isStaff(user) ? { ...r, internalReason } : r,
    );
  }

  async decide(
    user: AuthUser,
    orderId: string,
    adjustmentId: string,
    dto: DecideAdjustmentDto,
  ) {
    const order = await this.orders.forUser(user, orderId);
    if (user.role !== 'CLIENT')
      throw new ForbiddenException('Solo el cliente decide sobre un ajuste.');
    if (order.version !== dto.expectedVersion)
      throw new ConflictException(
        `El pedido cambió (versión ${order.version}); recárgalo e intenta de nuevo.`,
      );
    if (order.status !== 'CUSTOMER_APPROVAL_PENDING')
      throw new ConflictException('El pedido no espera una decisión del cliente.');
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.priceAdjustment.updateMany({
        where: { id: adjustmentId, orderId, status: 'PENDING_CUSTOMER' },
        data: { status: dto.approve ? 'APPROVED' : 'REJECTED', resolvedAt: new Date() },
      });
      if (!count) throw new NotFoundException('No hay un ajuste pendiente con ese id.');
      await this.bump(
        tx,
        order,
        user,
        dto.approve ? 'Ajuste aprobado por el cliente' : 'Ajuste rechazado por el cliente',
      );
      const pending = await tx.priceAdjustment.count({
        where: { orderId, status: 'PENDING_CUSTOMER' },
      });
      const rejected = await tx.priceAdjustment.count({
        where: { orderId, status: 'REJECTED' },
      });
      return { pending, requiresStaffReview: pending === 0 && rejected > 0 };
    });
  }

  // ---- Cierre de la fijación de precio

  // PRICING_PENDING: si hay ajustes por decidir, pasa a espera del cliente; si no, fija el
  // precio final. CUSTOMER_APPROVAL_PENDING: cuando ya no hay pendientes, el personal fija el
  // precio con lo aprobado (lo rechazado no se aplica).
  async resolve(user: AuthUser, orderId: string, dto: { expectedVersion: number }) {
    const order = await this.staffOrder(user, orderId, dto.expectedVersion, [
      'PRICING_PENDING',
      'CUSTOMER_APPROVAL_PENDING',
    ]);
    const pending = await this.prisma.priceAdjustment.count({
      where: { orderId, status: 'PENDING_CUSTOMER' },
    });
    if (pending > 0 && order.status === 'CUSTOMER_APPROVAL_PENDING')
      throw new ConflictException('Aún hay ajustes esperando la decisión del cliente.');

    await this.prisma.$transaction(async (tx) => {
      if (pending > 0) {
        await this.orders.applyTransition(
          tx, order, 'CUSTOMER_APPROVAL_PENDING', user, 'Ajustes enviados al cliente',
        );
        return;
      }
      await this.finalize(tx, order, user);
    });
    return this.orders.viewFor(user, orderId);
  }

  private async finalize(tx: Tx, order: FullOrder, user: AuthUser) {
    const approved = await tx.priceAdjustment.findMany({
      where: { orderId: order.id, status: 'APPROVED' },
    });
    const weightApproved = approved.some((a) => a.type === 'WEIGHT_ADJUSTMENT');
    const others = approved
      .filter((a) => a.type !== 'WEIGHT_ADJUSTMENT')
      .reduce((s, a) => s.add(a.amountDifference), new D(0));

    let data: Prisma.OrderUpdateInput;
    let baseTotal = new D(order.total);
    if (weightApproved) {
      const weight = await tx.weightMeasurement.findFirstOrThrow({
        where: { orderId: order.id },
        orderBy: { createdAt: 'desc' },
      });
      const p = await this.recompute(order, weight.weightGrams);
      baseTotal = p.total;
      data = {
        itemsSubtotal: p.itemsSubtotal,
        extrasTotal: p.extrasTotal,
        membershipDiscount: p.membershipDiscount,
        discount: p.discount,
        tax: p.tax,
      };
    } else {
      data = {};
    }
    const total = baseTotal.add(others);

    await tx.order.update({
      where: { id: order.id },
      data: { ...data, total, pricingStatus: 'FINAL' },
    });

    // Conciliación con lo ya pagado.
    await this.wallet.lockCustomer(tx, order.customerId);
    const paid = await this.orders.paidAmount(tx, order.id);
    const outstanding = total.sub(paid);
    if (outstanding.lt(0)) {
      await this.wallet.post(tx, {
        customerId: order.customerId,
        orderId: order.id,
        type: 'REFUND',
        amount: outstanding.neg(),
        reference: `ORDER:${order.number}:ADJUSTMENT_REFUND`,
        description: 'Devolución por precio final menor al pagado',
        idempotencyKey: `order-adjust-refund:${order.id}`,
      });
    } else if (outstanding.gt(0)) {
      await tx.order.update({
        where: { id: order.id },
        data: { paymentStatus: 'PENDING' },
      });
    }
    await this.orders.applyTransition(tx, order, 'IN_PROCESS', user, 'Precio final fijado');
  }

  // ---- Utilidades

  // Recalcula un pedido por peso con las condiciones congeladas al crearlo.
  private async recompute(order: FullOrder, weightGrams: number) {
    const policy = await this.prisma.businessPolicy.findUniqueOrThrow({
      where: { version: order.policyVersion },
    });
    const promotion = order.promotionId
      ? await this.prisma.promotion.findUnique({ where: { id: order.promotionId } })
      : null;
    const items = new D(order.itemsSubtotal);
    const membershipPercent = items.gt(0)
      ? new D(order.membershipDiscount).div(items).mul(100)
      : new D(0);
    return computePricing({
      items: [],
      weightLb: new D(weightGrams).div(GRAMS_PER_POUND).toDecimalPlaces(2, D.ROUND_HALF_UP),
      pricePerPound: new D(order.pricePerPound!),
      extras: order.extras.map((e) => new D(e.price)),
      membershipPercent,
      promotion: promotion
        ? { type: promotion.discountType, value: new D(promotion.discountValue) }
        : null,
      logisticsFee: new D(order.logisticsFee),
      taxRate: new D(policy.taxRate!),
      taxIncluded: policy.taxIncluded!,
    });
  }

  private async staffOrder(
    user: AuthUser,
    orderId: string,
    expectedVersion: number,
    allowed: FullOrder['status'][],
  ) {
    const order = await this.orders.forUser(user, orderId);
    if (!isStaff(user)) throw new ForbiddenException('Solo el personal de la sede puede hacerlo.');
    if (order.version !== expectedVersion)
      throw new ConflictException(
        `El pedido cambió (versión ${order.version}); recárgalo e intenta de nuevo.`,
      );
    if (!allowed.includes(order.status))
      throw new ConflictException(
        `Esta acción requiere el pedido en ${allowed.join(' o ')} (actual: ${order.status}).`,
      );
    return order;
  }

  private async bump(tx: Tx, order: FullOrder, actor: AuthUser, title: string) {
    const { count } = await tx.order.updateMany({
      where: { id: order.id, version: order.version },
      data: { version: { increment: 1 } },
    });
    if (!count) throw new ConflictException('El pedido cambió; recárgalo e intenta de nuevo.');
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        status: order.status,
        title,
        actorId: actor.id,
        actorRole: actor.role,
      },
    });
  }
}
