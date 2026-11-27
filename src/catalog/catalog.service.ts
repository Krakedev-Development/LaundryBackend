import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { currentWeekStart, effectiveMembershipStatus } from '../customers/membership.util';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreatePromotionDto,
  UpdatePromotionDto,
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

  // ---- Promociones (los clientes no las listan: el código es secreto)

  listPromotions() {
    return this.prisma.promotion.findMany({ orderBy: { createdAt: 'desc' } });
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
