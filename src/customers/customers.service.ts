import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import type {
  AdminSetMembershipDto,
  CreateAddressDto,
  UpdateAddressDto,
} from './dto/customers.dto';
import {
  currentWeekStart,
  effectiveMembershipStatus,
  isMembershipActive,
  membershipPeriodDays,
} from './membership.util';

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => WalletService))
    private readonly wallet: WalletService,
  ) {}

  async customerOf(user: AuthUser) {
    const customer = await this.prisma.customer.findUnique({
      where: { userId: user.id },
    });
    if (!customer) throw new ForbiddenException('La cuenta no es de un cliente.');
    return customer;
  }

  async profile(user: AuthUser) {
    const customer = await this.customerOf(user);
    const active = isMembershipActive(customer);
    return {
      id: customer.id,
      kycStatus: customer.kycStatus,
      membershipPlanId: active ? customer.membershipPlanId : null,
      membershipStatus: effectiveMembershipStatus(customer),
      membershipStartedAt: customer.membershipStartedAt,
      membershipExpiresAt: customer.membershipExpiresAt,
    };
  }

  private async activeTimezone(): Promise<string> {
    const policy = await this.prisma.businessPolicy.findFirst({
      where: { active: true },
      select: { timezone: true },
    });
    return policy?.timezone ?? 'UTC';
  }

  async getMyMembership(user: AuthUser) {
    const now = new Date();
    const customer = await this.prisma.customer.findUnique({
      where: { userId: user.id },
      include: {
        membershipPlan: true,
        membershipSubscriptions: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { plan: { select: { id: true, name: true } } },
        },
      },
    });
    if (!customer) throw new ForbiddenException('La cuenta no es de un cliente.');

    const active = isMembershipActive(customer, now);
    const status = effectiveMembershipStatus(customer, now);
    const timezone = await this.activeTimezone();
    const weekStart = currentWeekStart(timezone, now);

    const [weeklyPickupsUsed, walletBalance] = await Promise.all([
      this.prisma.order.count({
        where: {
          customerId: customer.id,
          freeLogisticsApplied: true,
          status: { not: 'CANCELLED' },
          createdAt: { gte: weekStart },
        },
      }),
      this.wallet.balance(this.prisma, customer.id),
    ]);

    return {
      membershipPlan: active ? customer.membershipPlan : null,
      status,
      startedAt: customer.membershipStartedAt,
      expiresAt: customer.membershipExpiresAt,
      weeklyPickupsUsed,
      weeklyPickupsLimit: active ? (customer.membershipPlan?.weeklyPickups ?? null) : null,
      walletBalance: walletBalance.toString(),
      history: customer.membershipSubscriptions.map((s) => ({
        id: s.id,
        planId: s.planId,
        planName: s.plan.name,
        status: s.status,
        priceCharged: s.priceCharged.toString(),
        startedAt: s.startedAt,
        expiresAt: s.expiresAt,
        cancelledAt: s.cancelledAt,
        notes: s.notes,
        createdAt: s.createdAt,
      })),
    };
  }

  // El cliente activa un plan pagando desde su billetera; genera vigencia y registro de suscripción.
  async setMembership(user: AuthUser, planId: string) {
    const customer = await this.customerOf(user);
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      await this.wallet.lockCustomer(tx, customer.id);
      const fresh = await tx.customer.findUniqueOrThrow({
        where: { id: customer.id },
      });
      const plan = await tx.membershipPlan.findFirst({
        where: { id: planId, active: true },
      });
      if (!plan) throw new NotFoundException('El plan no existe o no está disponible.');

      if (fresh.membershipPlanId === plan.id && isMembershipActive(fresh, now)) {
        throw new ConflictException('Ya tienes activa esta membresía.');
      }

      const price = new Prisma.Decimal(plan.priceMonthly);
      if (price.gt(0)) {
        const balance = await this.wallet.balance(tx, customer.id);
        if (balance.lt(price)) {
          throw new ConflictException(
            'Saldo insuficiente en la billetera para activar esta membresía.',
          );
        }
        await this.wallet.post(tx, {
          customerId: customer.id,
          type: 'DEBIT',
          amount: price.neg(),
          reference: `MEMBERSHIP:${plan.name}`,
          description: `Suscripción membresía ${plan.name}`,
        });
      }

      await tx.membershipSubscription.updateMany({
        where: { customerId: customer.id, status: 'ACTIVE' },
        data: { status: 'CANCELLED', cancelledAt: now },
      });

      const expiresAt = new Date(
        now.getTime() + membershipPeriodDays(plan.interval) * 86_400_000,
      );
      await tx.membershipSubscription.create({
        data: {
          customerId: customer.id,
          planId: plan.id,
          status: 'ACTIVE',
          priceCharged: price,
          startedAt: now,
          expiresAt,
        },
      });

      await tx.customer.update({
        where: { id: customer.id },
        data: {
          membershipPlanId: plan.id,
          membershipStartedAt: now,
          membershipExpiresAt: expiresAt,
          membershipStatus: 'ACTIVE',
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          action: 'MEMBERSHIP_SUBSCRIBED',
          entity: 'Customer',
          entityId: customer.id,
          after: {
            planId: plan.id,
            planName: plan.name,
            priceCharged: price.toString(),
            expiresAt: expiresAt.toISOString(),
          },
        },
      });

      const walletBalance = await this.wallet.balance(tx, customer.id);
      return {
        membershipPlan: {
          id: plan.id,
          name: plan.name,
          priceMonthly: plan.priceMonthly,
          interval: plan.interval,
          weeklyPickups: plan.weeklyPickups,
          garmentDiscountPercent: plan.garmentDiscountPercent,
          priorityService: plan.priorityService,
        },
        status: 'ACTIVE' as const,
        startedAt: now,
        expiresAt,
        priceCharged: price.toString(),
        walletBalance: walletBalance.toString(),
      };
    });
  }

  async cancelMembership(user: AuthUser) {
    const customer = await this.customerOf(user);
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      await this.wallet.lockCustomer(tx, customer.id);
      const fresh = await tx.customer.findUniqueOrThrow({
        where: { id: customer.id },
      });
      if (!isMembershipActive(fresh, now)) {
        throw new ConflictException('No tienes una membresía activa.');
      }

      await tx.membershipSubscription.updateMany({
        where: { customerId: customer.id, status: 'ACTIVE' },
        data: { status: 'CANCELLED', cancelledAt: now },
      });
      await tx.customer.update({
        where: { id: customer.id },
        data: {
          membershipPlanId: null,
          membershipStatus: 'CANCELLED',
          membershipExpiresAt: null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          action: 'MEMBERSHIP_CANCELLED',
          entity: 'Customer',
          entityId: customer.id,
          before: { planId: fresh.membershipPlanId },
        },
      });
      return { membershipPlan: null, status: 'CANCELLED' as const };
    });
  }

  async adminSetMembership(
    actor: AuthUser,
    customerId: string,
    dto: AdminSetMembershipDto,
  ) {
    const existing = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!existing) throw new NotFoundException('El cliente no existe.');

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await this.wallet.lockCustomer(tx, customerId);
      await tx.membershipSubscription.updateMany({
        where: { customerId, status: 'ACTIVE' },
        data: { status: 'CANCELLED', cancelledAt: now },
      });

      if (!dto.planId) {
        const updated = await tx.customer.update({
          where: { id: customerId },
          data: {
            membershipPlanId: null,
            membershipStatus: 'CANCELLED',
            membershipExpiresAt: null,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'ADMIN_MEMBERSHIP_CANCELLED',
            entity: 'Customer',
            entityId: customerId,
            reason: dto.reason?.trim(),
            before: { planId: existing.membershipPlanId },
          },
        });
        return {
          customerId,
          membershipPlan: null,
          membershipStatus: updated.membershipStatus,
          membershipStartedAt: updated.membershipStartedAt,
          membershipExpiresAt: updated.membershipExpiresAt,
        };
      }

      const plan = await tx.membershipPlan.findFirst({
        where: { id: dto.planId, active: true },
        select: { id: true, name: true, interval: true },
      });
      if (!plan) throw new NotFoundException('El plan no existe o no está disponible.');

      const expiresAt = new Date(
        now.getTime() + membershipPeriodDays(plan.interval) * 86_400_000,
      );
      await tx.membershipSubscription.create({
        data: {
          customerId,
          planId: plan.id,
          status: 'ACTIVE',
          priceCharged: new Prisma.Decimal(0),
          startedAt: now,
          expiresAt,
          assignedById: actor.id,
          notes: dto.reason?.trim() || 'Asignación administrativa',
        },
      });
      const updated = await tx.customer.update({
        where: { id: customerId },
        data: {
          membershipPlanId: plan.id,
          membershipStartedAt: now,
          membershipExpiresAt: expiresAt,
          membershipStatus: 'ACTIVE',
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: 'ADMIN_MEMBERSHIP_ASSIGNED',
          entity: 'Customer',
          entityId: customerId,
          reason: dto.reason?.trim(),
          before: { planId: existing.membershipPlanId },
          after: { planId: plan.id, planName: plan.name, expiresAt: expiresAt.toISOString() },
        },
      });

      return {
        customerId,
        membershipPlan: { id: plan.id, name: plan.name },
        membershipStatus: updated.membershipStatus,
        membershipStartedAt: updated.membershipStartedAt,
        membershipExpiresAt: updated.membershipExpiresAt,
      };
    });
  }

  // Directorio del administrador: clientes con identidad aprobada.
  async directory() {
    const now = new Date();
    const customers = await this.prisma.customer.findMany({
      // Solo clientes con identidad aprobada; las solicitudes pendientes se revisan en KYC.
      where: { kycStatus: 'APPROVED' },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { name: true, email: true, phone: true } },
        membershipPlan: { select: { id: true, name: true } },
        addresses: {
          where: { deletedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          select: { title: true, fullAddress: true, reference: true },
        },
        _count: { select: { orders: true } },
      },
    });
    const ids = customers.map((c) => c.id);
    const balances = ids.length
      ? await this.prisma.ledgerEntry.groupBy({
          by: ['customerId'],
          where: { customerId: { in: ids } },
          _sum: { amount: true },
        })
      : [];
    const balanceByCustomer = new Map(
      balances.map((b) => [b.customerId, Number(b._sum.amount ?? 0)]),
    );

    return customers.map((c) => {
      const active = isMembershipActive(c, now);
      return {
        id: c.id,
        name: c.user.name,
        email: c.user.email,
        phone: c.user.phone,
        kycStatus: c.kycStatus,
        membershipPlan: active ? c.membershipPlan : null,
        membershipStatus: effectiveMembershipStatus(c, now),
        membershipStartedAt: c.membershipStartedAt,
        membershipExpiresAt: c.membershipExpiresAt,
        walletBalance: balanceByCustomer.get(c.id) ?? 0,
        kycDocumentType: c.kycDocumentType,
        kycDocumentNumber: c.kycDocumentNumber,
        kycRejectionReason: c.kycRejectionReason,
        kycReviewedAt: c.kycReviewedAt,
        addresses: c.addresses,
        totalOrders: c._count.orders,
        createdAt: c.createdAt,
      };
    });
  }

  async listAddresses(user: AuthUser) {
    const customer = await this.customerOf(user);
    return this.prisma.address.findMany({
      where: { customerId: customer.id, deletedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async createAddress(user: AuthUser, dto: CreateAddressDto) {
    const customer = await this.customerOf(user);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.address.count({
        where: { customerId: customer.id, deletedAt: null },
      });
      // La primera dirección es siempre la principal.
      const isPrimary = existing === 0 ? true : !!dto.isPrimary;
      if (isPrimary)
        await tx.address.updateMany({
          where: { customerId: customer.id, isPrimary: true },
          data: { isPrimary: false },
        });
      return tx.address.create({
        data: { ...dto, isPrimary, customerId: customer.id },
      });
    });
  }

  async updateAddress(user: AuthUser, id: string, dto: UpdateAddressDto) {
    const customer = await this.customerOf(user);
    await this.addressOrFail(customer.id, id);
    return this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary)
        await tx.address.updateMany({
          where: { customerId: customer.id, isPrimary: true },
          data: { isPrimary: false },
        });
      // No se puede dejar al cliente sin dirección principal desmarcándola.
      const { isPrimary, ...rest } = dto;
      return tx.address.update({
        where: { id },
        data: { ...rest, ...(isPrimary ? { isPrimary: true } : {}) },
      });
    });
  }

  // Borrado lógico: los pedidos conservan su propia copia de la dirección.
  async deleteAddress(user: AuthUser, id: string) {
    const customer = await this.customerOf(user);
    const address = await this.addressOrFail(customer.id, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.address.update({
        where: { id },
        data: { deletedAt: new Date(), isPrimary: false },
      });
      if (address.isPrimary) {
        const next = await tx.address.findFirst({
          where: { customerId: customer.id, deletedAt: null },
          orderBy: { createdAt: 'asc' },
        });
        if (next)
          await tx.address.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
    });
  }

  private async addressOrFail(customerId: string, id: string) {
    const address = await this.prisma.address.findFirst({
      where: { id, customerId, deletedAt: null },
    });
    if (!address) throw new NotFoundException('La dirección no existe.');
    return address;
  }
}
