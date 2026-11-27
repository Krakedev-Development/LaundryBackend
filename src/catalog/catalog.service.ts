import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { currentWeekStart, effectiveMembershipStatus } from '../customers/membership.util';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreatePromotionDto,
  CreateRewardDto,
  UpdatePromotionDto,
  UpdateRewardDto,
  ValidatePromotionDto,
} from './dto/catalog.dto';

// Delegado mínimo común a los modelos de catálogo.
interface CatalogDelegate {
  findMany(args: object): Promise<unknown[]>;
  findUnique(args: object): Promise<unknown>;
  create(args: object): Promise<{ id: string }>;
  update(args: object): Promise<{ id: string }>;
}

export type CatalogResource =
  | 'garmentType'
  | 'serviceType'
  | 'extra'
  | 'membershipPlan'
  | 'reward'
  | 'weightTier'
  | 'weightRestriction';

const LABELS: Record<CatalogResource, string> = {
  garmentType: 'La prenda',
  serviceType: 'El servicio',
  extra: 'El extra',
  membershipPlan: 'El plan',
  reward: 'La recompensa',
  weightTier: 'La bolsa',
  weightRestriction: 'La restricción',
};

// Bolsas y restricciones se muestran en el orden que define el administrador.
const ORDER: Partial<Record<CatalogResource, object[]>> = {
  weightTier: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  weightRestriction: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
};

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  private delegate(resource: CatalogResource): CatalogDelegate {
    return this.prisma[resource] as unknown as CatalogDelegate;
  }

  list(resource: CatalogResource, includeInactive: boolean) {
    return this.delegate(resource).findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: ORDER[resource] ?? { createdAt: 'asc' },
    });
  }

  async listMemberships(includeInactive: boolean) {
    const now = new Date();
    const plans = await this.prisma.membershipPlan.findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!plans.length) return [];
    const counts = await this.prisma.customer.groupBy({
      by: ['membershipPlanId'],
      where: {
        membershipPlanId: { in: plans.map((p) => p.id) },
        AND: [
          { OR: [{ membershipStatus: null }, { membershipStatus: 'ACTIVE' }] },
          { OR: [{ membershipExpiresAt: null }, { membershipExpiresAt: { gt: now } }] },
        ],
      },
      _count: { _all: true },
    });
    const countByPlan = new Map(
      counts
        .filter((c) => c.membershipPlanId)
        .map((c) => [c.membershipPlanId!, c._count._all]),
    );
    return plans.map((plan) => ({
      ...plan,
      activeSubscribersCount: countByPlan.get(plan.id) ?? 0,
    }));
  }

  async listMembershipSubscribers(planId: string) {
    const plan = await this.prisma.membershipPlan.findUnique({
      where: { id: planId },
      select: { id: true, name: true, weeklyPickups: true },
    });
    if (!plan) throw new NotFoundException('El plan no existe.');

    const now = new Date();
    const policy = await this.prisma.businessPolicy.findFirst({
      where: { active: true },
      select: { timezone: true },
    });
    const weekStart = currentWeekStart(policy?.timezone ?? 'UTC', now);

    const customers = await this.prisma.customer.findMany({
      where: {
        membershipPlanId: plan.id,
        AND: [
          { OR: [{ membershipStatus: null }, { membershipStatus: 'ACTIVE' }] },
          { OR: [{ membershipExpiresAt: null }, { membershipExpiresAt: { gt: now } }] },
        ],
      },
      orderBy: { membershipStartedAt: 'desc' },
      include: {
        user: { select: { name: true, email: true, phone: true } },
      },
    });

    const customerIds = customers.map((c) => c.id);
    const weeklyOrders = customerIds.length
      ? await this.prisma.order.groupBy({
          by: ['customerId'],
          where: {
            customerId: { in: customerIds },
            freeLogisticsApplied: true,
            status: { not: 'CANCELLED' },
            createdAt: { gte: weekStart },
          },
          _count: { _all: true },
        })
      : [];
    const usedByCustomer = new Map(weeklyOrders.map((o) => [o.customerId, o._count._all]));

    return customers.map((c) => ({
      customerId: c.id,
      name: c.user.name,
      email: c.user.email,
      phone: c.user.phone,
      startedAt: c.membershipStartedAt,
      expiresAt: c.membershipExpiresAt,
      status: effectiveMembershipStatus(c, now) ?? 'ACTIVE',
      weeklyPickupsUsed: usedByCustomer.get(c.id) ?? 0,
      weeklyPickupsLimit: plan.weeklyPickups,
    }));
  }

  async get(resource: CatalogResource, id: string) {
    const row = await this.delegate(resource).findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`${LABELS[resource]} no existe.`);
    return row;
  }

  create(
    actor: AuthUser,
    resource: CatalogResource,
    data: Record<string, unknown>,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const row = await (tx[resource] as unknown as CatalogDelegate)
        .create({ data: this.clean(data) })
        .catch((e) => this.mapUnique(e));
      await this.audit(tx, actor, `${resource}.created`, row.id);
      return row;
    });
  }

  async update(
    actor: AuthUser,
    resource: CatalogResource,
    id: string,
    data: Record<string, unknown>,
  ) {
    await this.get(resource, id);
    return this.prisma.$transaction(async (tx) => {
      const row = await (tx[resource] as unknown as CatalogDelegate)
        .update({ where: { id }, data: this.clean(data) })
        .catch((e) => this.mapUnique(e));
      await this.audit(tx, actor, `${resource}.updated`, id);
      return row;
    });
  }

  // ---- Recompensas

  createReward(actor: AuthUser, dto: CreateRewardDto) {
    this.assertRewardFulfillment(dto);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.reward.create({
        data: this.clean({ ...dto }) as Prisma.RewardCreateInput,
      });
      await this.audit(tx, actor, 'reward.created', row.id);
      return row;
    });
  }

  async updateReward(actor: AuthUser, id: string, dto: UpdateRewardDto) {
    const current = await this.prisma.reward.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('La recompensa no existe.');
    this.assertRewardFulfillment({
      fulfillmentType: dto.fulfillmentType ?? current.fulfillmentType,
      walletCreditAmount:
        dto.walletCreditAmount !== undefined
          ? dto.walletCreditAmount
          : current.walletCreditAmount,
      couponDiscountType:
        dto.couponDiscountType !== undefined
          ? dto.couponDiscountType
          : current.couponDiscountType,
      couponDiscountValue:
        dto.couponDiscountValue !== undefined
          ? dto.couponDiscountValue
          : current.couponDiscountValue,
    });
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.reward.update({
        where: { id },
        data: this.clean({ ...dto }) as Prisma.RewardUpdateInput,
      });
      await this.audit(tx, actor, 'reward.updated', id);
      return row;
    });
  }

  private assertRewardFulfillment(input: {
    fulfillmentType?: 'NONE' | 'WALLET_CREDIT' | 'PROMO_COUPON' | null;
    walletCreditAmount?: number | Prisma.Decimal | null;
    couponDiscountType?: 'PERCENTAGE' | 'FIXED' | null;
    couponDiscountValue?: number | Prisma.Decimal | null;
  }) {
    const mode = input.fulfillmentType ?? 'NONE';
    if (mode === 'WALLET_CREDIT') {
      const amt = Number(input.walletCreditAmount ?? 0);
      if (!Number.isFinite(amt) || amt <= 0) {
        throw new BadRequestException(
          'Indica un monto de crédito en billetera mayor a cero.',
        );
      }
    } else if (mode === 'PROMO_COUPON') {
      if (!input.couponDiscountType) {
        throw new BadRequestException(
          'Indica el tipo de descuento del cupón generado.',
        );
      }
      const val = Number(input.couponDiscountValue ?? 0);
      if (!Number.isFinite(val) || val <= 0) {
        throw new BadRequestException(
          'El valor de descuento del cupón debe ser mayor a cero.',
        );
      }
      if (input.couponDiscountType === 'PERCENTAGE' && val > 100) {
        throw new BadRequestException('Un descuento porcentual no supera 100.');
      }
    }
  }

  // ---- Promociones

  async listPromotions(user?: AuthUser) {
    const isStaff = user?.role === 'ADMIN' || user?.role === 'SUPERVISOR';
    if (isStaff) {
      const promos = await this.prisma.promotion.findMany({
        orderBy: { createdAt: 'desc' },
      });
      const ids = promos.map((p) => p.id);
      const usages = ids.length
        ? await this.prisma.order.groupBy({
            by: ['promotionId'],
            where: { promotionId: { in: ids }, status: { not: 'CANCELLED' } },
            _count: { _all: true },
          })
        : [];
      const usedById = new Map(
        usages
          .filter((u) => u.promotionId)
          .map((u) => [u.promotionId!, u._count._all]),
      );
      return promos.map((p) => ({
        ...p,
        usedCount: usedById.get(p.id) ?? 0,
        isPersonal: Boolean(p.customerId),
      }));
    }

    const now = new Date();
    const customer =
      user?.role === 'CLIENT'
        ? await this.prisma.customer.findUnique({
            where: { userId: user.id },
            select: { id: true },
          })
        : null;

    const promos = await this.prisma.promotion.findMany({
      where: {
        active: true,
        AND: [
          { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
          { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
          {
            OR: [
              { customerId: null },
              ...(customer ? [{ customerId: customer.id }] : []),
            ],
          },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!promos.length) return [];

    const ids = promos.map((p) => p.id);
    const [globalUsages, customerUsages, customerOrderCount] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['promotionId'],
        where: { promotionId: { in: ids }, status: { not: 'CANCELLED' } },
        _count: { _all: true },
      }),
      customer
        ? this.prisma.order.groupBy({
            by: ['promotionId'],
            where: {
              customerId: customer.id,
              promotionId: { in: ids },
              status: { not: 'CANCELLED' },
            },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      customer
        ? this.prisma.order.count({
            where: { customerId: customer.id, status: { not: 'CANCELLED' } },
          })
        : Promise.resolve(0),
    ]);

    const globalMap = new Map(
      globalUsages
        .filter((u) => u.promotionId)
        .map((u) => [u.promotionId!, u._count._all]),
    );
    const customerMap = new Map(
      customerUsages
        .filter((u) => u.promotionId)
        .map((u) => [u.promotionId!, u._count._all]),
    );

    return promos
      .filter((p) => {
        const gUsed = globalMap.get(p.id) ?? 0;
        if (p.maxUses != null && gUsed >= p.maxUses) return false;
        if (customer) {
          const cUsed = customerMap.get(p.id) ?? 0;
          if (p.maxUsesPerCustomer != null && cUsed >= p.maxUsesPerCustomer)
            return false;
          if (p.firstOrderOnly && customerOrderCount > 0) return false;
        }
        return true;
      })
      .map((p) => ({
        ...p,
        usedCount: globalMap.get(p.id) ?? 0,
        isPersonal: Boolean(p.customerId),
      }));
  }

  async validatePromotion(user: AuthUser, dto: ValidatePromotionDto) {
    const customer = await this.prisma.customer.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!customer) throw new ForbiddenException('La cuenta no es de un cliente.');

    const code = dto.code.trim().toUpperCase();
    const promo = await this.prisma.promotion.findUnique({ where: { code } });
    if (!promo || !promo.active || (promo.customerId && promo.customerId !== customer.id)) {
      throw new NotFoundException('La promoción no existe.');
    }

    const now = new Date();
    const inWindow =
      (!promo.validFrom || promo.validFrom <= now) &&
      (!promo.validUntil || promo.validUntil >= now);
    if (!inWindow) {
      throw new UnprocessableEntityException('La promoción no está vigente.');
    }

    if (promo.firstOrderOnly) {
      const priorOrders = await this.prisma.order.count({
        where: { customerId: customer.id, status: { not: 'CANCELLED' } },
      });
      if (priorOrders > 0) {
        throw new UnprocessableEntityException(
          'Esta promoción aplica únicamente para tu primera orden.',
        );
      }
    }

    if (promo.maxUses != null) {
      const used = await this.prisma.order.count({
        where: { promotionId: promo.id, status: { not: 'CANCELLED' } },
      });
      if (used >= promo.maxUses) {
        throw new UnprocessableEntityException(
          'La promoción alcanzó su máximo de usos.',
        );
      }
    }

    if (promo.maxUsesPerCustomer != null) {
      const usedByCustomer = await this.prisma.order.count({
        where: {
          promotionId: promo.id,
          customerId: customer.id,
          status: { not: 'CANCELLED' },
        },
      });
      if (usedByCustomer >= promo.maxUsesPerCustomer) {
        throw new UnprocessableEntityException(
          'Ya alcanzaste el límite de usos para esta promoción.',
        );
      }
    }

    let estimatedDiscount: number | null = null;
    if (dto.subtotal !== undefined) {
      const subtotal = new Prisma.Decimal(dto.subtotal);
      if (promo.minOrderAmount && subtotal.lt(promo.minOrderAmount)) {
        throw new UnprocessableEntityException(
          `La promoción requiere un monto mínimo de ${promo.minOrderAmount.toString()}.`,
        );
      }
      let discount =
        promo.discountType === 'PERCENTAGE'
          ? subtotal
              .mul(promo.discountValue)
              .div(100)
              .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
          : new Prisma.Decimal(promo.discountValue);
      if (discount.gt(subtotal)) discount = subtotal;
      estimatedDiscount = Number(discount.toFixed(2));
    }

    return {
      valid: true,
      promotion: {
        id: promo.id,
        code: promo.code,
        name: promo.name,
        description: promo.description,
        discountType: promo.discountType,
        discountValue: promo.discountValue,
        minOrderAmount: promo.minOrderAmount,
        validFrom: promo.validFrom,
        validUntil: promo.validUntil,
        maxUses: promo.maxUses,
        maxUsesPerCustomer: promo.maxUsesPerCustomer,
        firstOrderOnly: promo.firstOrderOnly,
        isPersonal: Boolean(promo.customerId),
      },
      estimatedDiscount,
    };
  }

  createPromotion(actor: AuthUser, dto: CreatePromotionDto) {
    if (dto.discountType === 'PERCENTAGE' && dto.discountValue > 100)
      throw new BadRequestException('Un descuento porcentual no supera 100.');
    this.assertWindow(dto.validFrom, dto.validUntil);
    return this.prisma.$transaction(async (tx) => {
      const promo = await tx.promotion
        .create({ data: this.clean({ ...dto }) as Prisma.PromotionCreateInput })
        .catch((e) => this.mapUnique(e));
      await this.audit(tx, actor, 'promotion.created', promo.id);
      return promo;
    });
  }

  async updatePromotion(actor: AuthUser, id: string, dto: UpdatePromotionDto) {
    const current = await this.prisma.promotion.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('La promoción no existe.');
    if (
      current.discountType === 'PERCENTAGE' &&
      dto.discountValue !== undefined &&
      dto.discountValue > 100
    )
      throw new BadRequestException('Un descuento porcentual no supera 100.');
    this.assertWindow(
      dto.validFrom ?? current.validFrom ?? undefined,
      dto.validUntil ?? current.validUntil ?? undefined,
    );
    return this.prisma.$transaction(async (tx) => {
      const promo = await tx.promotion.update({
        where: { id },
        data: this.clean({ ...dto }) as Prisma.PromotionUpdateInput,
      });
      await this.audit(tx, actor, 'promotion.updated', id);
      return promo;
    });
  }

  // ---- Utilidades

  private assertWindow(from?: Date, until?: Date) {
    if (from && until && from >= until)
      throw new BadRequestException(
        'La vigencia es inválida: validFrom debe ser anterior a validUntil.',
      );
  }

  private clean(data: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      out[k] = typeof v === 'string' ? v.trim() : v;
    }
    return out;
  }

  private mapUnique(e: unknown): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
      throw new ConflictException('Ya existe un registro con ese nombre o código.');
    throw e;
  }

  private audit(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    action: string,
    entityId: string,
  ) {
    return tx.auditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action: action.toUpperCase().replace('.', '_'),
        entity: action.split('.')[0],
        entityId,
      },
    });
  }
}
