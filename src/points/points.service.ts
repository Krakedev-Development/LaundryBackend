import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { CustomersService } from '../customers/customers.service';
import { Prisma } from '../generated/prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';

type Tx = Prisma.TransactionClient;
const isStaff = (u: AuthUser) => u.role === 'ADMIN' || u.role === 'SUPERVISOR';

@Injectable()
export class PointsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly notifications: NotificationsService,
    private readonly wallet: WalletService,
  ) {}

  async balance(db: Pick<PrismaService, 'pointsLedgerEntry'> | Tx, customerId: string) {
    const { _sum } = await db.pointsLedgerEntry.aggregate({
      where: { customerId },
      _sum: { points: true },
    });
    return _sum.points ?? 0;
  }

  // Suma puntos al completarse un pedido, con la política congelada al crearlo. Sin tasa
  // configurada (programa de puntos no definido) no se acumula nada. Es idempotente por pedido.
  async accrueForOrder(
    tx: Tx,
    order: { id: string; customerId: string; total: Prisma.Decimal; policyVersion: number },
  ) {
    const policy = await tx.businessPolicy.findUnique({
      where: { version: order.policyVersion },
    });
    const rate = policy?.pointsPerCurrencyUnit;
    if (!rate) return 0;
    if (await tx.pointsLedgerEntry.count({ where: { orderId: order.id, reason: 'ORDER_COMPLETED' } }))
      return 0;
    const points = Math.floor(order.total.mul(rate).toNumber());
    if (points <= 0) return 0;
    await tx.pointsLedgerEntry.create({
      data: {
        customerId: order.customerId,
        orderId: order.id,
        points,
        reason: 'ORDER_COMPLETED',
      },
    });
    await this.notifications.notify(tx, order.customerId, {
      orderId: order.id,
      category: 'POINTS',
      title: 'Sumaste puntos',
      body: `Ganaste ${points} puntos por tu pedido.`,
    });
    return points;
  }

  // ---- Cliente

  async mine(user: AuthUser) {
    const customer = await this.customers.customerOf(user);
    const [balance, entries] = await Promise.all([
      this.balance(this.prisma, customer.id),
      this.prisma.pointsLedgerEntry.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);
    return { balance, entries };
  }

  // Reserva los puntos al solicitar; si el personal rechaza, se devuelven.
  async redeem(user: AuthUser, rewardId: string) {
    const customer = await this.customers.customerOf(user);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${customer.id}::uuid FOR UPDATE`;
      const reward = await tx.reward.findUnique({ where: { id: rewardId } });
      if (!reward || !reward.active) throw new NotFoundException('La recompensa no existe.');
      if ((await this.balance(tx, customer.id)) < reward.pointsCost)
        throw new ConflictException('No tienes puntos suficientes.');
      const redemption = await tx.rewardRedemption.create({
        data: { customerId: customer.id, rewardId, pointsCost: reward.pointsCost },
      });
      await tx.pointsLedgerEntry.create({
        data: {
          customerId: customer.id,
          points: -reward.pointsCost,
          reason: `REDEMPTION:${redemption.id}`,
        },
      });
      return redemption;
    });
  }

  async redemptions(user: AuthUser, status?: string) {
    const parsed = status as 'PENDING' | 'APPROVED' | 'REJECTED' | undefined;
    if (parsed && !['PENDING', 'APPROVED', 'REJECTED'].includes(parsed))
      throw new BadRequestException('Estado desconocido.');
    if (isStaff(user))
      return this.prisma.rewardRedemption.findMany({
        where: parsed ? { status: parsed } : {},
        include: {
          reward: { select: { title: true, fulfillmentType: true } },
          customer: { select: { id: true, user: { select: { name: true, email: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
    const customer = await this.customers.customerOf(user);
    return this.prisma.rewardRedemption.findMany({
      where: { customerId: customer.id, ...(parsed ? { status: parsed } : {}) },
      include: { reward: { select: { title: true, fulfillmentType: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ---- Personal

  async customerLedger(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('El cliente no existe.');

    const [balance, entries] = await Promise.all([
      this.balance(this.prisma, customerId),
      this.prisma.pointsLedgerEntry.findMany({
        where: { customerId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);

    const actorIds = [
      ...new Set(entries.map((e) => e.actorId).filter((id): id is string => Boolean(id))),
    ];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true },
        })
      : [];
    const actorNameById = new Map(actors.map((a) => [a.id, a.name]));

    return {
      customerId,
      balance,
      entries: entries.map((e) => ({
        ...e,
        actorName: e.actorId ? (actorNameById.get(e.actorId) ?? null) : null,
      })),
    };
  }

  async adjust(
    actor: AuthUser,
    dto: { customerId: string; points: number; reason: string },
  ) {
    if (dto.points === 0) {
      throw new BadRequestException('El ajuste de puntos debe ser distinto de cero.');
    }
    const note = dto.reason.trim();
    if (!note) {
      throw new BadRequestException('Indica el motivo del ajuste de puntos.');
    }

    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({
        where: { id: dto.customerId },
        select: { id: true },
      });
      if (!customer) throw new NotFoundException('El cliente no existe.');

      await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${dto.customerId}::uuid FOR UPDATE`;
      const currentBalance = await this.balance(tx, dto.customerId);
      if (currentBalance + dto.points < 0) {
        throw new ConflictException(
          'El ajuste dejaría al cliente con saldo de puntos negativo.',
        );
      }

      const entry = await tx.pointsLedgerEntry.create({
        data: {
          customerId: dto.customerId,
          actorId: actor.id,
          points: dto.points,
          reason: 'ADMIN_ADJUSTMENT',
          note,
        },
      });
      const nextBalance = currentBalance + dto.points;

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: 'POINTS_MANUAL_ADJUSTMENT',
          entity: 'Customer',
          entityId: dto.customerId,
          reason: note,
          before: { balance: currentBalance },
          after: { balance: nextBalance, delta: dto.points, entryId: entry.id },
        },
      });

      await this.notifications.notify(tx, dto.customerId, {
        category: 'POINTS',
        title: dto.points > 0 ? 'Puntos acreditados' : 'Ajuste de puntos',
        body:
          dto.points > 0
            ? `Se acreditaron ${dto.points} puntos a tu cuenta (${note}).`
            : `Se ajustaron ${dto.points} puntos en tu cuenta (${note}).`,
      });

      const actorUser = await tx.user.findUnique({
        where: { id: actor.id },
        select: { name: true },
      });

      return {
        entry: { ...entry, actorName: actorUser?.name ?? null },
        balance: nextBalance,
      };
    });
  }

  async review(
    actor: AuthUser,
    id: string,
    dto: { approve: boolean; reason?: string },
  ) {
    if (!dto.approve && !dto.reason?.trim())
      throw new BadRequestException('Indica el motivo del rechazo.');
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.rewardRedemption.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: dto.approve ? 'APPROVED' : 'REJECTED',
          reviewedById: actor.id,
          reviewedAt: now,
          reviewReason: dto.reason?.trim(),
        },
      });
      if (!count) throw new ConflictException('La solicitud no existe o ya fue revisada.');

      let redemption = await tx.rewardRedemption.findUniqueOrThrow({
        where: { id },
        include: {
          reward: true,
          customer: { select: { id: true, user: { select: { name: true, email: true } } } },
        },
      });

      let notificationBody = dto.approve
        ? `Tu canje de "${redemption.reward.title}" fue aprobado.`
        : `Tu canje de "${redemption.reward.title}" fue rechazado y recuperaste tus puntos.`;

      if (!dto.approve) {
        await tx.pointsLedgerEntry.create({
          data: {
            customerId: redemption.customerId,
            points: redemption.pointsCost,
            reason: `REDEMPTION_REVERSED:${id}`,
          },
        });
      } else if (
        redemption.reward.fulfillmentType === 'WALLET_CREDIT' &&
        redemption.reward.walletCreditAmount
      ) {
        await this.wallet.lockCustomer(tx, redemption.customerId);
        const creditAmount = new Prisma.Decimal(redemption.reward.walletCreditAmount);
        const ledgerEntry = await this.wallet.post(tx, {
          customerId: redemption.customerId,
          type: 'CREDIT',
          amount: creditAmount,
          reference: `REWARD:${redemption.id}`,
          description: `Crédito por canje: ${redemption.reward.title}`,
          idempotencyKey: `redemption-credit:${redemption.id}`,
        });
        redemption = await tx.rewardRedemption.update({
          where: { id },
          data: {
            walletCreditAmount: creditAmount,
            ledgerEntryId: ledgerEntry.id,
          },
          include: {
            reward: true,
            customer: { select: { id: true, user: { select: { name: true, email: true } } } },
          },
        });
        notificationBody = `Tu canje de "${redemption.reward.title}" fue aprobado y acreditamos $${creditAmount.toFixed(2)} a tu billetera.`;
      } else if (
        redemption.reward.fulfillmentType === 'PROMO_COUPON' &&
        redemption.reward.couponDiscountType &&
        redemption.reward.couponDiscountValue
      ) {
        const code = `CANJE-${randomBytes(4).toString('hex').toUpperCase()}`;
        const validUntil = new Date(
          now.getTime() + (redemption.reward.couponValidityDays ?? 30) * 86_400_000,
        );
        const promo = await tx.promotion.create({
          data: {
            code,
            name: `Cupón: ${redemption.reward.title}`,
            description:
              redemption.reward.description ||
              `Cupón personal generado por canje de ${redemption.reward.title}`,
            discountType: redemption.reward.couponDiscountType,
            discountValue: redemption.reward.couponDiscountValue,
            minOrderAmount: redemption.reward.couponMinOrderAmount ?? null,
            validFrom: now,
            validUntil,
            maxUses: 1,
            maxUsesPerCustomer: 1,
            customerId: redemption.customerId,
            active: true,
          },
        });
        redemption = await tx.rewardRedemption.update({
          where: { id },
          data: {
            generatedPromotionId: promo.id,
            generatedPromoCode: promo.code,
          },
          include: {
            reward: true,
            customer: { select: { id: true, user: { select: { name: true, email: true } } } },
          },
        });
        notificationBody = `Tu canje de "${redemption.reward.title}" fue aprobado. Usa tu cupón personal ${promo.code}.`;
      }

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: dto.approve ? 'REDEMPTION_APPROVED' : 'REDEMPTION_REJECTED',
          entity: 'RewardRedemption',
          entityId: id,
          reason: dto.reason?.trim(),
          after: dto.approve
            ? {
                generatedPromoCode: redemption.generatedPromoCode,
                walletCreditAmount: redemption.walletCreditAmount?.toString() ?? null,
              }
            : undefined,
        },
      });
      await this.notifications.notify(tx, redemption.customerId, {
        category: 'REDEMPTION',
        title: dto.approve ? 'Canje aprobado' : 'Canje rechazado',
        body: notificationBody,
      });
      return redemption;
    });
  }
}
