import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { zonedToUtc } from '../common/time';
import {
  Prisma,
  type BusinessPolicy,
  type OrderStatus,
  type TimeSlot,
} from '../generated/prisma/client';
import { CustomersService } from '../customers/customers.service';
import { currentWeekStart, isMembershipActive } from '../customers/membership.util';
import { pointInPolygon, type LatLng } from '../geo/geo.service';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { SlotsService } from '../slots/slots.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PointsService } from '../points/points.service';
import { WalletService } from '../wallet/wallet.service';
import type {
  AssignDriverDto,
  CancelOrderDto,
  CreateOrderDto,
  FailedPickupDto,
  ListOrdersQuery,
  RescheduleOrderDto,
  ScheduleInboundDto,
  ScheduleOutboundDto,
  TransitionDto,
} from './dto/orders.dto';
import { $Enums } from '../generated/prisma/client';
import {
  CLIENT_CANCELLABLE,
  findTransition,
  legKindFor,
  STAFF_CANCELLABLE,
  TRANSITIONS,
  type Gate,
} from './order-state-machine';
import { computePricing } from './pricing';
import { trackingLegFor } from './tracking';
import { evaluateDriverCandidates } from './driver-candidates.util';
import {
  isLiveCustomerTrackingStatus,
  isLocationFresh,
  liveTrackingLegFor,
} from '../tracking/tracking.constants';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { OrderEtaService } from '../tracking/order-eta.service';
import { MapboxDirectionsService } from '../tracking/mapbox-directions.service';

const D = Prisma.Decimal;
type Tx = Prisma.TransactionClient;

const ORDER_INCLUDE = {
  items: {
    include: {
      garment: { select: { id: true, name: true, icon: true } },
      service: { select: { id: true, name: true } },
    },
  },
  extras: {
    include: {
      extra: { select: { id: true, name: true } },
    },
  },
  legs: { include: { slot: true, driver: { select: { userId: true } } }, orderBy: { kind: 'asc' } },
  events: { orderBy: { createdAt: 'asc' } },
  weightTier: { select: { id: true, name: true } },
  facility: { select: { id: true, name: true } },
  customer: {
    select: {
      id: true,
      userId: true,
      membershipPlan: { select: { id: true, name: true } },
      user: { select: { name: true, email: true, phone: true } },
    },
  },
} satisfies Prisma.OrderInclude;
export type FullOrder = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

const GATE_OWNER: Record<Exclude<Gate, 'NONE'>, string> = {
  PAYMENT: 'pago',
  ASSIGNMENT: 'despacho (asignación de chofer)',
  HANDOFF: 'verificación de custodia',
  WEIGHING: 'pesaje',
  ADJUSTMENT: 'ajustes de precio',
};

const ymd = (d: Date) => d.toISOString().slice(0, 10);

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: PolicyService,
    private readonly slots: SlotsService,
    private readonly customers: CustomersService,
    private readonly wallet: WalletService,
    private readonly notifications: NotificationsService,
    private readonly points: PointsService,
    @Optional() private readonly trackingGateway?: TrackingGateway,
    @Optional() private readonly orderEta?: OrderEtaService,
    @Optional() private readonly directions?: MapboxDirectionsService,
  ) {}

  // ------------------------------------------------------------------ Creación

  async create(user: AuthUser, dto: CreateOrderDto, idempotencyKey?: string) {
    const scopedKey = idempotencyKey ? `${user.id}:${idempotencyKey}` : undefined;
    if (scopedKey) {
      const prev = await this.prisma.idempotencyKey.findUnique({
        where: { key: scopedKey },
      });
      if (prev) return prev.responseBody;
    }

    const hasItems = !!dto.items?.length;
    if (hasItems === (dto.weightTierId !== undefined))
      throw new BadRequestException(
        'Envía exactamente uno: items (precio fijo) o weightTierId (bolsa del servicio por peso).',
      );

    const customer = await this.customers.customerOf(user);
    const policy = await this.policies.requireActive();

    if (policy.blockNewOrdersOnCharges) {
      const pending = await this.prisma.customerCharge.count({
        where: { customerId: customer.id, status: 'PENDING' },
      });
      if (pending > 0)
        throw new ConflictException(
          'Tienes cargos pendientes; debes saldarlos antes de crear un pedido.',
        );
    }

    const facility = await this.prisma.facility.findUnique({
      where: { id: dto.facilityId },
      include: { zone: true },
    });
    if (!facility || !facility.active || !facility.zone.active)
      throw new NotFoundException('La sede no existe o está inactiva.');

    const pickup = await this.ownedAddress(customer.id, dto.pickupAddressId);
    this.assertCoverage(facility.zone.polygon, pickup);

    const pickupSlot = await this.usableSlot(
      this.prisma,
      dto.pickupSlotId,
      'DRIVER_PICKUP',
      facility.id,
      policy.timezone,
    );

    // Tramo de salida.
    let outbound: {
      method: 'DRIVER' | 'CUSTOMER';
      addressText: string;
      latitude: Prisma.Decimal | number;
      longitude: Prisma.Decimal | number;
      slot: TimeSlot | null;
    };
    if (dto.mode === 'HOME_HOME') {
      const addr = dto.outbound?.addressId
        ? await this.ownedAddress(customer.id, dto.outbound.addressId)
        : pickup;
      this.assertCoverage(facility.zone.polygon, addr);
      outbound = {
        method: 'DRIVER',
        addressText: addr.fullAddress,
        latitude: addr.latitude,
        longitude: addr.longitude,
        slot: dto.outbound?.slotId
          ? await this.usableSlot(this.prisma, dto.outbound.slotId, 'DRIVER_DELIVERY', facility.id, policy.timezone)
          : null,
      };
    } else {
      if (dto.outbound?.addressId)
        throw new BadRequestException('El retiro en sede no admite dirección de entrega.');
      if (policy.requireStorePickupSlot && !dto.outbound?.slotId)
        throw new UnprocessableEntityException(
          'La política exige elegir franja de retiro en sede al crear el pedido.',
        );
      outbound = {
        method: 'CUSTOMER',
        addressText: facility.address,
        latitude: facility.latitude,
        longitude: facility.longitude,
        slot: dto.outbound?.slotId
          ? await this.usableSlot(this.prisma, dto.outbound.slotId, 'FACILITY_PICKUP', facility.id, policy.timezone)
          : null,
      };
    }

    if (outbound.slot) this.assertDeliveryAfterPickup(pickupSlot, outbound.slot);

    // Catálogo y precios: siempre desde la base de datos.
    const lines = await this.priceLines(dto);
    const extras = dto.extraIds?.length
      ? await this.activeExtras(dto.extraIds)
      : [];
    const now = new Date();
    const promotion = dto.promotionCode
      ? await this.findPromotion(dto.promotionCode, customer.id)
      : null;
    const plan =
      isMembershipActive(customer, now) && customer.membershipPlanId
        ? await this.prisma.membershipPlan.findUnique({ where: { id: customer.membershipPlanId } })
        : null;
    const activePlan = plan?.active ? plan : null;

    const perWeight = !hasItems;
    const tier = perWeight ? await this.activeWeightTier(dto.weightTierId!) : null;
    const pricePerPound = tier ? new D(tier.pricePerPound) : undefined;
    const taxRate = new D(await this.policies.requireParam('taxRate', policy));
    const taxIncluded = await this.policies.requireParam('taxIncluded', policy);
    const pickupFee = new D(await this.policies.requireParam('pickupFee', policy));
    const deliveryFee =
      dto.mode === 'HOME_HOME'
        ? new D(await this.policies.requireParam('deliveryFee', policy))
        : new D(0);

    let freeLogisticsApplied = false;
    const weekStart = currentWeekStart(policy.timezone, now);
    if (activePlan) {
      if (activePlan.weeklyPickups === null) {
        freeLogisticsApplied = true;
      } else if (activePlan.weeklyPickups > 0) {
        const usedFree = await this.prisma.order.count({
          where: {
            customerId: customer.id,
            freeLogisticsApplied: true,
            status: { not: 'CANCELLED' },
            createdAt: { gte: weekStart },
          },
        });
        freeLogisticsApplied = usedFree < activePlan.weeklyPickups;
      }
    }

    const price = computePricing({
      items: lines,
      weightLb: tier ? new D(tier.estimatedWeightLb) : undefined,
      pricePerPound,
      extras: extras.map((e) => new D(e.price)),
      membershipPercent: activePlan ? new D(activePlan.garmentDiscountPercent) : new D(0),
      promotion:
        promotion && this.promotionApplies(promotion, now)
          ? { type: promotion.discountType, value: new D(promotion.discountValue) }
          : null,
      logisticsFee: freeLogisticsApplied ? new D(0) : pickupFee.add(deliveryFee),
      taxRate,
      taxIncluded,
    });
    if (promotion) {
      if (!this.promotionApplies(promotion, now))
        throw new UnprocessableEntityException('La promoción no está vigente.');
      if (promotion.firstOrderOnly) {
        const prior = await this.prisma.order.count({
          where: { customerId: customer.id, status: { not: 'CANCELLED' } },
        });
        if (prior > 0)
          throw new UnprocessableEntityException(
            'Esta promoción aplica únicamente para tu primera orden.',
          );
      }
      if (promotion.maxUsesPerCustomer != null) {
        const usedByCustomer = await this.prisma.order.count({
          where: {
            promotionId: promotion.id,
            customerId: customer.id,
            status: { not: 'CANCELLED' },
          },
        });
        if (usedByCustomer >= promotion.maxUsesPerCustomer)
          throw new UnprocessableEntityException(
            'Ya alcanzaste el límite de usos para esta promoción.',
          );
      }
      if (promotion.minOrderAmount && price.merchandiseNet.add(price.discount).lt(promotion.minOrderAmount))
        throw new UnprocessableEntityException(
          `La promoción requiere un monto mínimo de ${promotion.minOrderAmount.toString()}.`,
        );
    }
    // Sin monto mínimo configurado, no se impone ninguno.
    if (policy.minimumOrderAmount && price.merchandiseNet.lt(policy.minimumOrderAmount))
      throw new UnprocessableEntityException(
        `El monto mínimo de pedido es ${policy.minimumOrderAmount.toString()}.`,
      );

    try {
      return await this.prisma.$transaction(async (tx) => {
        const needsCustomerLock =
          (freeLogisticsApplied && activePlan?.weeklyPickups != null && activePlan.weeklyPickups > 0) ||
          Boolean(promotion && (promotion.maxUsesPerCustomer != null || promotion.firstOrderOnly));
        if (needsCustomerLock) {
          await this.wallet.lockCustomer(tx, customer.id);
        }
        if (freeLogisticsApplied && activePlan?.weeklyPickups != null && activePlan.weeklyPickups > 0) {
          const usedInTx = await tx.order.count({
            where: {
              customerId: customer.id,
              freeLogisticsApplied: true,
              status: { not: 'CANCELLED' },
              createdAt: { gte: weekStart },
            },
          });
          if (usedInTx >= activePlan.weeklyPickups) {
            throw new ConflictException(
              'Se agotaron tus envíos gratis semanales. Reintenta para recalcular.',
            );
          }
        }
        if (promotion) {
          if (promotion.maxUses) {
            // Bloquea la promoción para que usos simultáneos no superen el máximo.
            await tx.$queryRaw`SELECT id FROM "Promotion" WHERE id = ${promotion.id}::uuid FOR UPDATE`;
            const used = await tx.order.count({
              where: { promotionId: promotion.id, status: { not: 'CANCELLED' } },
            });
            if (used >= promotion.maxUses)
              throw new UnprocessableEntityException('La promoción alcanzó su máximo de usos.');
          }
          if (promotion.firstOrderOnly) {
            const prior = await tx.order.count({
              where: { customerId: customer.id, status: { not: 'CANCELLED' } },
            });
            if (prior > 0)
              throw new UnprocessableEntityException(
                'Esta promoción aplica únicamente para tu primera orden.',
              );
          }
          if (promotion.maxUsesPerCustomer != null) {
            const usedByCustomer = await tx.order.count({
              where: {
                promotionId: promotion.id,
                customerId: customer.id,
                status: { not: 'CANCELLED' },
              },
            });
            if (usedByCustomer >= promotion.maxUsesPerCustomer)
              throw new UnprocessableEntityException(
                'Ya alcanzaste el límite de usos para esta promoción.',
              );
          }
        }
        const order = await tx.order.create({
          data: {
            customerId: customer.id,
            facilityId: facility.id,
            mode: dto.mode,
            status: 'PAYMENT_PENDING',
            priority: Boolean(activePlan?.priorityService),
            notes: dto.notes?.trim(),
            pricingModel: perWeight ? 'PER_WEIGHT' : 'FIXED',
            pricingStatus: perWeight ? 'PENDING_WEIGHT' : 'CALCULATED',
            paymentStatus: 'PENDING',
            paymentMethodKind: dto.paymentMethodKind,
            estimatedWeightLb: tier?.estimatedWeightLb ?? null,
            pricePerPound: pricePerPound ?? null,
            weightTierId: tier?.id ?? null,
            itemsSubtotal: price.itemsSubtotal,
            extrasTotal: price.extrasTotal,
            discount: price.discount,
            membershipDiscount: price.membershipDiscount,
            logisticsFee: price.logisticsFee,
            freeLogisticsApplied,
            tax: price.tax,
            total: price.total,
            policyVersion: policy.version,
            promotionId: promotion?.id,
            items: {
              create: dto.items?.map((it, n) => ({
                garmentId: it.garmentId,
                serviceId: it.serviceId,
                quantity: it.quantity,
                unitPrice: lines[n].unitPrice,
                notes: it.notes?.trim(),
              })),
            },
            extras: { create: extras.map((e) => ({ extraId: e.id, price: e.price })) },
            events: {
              create: {
                status: 'PAYMENT_PENDING',
                title: 'Pedido creado',
                actorId: user.id,
                actorRole: user.role,
              },
            },
          },
        });

        await this.createLeg(tx, order.id, 'INBOUND', 'DRIVER', pickup.fullAddress, pickup.latitude, pickup.longitude, pickupSlot);
        await this.createLeg(tx, order.id, 'OUTBOUND', outbound.method, outbound.addressText, outbound.latitude, outbound.longitude, outbound.slot);

        const full = await this.loadOrder(order.id, tx);
        const body = JSON.parse(JSON.stringify(this.view(full))) as Prisma.InputJsonValue;
        if (scopedKey)
          await tx.idempotencyKey.create({
            data: {
              key: scopedKey,
              userId: user.id,
              endpoint: 'POST /orders',
              responseStatus: 201,
              responseBody: body,
            },
          });
        return body;
      });
    } catch (e) {
      // Dos peticiones simultáneas con la misma clave: gana una, la otra devuelve su respuesta.
      if (
        scopedKey &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const prev = await this.prisma.idempotencyKey.findUnique({ where: { key: scopedKey } });
        if (prev) return prev.responseBody;
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------ Consulta

  async list(user: AuthUser, q: ListOrdersQuery) {
    const page = q.page ?? 1;
    const pageSize = Math.min(q.pageSize ?? 20, 100);
    const where: Prisma.OrderWhereInput = {
      ...(q.status ? { status: this.parseStatus(q.status) } : {}),
      ...(await this.scopeFilter(user)),
    };
    const [total, rows] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true, number: true, status: true, mode: true, facilityId: true,
          paymentStatus: true, pricingStatus: true, total: true, version: true, createdAt: true,
          customer: {
            select: {
              id: true,
              user: { select: { name: true, email: true, phone: true } },
            },
          },
        },
      }),
    ]);
    return { page, pageSize, total, data: rows };
  }

  async get(user: AuthUser, id: string) {
    const order = await this.loadOrder(id);
    this.assertCanView(user, order);
    // Lo pagado y el saldo: la app muestra cuánto falta pagar (p. ej. tras un ajuste de precio).
    const paid = await this.paidAmount(this.prisma, id);
    const due = D.max(new D(order.total).sub(paid), 0);
    return { ...this.view(order), amountPaid: paid.toString(), amountDue: due.toString() };
  }

  // ------------------------------------------------------------------ Transiciones

  async transition(user: AuthUser, id: string, dto: TransitionDto) {
    const order = await this.loadOrder(id);
    this.assertCanView(user, order);
    this.assertVersion(order, dto.expectedVersion);
    if (!TRANSITIONS.some((t) => t.to === dto.to))
      throw new BadRequestException('Estado destino desconocido.');
    const to = dto.to as OrderStatus;
    const t = findTransition(order.status, to, order.mode, order.pricingModel);
    if (!t)
      throw new ConflictException(`No se permite pasar de ${order.status} a ${to}.`);
    if (!t.roles.includes(user.role))
      throw new ForbiddenException('Tu rol no puede ejecutar esta transición.');
    if (t.gate !== 'NONE')
      throw new ConflictException(
        `Esta transición la realiza el módulo de ${GATE_OWNER[t.gate]}, no se fuerza manualmente.`,
      );
    if (user.role === 'DRIVER') this.assertAssignedDriver(user, order);

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.applyTransition(tx, order, to, user, dto.note);
      return this.loadOrder(id, tx);
    });
    this.notifyOrderRealtimeStatus(updated);
    return this.view(updated);
  }

  async assign(user: AuthUser, id: string, dto: AssignDriverDto) {
    const order = await this.loadOrder(id);
    this.assertCanView(user, order);
    this.assertVersion(order, dto.expectedVersion);
    const expected: OrderStatus = dto.leg === 'INBOUND' ? 'CONFIRMED' : 'READY_FOR_DELIVERY';
    if (order.status !== expected)
      throw new ConflictException(`El tramo ${dto.leg} se asigna con el pedido en ${expected}.`);
    const leg = order.legs.find((l) => l.kind === dto.leg)!;
    if (leg.method !== 'DRIVER')
      throw new BadRequestException('Este tramo lo realiza el cliente, no requiere chofer.');
    if (!leg.slotId)
      throw new ConflictException('El tramo aún no tiene franja programada.');

    const driver = await this.prisma.driver.findUnique({
      where: { id: dto.driverId },
      include: { user: true },
    });
    if (!driver || driver.user.status === 'SUSPENDED')
      throw new NotFoundException('El chofer no existe o está suspendido.');
    if (driver.facilityId !== order.facilityId)
      throw new ConflictException('El chofer pertenece a otra sede.');

    const policy = await this.policies.requireActive();
    if (policy.enforceDriverLimit) {
      if (policy.driverLimit == null)
        throw new UnprocessableEntityException(
          'Falta configurar en la política: límite de servicios por chofer.',
        );
      const active = await this.prisma.fulfillmentLeg.count({
        where: { driverId: driver.id, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      });
      if (active >= policy.driverLimit)
        throw new ConflictException('El chofer alcanzó su límite de servicios activos.');
    }

    const assignedOrder = await this.prisma.$transaction(async (tx) => {
      await tx.fulfillmentLeg.update({ where: { id: leg.id }, data: { driverId: driver.id } });
      await this.applyTransition(
        tx,
        order,
        dto.leg === 'INBOUND' ? 'PICKUP_ASSIGNED' : 'DELIVERY_ASSIGNED',
        user,
        `Chofer asignado: ${driver.user.name}`,
      );
      await tx.auditLog.create({
        data: {
          actorId: user.id, actorRole: user.role, action: 'LEG_ASSIGNED',
          entity: 'Order', entityId: id, after: { leg: dto.leg, driverId: driver.id },
        },
      });
      return this.loadOrder(id, tx);
    });
    this.notifyOrderRealtimeStatus(assignedOrder);
    return this.view(assignedOrder);
  }

  async scheduleOutbound(user: AuthUser, id: string, dto: ScheduleOutboundDto) {
    const order = await this.loadOrder(id);
    this.assertCanView(user, order);
    if (user.role !== 'CLIENT') throw new ForbiddenException('Solo el cliente programa su entrega.');
    this.assertVersion(order, dto.expectedVersion);
    const leg = order.legs.find((l) => l.kind === 'OUTBOUND')!;
    if (leg.status !== 'PENDING' || leg.slotId)
      throw new ConflictException('La entrega ya está programada o no admite programación.');
    if (['CANCELLED', 'COMPLETED', 'DELIVERED'].includes(order.status))
      throw new ConflictException('El pedido ya no admite programar la entrega.');
    const policy = await this.policies.requireActive();
    const context = order.mode === 'HOME_HOME' ? 'DRIVER_DELIVERY' : 'FACILITY_PICKUP';
    const slot = await this.usableSlot(this.prisma, dto.slotId, context, order.facilityId, policy.timezone);
    const inbound = order.legs.find((l) => l.kind === 'INBOUND');
    if (inbound?.slot) this.assertDeliveryAfterPickup(inbound.slot, slot);

    let address: { fullAddress: string; latitude: Prisma.Decimal; longitude: Prisma.Decimal } | null = null;
    if (dto.addressId) {
      if (order.mode !== 'HOME_HOME')
        throw new BadRequestException('El retiro en sede no admite dirección de entrega.');
      const customer = await this.customers.customerOf(user);
      address = await this.ownedAddress(customer.id, dto.addressId);
      const facility = await this.prisma.facility.findUniqueOrThrow({
        where: { id: order.facilityId }, include: { zone: true },
      });
      this.assertCoverage(facility.zone.polygon, address);
    }

    return this.prisma.$transaction(async (tx) => {
      await this.slots.reserveCapacity(tx, slot.id);
      await tx.slotReservation.create({ data: { slotId: slot.id, legId: leg.id } });
      await tx.fulfillmentLeg.update({
        where: { id: leg.id },
        data: {
          slotId: slot.id,
          scheduledDate: slot.date,
          status: 'SCHEDULED',
          ...(address
            ? { addressText: address.fullAddress, latitude: address.latitude, longitude: address.longitude }
            : {}),
        },
      });
      await this.bump(tx, order, user, 'Entrega programada');
      return this.view(await this.loadOrder(id, tx));
    });
  }

  async driverCandidates(
    user: AuthUser,
    id: string,
    requestedLeg?: 'INBOUND' | 'OUTBOUND',
  ) {
    const order = await this.loadOrder(id);
    this.assertCanView(user, order);

    const legKind: 'INBOUND' | 'OUTBOUND' =
      requestedLeg ??
      ([
        'READY_FOR_DELIVERY',
        'DELIVERY_ASSIGNED',
        'OUT_FOR_DELIVERY',
        'ARRIVED_FOR_DELIVERY',
      ].includes(order.status)
        ? 'OUTBOUND'
        : 'INBOUND');

    const targetLeg = order.legs.find((l) => l.kind === legKind) ?? order.legs[0];
    if (!targetLeg) {
      throw new NotFoundException('El pedido no tiene un tramo logístico válido.');
    }

    const [policy, facility, drivers] = await Promise.all([
      this.policies.requireActive().catch(() => null),
      this.prisma.facility.findUnique({
        where: { id: order.facilityId },
        select: { id: true, zoneId: true, latitude: true, longitude: true },
      }),
      this.prisma.driver.findMany({
        where:
          user.role === 'SUPERVISOR'
            ? { facilityId: user.facilityId ?? '00000000-0000-0000-0000-000000000000' }
            : { facilityId: order.facilityId },
        include: {
          user: { select: { name: true, phone: true } },
          zones: { select: { zoneId: true } },
          legs: {
            where: {
              status: { notIn: ['COMPLETED', 'CANCELLED'] },
            },
            orderBy: [{ scheduledDate: 'asc' }, { id: 'asc' }],
            select: {
              latitude: true,
              longitude: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    if (!facility) {
      throw new NotFoundException('La sede del pedido no existe.');
    }

    const targetCoord = {
      lat: Number(targetLeg.latitude),
      lng: Number(targetLeg.longitude),
    };
    const facilityCoord = {
      lat: Number(facility.latitude),
      lng: Number(facility.longitude),
    };

    const result = evaluateDriverCandidates(
      drivers.map((d) => {
        const live = this.trackingGateway?.getLatestDriverLocation(d.id);
        return {
          driverId: d.id,
          name: d.user.name,
          phone: d.user.phone,
          vehicle: d.vehicle,
          plate: d.plate,
          status: d.status,
          facilityId: d.facilityId,
          authorizedZoneIds: d.zones.map((z) => z.zoneId),
          lat: live?.lat ?? (d.latitude !== null ? Number(d.latitude) : null),
          lng: live?.lng ?? (d.longitude !== null ? Number(d.longitude) : null),
          locationAtMs: live
            ? live.timestamp
            : d.locationAt
              ? d.locationAt.getTime()
              : null,
          activeStops: d.legs.map((l) => ({
            lat: Number(l.latitude),
            lng: Number(l.longitude),
          })),
          activeLegsCount: d.legs.length,
        };
      }),
      {
        facilityId: order.facilityId,
        zoneId: facility.zoneId,
        target: targetCoord,
        facilityCoord,
        enforceDriverLimit: Boolean(policy?.enforceDriverLimit),
        driverLimit: policy?.driverLimit ?? null,
      },
    );

    // Refinar ETA/distancia real con Mapbox Directions (cacheado 5 min) para los top 3 con GPS fresco.
    if (this.directions) {
      const topFresh = result.candidates.filter((c) => c.gpsFresh).slice(0, 3);
      await Promise.all(
        topFresh.map(async (cand) => {
          const row = drivers.find((d) => d.id === cand.driverId);
          if (!row) return;
          const live = this.trackingGateway?.getLatestDriverLocation(row.id);
          const lat = live?.lat ?? (row.latitude !== null ? Number(row.latitude) : null);
          const lng = live?.lng ?? (row.longitude !== null ? Number(row.longitude) : null);
          if (lat === null || lng === null) return;
          try {
            const route = await this.directions!.getRouteWithGeometry(
              { latitude: lat, longitude: lng },
              { latitude: targetCoord.lat, longitude: targetCoord.lng },
              { originBearing: live?.heading },
            );
            if (route) {
              cand.distanceMeters = Math.round(route.distanceMeters);
              cand.etaSeconds = Math.round(route.durationSeconds);
            }
          } catch {
            // Conserva estimación Haversine si Mapbox falla.
          }
        }),
      );
    }

    return {
      orderId: order.id,
      leg: legKind,
      facilityId: order.facilityId,
      zoneId: facility.zoneId,
      candidates: result.candidates,
      excluded: result.excluded,
    };
  }

  async cancel(user: AuthUser, id: string, dto: CancelOrderDto) {
    const order = await this.loadOrder(id);
    this.assertCanView(user, order);
    this.assertVersion(order, dto.expectedVersion);
    const isClient = user.role === 'CLIENT';
    if (user.role === 'DRIVER') throw new ForbiddenException('Un chofer no cancela pedidos.');
    const allowed = isClient ? CLIENT_CANCELLABLE : STAFF_CANCELLABLE;
    // Retenido por recogida fallida: la ropa nunca salió del cliente, la sede puede cancelarlo.
    const failedPickupHold =
      !isClient &&
      order.status === 'INCIDENT' &&
      !!(await this.prisma.incident.findFirst({
        where: { orderId: id, type: 'FAILED_PICKUP', status: { in: ['OPEN', 'IN_REVIEW'] } },
      }));
    if (!allowed.includes(order.status) && !failedPickupHold)
      throw new ConflictException(`Un pedido en ${order.status} ya no puede cancelarse.`);

    // Cancelación tardía del cliente: pasado el corte de la franja de recogida se genera cargo.
    let lateFee: Prisma.Decimal | null = null;
    if (isClient) {
      const policy = await this.policies.requireActive();
      const cutoff = await this.policies.requireParam('cutoffMinutes', policy);
      const inbound = order.legs.find((l) => l.kind === 'INBOUND')!;
      if (inbound.slot && this.isPastCutoff(inbound.slot, cutoff, policy)) {
        const fee = new D(await this.policies.requireParam('lateCancellationFee', policy));
        if (fee.gt(0)) lateFee = fee;
      }
    }

    const cancelledOrder = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id, version: order.version, status: order.status },
        data: { status: 'CANCELLED', cancelledAt: new Date(), version: { increment: 1 } },
      });
      if (!count) throw new ConflictException('El pedido cambió; recárgalo e intenta de nuevo.');
      // Lo pagado se devuelve a la billetera (el cargo por cancelación tardía es aparte).
      await this.wallet.lockCustomer(tx, order.customerId);
      const paid = await this.paidAmount(tx, id);
      if (paid.gt(0)) {
        await this.wallet.post(tx, {
          customerId: order.customerId,
          orderId: id,
          type: 'REFUND',
          amount: paid,
          reference: `ORDER:${order.number}:REFUND`,
          description: 'Reembolso por cancelación',
          idempotencyKey: `order-refund:${id}`,
        });
        await tx.order.update({ where: { id }, data: { paymentStatus: 'REFUNDED' } });
      }
      const reservations = await tx.slotReservation.findMany({
        where: { leg: { orderId: id }, active: true },
      });
      for (const r of reservations) {
        await this.slots.releaseCapacity(tx, r.slotId);
        await this.slotReservationRelease(tx, r.id);
      }
      await tx.fulfillmentLeg.updateMany({ where: { orderId: id }, data: { status: 'CANCELLED' } });
      if (failedPickupHold)
        await tx.incident.updateMany({
          where: { orderId: id, status: { in: ['OPEN', 'IN_REVIEW'] } },
          data: { status: 'CLOSED', resolution: `Solicitud cancelada: ${dto.reason}` },
        });
      if (lateFee)
        await tx.customerCharge.create({
          data: {
            customerId: order.customerId,
            orderId: id,
            type: 'LATE_CANCELLATION',
            amount: lateFee,
            reason: 'Cancelación posterior al corte de la franja de recogida.',
          },
        });
      await tx.orderEvent.create({
        data: {
          orderId: id, status: 'CANCELLED', title: 'Pedido cancelado',
          description: dto.reason, actorId: user.id, actorRole: user.role,
        },
      });
      if (!isClient)
        await this.notifications.orderStatus(tx, order, 'CANCELLED');
      return this.loadOrder(id, tx);
    });
    this.notifyOrderRealtimeStatus(cancelledOrder);
    return this.view(cancelledOrder);
  }

  // ------------------------------------------------------------------ Recogida fallida

  // El chofer está en el domicilio pero no puede recoger (cliente ausente, no responde...).
  // La solicitud queda retenida (INCIDENT) para que la sede decida si la reprograma o la cancela;
  // se libera la franja y al chofer, y se aplica el cargo de la política.
  async failedPickup(user: AuthUser, id: string, dto: FailedPickupDto) {
    const order = await this.loadOrder(id);
    this.assertCanView(user, order);
    const inbound = order.legs.find((l) => l.kind === 'INBOUND')!;
    if (user.role !== 'DRIVER' || inbound.driver?.userId !== user.id)
      throw new ForbiddenException('El pedido no está asignado a ti.');
    this.assertVersion(order, dto.expectedVersion);
    if (order.status !== 'ARRIVED_FOR_PICKUP')
      throw new ConflictException(
        'La recogida fallida se reporta en el domicilio, después de marcar la llegada.',
      );
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException('Indica el motivo de la recogida fallida.');
    const policy = await this.policies.requireActive();
    const fee = new D(await this.policies.requireParam('failedPickupFee', policy));

    const failedOrder = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id, version: order.version, status: order.status },
        data: { status: 'INCIDENT', version: { increment: 1 } },
      });
      if (!count) throw new ConflictException('El pedido cambió; recárgalo e intenta de nuevo.');
      const reservations = await tx.slotReservation.findMany({
        where: { legId: inbound.id, active: true },
      });
      for (const r of reservations) {
        await this.slots.releaseCapacity(tx, r.slotId);
        await this.slotReservationRelease(tx, r.id);
      }
      // El tramo queda sin franja ni chofer: se programa de nuevo si la sede reprograma.
      await tx.fulfillmentLeg.update({
        where: { id: inbound.id },
        data: { status: 'PENDING', driverId: null, slotId: null, scheduledDate: null, startedAt: null },
      });
      const driver = await tx.driver.findUnique({ where: { userId: user.id } });
      await tx.incident.create({
        data: {
          orderId: id,
          driverId: driver?.id,
          type: 'FAILED_PICKUP',
          severity: 'MEDIUM',
          description: reason,
          // Al resolverse, la solicitud vuelve a Confirmada para asignar una nueva recogida.
          previousStatus: 'CONFIRMED',
          createdById: user.id,
        },
      });
      if (fee.gt(0))
        await tx.customerCharge.create({
          data: {
            customerId: order.customerId,
            orderId: id,
            type: 'FAILED_PICKUP',
            amount: fee,
            reason: `Recogida fallida: ${reason}`,
          },
        });
      await tx.orderEvent.create({
        data: {
          orderId: id, status: 'INCIDENT', title: 'Recogida fallida',
          description: reason, actorId: user.id, actorRole: user.role,
        },
      });
      await this.notifications.notify(tx, order.customerId, {
        orderId: id,
        category: 'INCIDENT',
        title: 'No pudimos recoger tu ropa',
        body: fee.gt(0)
          ? `El chofer no pudo completar la recogida (${reason}). Se aplicó un cargo de $${fee.toFixed(2)}. La sede te contactará para reprogramarla.`
          : `El chofer no pudo completar la recogida (${reason}). La sede te contactará para reprogramarla.`,
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id, actorRole: user.role, action: 'FAILED_PICKUP',
          entity: 'Order', entityId: id, reason,
        },
      });
      return this.loadOrder(id, tx);
    });
    this.notifyOrderRealtimeStatus(failedOrder);
    return this.view(failedOrder);
  }

  // La sede programa una nueva franja de recogida. Si la entrega ya programada quedaría antes
  // que la nueva recogida, se libera para reprogramarla.
  async scheduleInbound(user: AuthUser, id: string, dto: ScheduleInboundDto) {
    const order = await this.loadOrder(id);
    this.assertCanView(user, order);
    if (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR')
      throw new ForbiddenException('Solo la sede reprograma la recogida.');
    this.assertVersion(order, dto.expectedVersion);
    if (order.status !== 'INCIDENT' && order.status !== 'CONFIRMED')
      throw new ConflictException(
        'La recogida se reprograma con el pedido retenido o confirmado.',
      );
    const inbound = order.legs.find((l) => l.kind === 'INBOUND')!;
    if (inbound.slotId)
      throw new ConflictException('La recogida ya tiene una franja programada.');
    const policy = await this.policies.requireActive();
    const slot = await this.usableSlot(this.prisma, dto.slotId, 'DRIVER_PICKUP', order.facilityId, policy.timezone);
    const outbound = order.legs.find((l) => l.kind === 'OUTBOUND');
    const deliveryTooEarly =
      !!outbound?.slot &&
      `${ymd(outbound.slot.date)} ${outbound.slot.startTime}` < `${ymd(slot.date)} ${slot.endTime}`;

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id, version: order.version, status: order.status },
        data: { version: { increment: 1 } },
      });
      if (!count) throw new ConflictException('El pedido cambió; recárgalo e intenta de nuevo.');
      await this.slots.reserveCapacity(tx, slot.id);
      await tx.slotReservation.create({ data: { slotId: slot.id, legId: inbound.id } });
      await tx.fulfillmentLeg.update({
        where: { id: inbound.id },
        data: { slotId: slot.id, scheduledDate: slot.date, status: 'SCHEDULED' },
      });
      if (deliveryTooEarly && outbound) {
        const reservations = await tx.slotReservation.findMany({
          where: { legId: outbound.id, active: true },
        });
        for (const r of reservations) {
          await this.slots.releaseCapacity(tx, r.slotId);
          await this.slotReservationRelease(tx, r.id);
        }
        await tx.fulfillmentLeg.update({
          where: { id: outbound.id },
          data: { slotId: null, scheduledDate: null, status: 'PENDING' },
        });
      }
      const when = `${ymd(slot.date)} ${slot.startTime}-${slot.endTime}`;
      await tx.orderEvent.create({
        data: {
          orderId: id, status: order.status, title: 'Recogida reprogramada',
          description: deliveryTooEarly
            ? `Nueva recogida: ${when}. La entrega debe programarse de nuevo.`
            : `Nueva recogida: ${when}.`,
          actorId: user.id, actorRole: user.role,
        },
      });
      await this.notifications.notify(tx, order.customerId, {
        orderId: id,
        category: 'ORDER_STATUS',
        title: 'Recogida reprogramada',
        body: deliveryTooEarly
          ? `Programamos una nueva recogida para el ${when}. Elige de nuevo el horario de entrega.`
          : `Programamos una nueva recogida para el ${when}.`,
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id, actorRole: user.role, action: 'INBOUND_RESCHEDULED',
          entity: 'Order', entityId: id, reason: when,
        },
      });
      return this.view(await this.loadOrder(id, tx));
    });
  }

  /**
   * El cliente cambia la franja (y si quiere la dirección) de la recogida o de la entrega.
   * Solo antes de que el tramo inicie y fuera del corte de la política. Si el tramo ya tenía
   * chofer y cambia el horario, el chofer se libera y la sede vuelve a asignar.
   */
  async reschedule(user: AuthUser, id: string, dto: RescheduleOrderDto) {
    const order = await this.loadOrder(id);
    this.assertCanView(user, order);
    if (user.role !== 'CLIENT') throw new ForbiddenException('Solo el cliente reprograma su pedido.');
    this.assertVersion(order, dto.expectedVersion);

    const isInbound = dto.leg === 'INBOUND';
    const leg = order.legs.find((l) => l.kind === dto.leg)!;
    const inbound = order.legs.find((l) => l.kind === 'INBOUND')!;
    const outbound = order.legs.find((l) => l.kind === 'OUTBOUND');
    const closedForOutbound: OrderStatus[] = [
      'OUT_FOR_DELIVERY', 'ARRIVED_FOR_DELIVERY', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'INCIDENT',
    ];
    const open = isInbound
      ? (['PAYMENT_PENDING', 'CONFIRMED', 'PICKUP_ASSIGNED'] as OrderStatus[]).includes(order.status)
      : !closedForOutbound.includes(order.status);
    if (!open || !['PENDING', 'SCHEDULED'].includes(leg.status))
      throw new ConflictException(
        isInbound
          ? 'La recogida ya inició o el pedido ya no admite reprogramarla.'
          : 'La entrega ya inició o el pedido ya no admite reprogramarla.',
      );

    const policy = await this.policies.requireActive();
    const cutoff = await this.policies.requireParam('cutoffMinutes', policy);
    if (leg.slot && this.isPastCutoff(leg.slot, cutoff, policy))
      throw new UnprocessableEntityException(
        `Faltan menos de ${cutoff} minutos para la franja actual; ya no puede reprogramarse.`,
      );

    const context: TimeSlot['context'] = isInbound
      ? 'DRIVER_PICKUP'
      : order.mode === 'HOME_HOME' ? 'DRIVER_DELIVERY' : 'FACILITY_PICKUP';
    const slotChanged = dto.slotId !== leg.slotId;
    const slot = slotChanged
      ? await this.usableSlot(this.prisma, dto.slotId, context, order.facilityId, policy.timezone)
      : leg.slot!;
    if (slotChanged && this.isPastCutoff(slot, cutoff, policy))
      throw new UnprocessableEntityException(
        `La nueva franja debe empezar con al menos ${cutoff} minutos de anticipación.`,
      );
    if (!isInbound && inbound.slot) this.assertDeliveryAfterPickup(inbound.slot, slot);

    let address: { fullAddress: string; latitude: Prisma.Decimal; longitude: Prisma.Decimal } | null = null;
    if (dto.addressId) {
      if (!isInbound && order.mode !== 'HOME_HOME')
        throw new BadRequestException('El retiro en sede no admite dirección de entrega.');
      const customer = await this.customers.customerOf(user);
      address = await this.ownedAddress(customer.id, dto.addressId);
      const facility = await this.prisma.facility.findUniqueOrThrow({
        where: { id: order.facilityId }, include: { zone: true },
      });
      this.assertCoverage(facility.zone.polygon, address);
    }
    const addressChanged = !!address && address.fullAddress !== leg.addressText;
    if (!slotChanged && !addressChanged)
      throw new BadRequestException('Elige un horario o una dirección distintos a los actuales.');

    // Una nueva recogida que termina después de la entrega programada obliga a reprogramar la entrega.
    const deliveryTooEarly =
      isInbound && slotChanged && !!outbound?.slot &&
      `${ymd(outbound.slot.date)} ${outbound.slot.startTime}` < `${ymd(slot.date)} ${slot.endTime}`;
    // El chofer se eligió para el horario anterior: con otro horario la sede vuelve a asignar.
    const unassign =
      slotChanged && !!leg.driverId &&
      (order.status === 'PICKUP_ASSIGNED' || order.status === 'DELIVERY_ASSIGNED');
    const releasedDriverUserIds = unassign && leg.driver?.userId ? [leg.driver.userId] : [];
    const nextStatus: OrderStatus = unassign
      ? isInbound ? 'CONFIRMED' : 'READY_FOR_DELIVERY'
      : order.status;

    const updated = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id, version: order.version, status: order.status },
        data: { status: nextStatus, version: { increment: 1 } },
      });
      if (!count) throw new ConflictException('El pedido cambió; recárgalo e intenta de nuevo.');

      const releaseLeg = async (legId: string) => {
        const reservations = await tx.slotReservation.findMany({ where: { legId, active: true } });
        for (const r of reservations) {
          await this.slots.releaseCapacity(tx, r.slotId);
          await this.slotReservationRelease(tx, r.id);
        }
      };
      if (slotChanged) {
        await releaseLeg(leg.id);
        await this.slots.reserveCapacity(tx, slot.id);
        await tx.slotReservation.create({ data: { slotId: slot.id, legId: leg.id } });
      }
      await tx.fulfillmentLeg.update({
        where: { id: leg.id },
        data: {
          slotId: slot.id,
          scheduledDate: slot.date,
          status: 'SCHEDULED',
          ...(unassign ? { driverId: null } : {}),
          ...(address
            ? { addressText: address.fullAddress, latitude: address.latitude, longitude: address.longitude }
            : {}),
        },
      });
      if (deliveryTooEarly && outbound) {
        await releaseLeg(outbound.id);
        await tx.fulfillmentLeg.update({
          where: { id: outbound.id },
          data: { slotId: null, scheduledDate: null, status: 'PENDING' },
        });
      }

      const when = `${ymd(slot.date)} ${slot.startTime}-${slot.endTime}`;
      const details = [
        slotChanged ? `Nueva franja: ${when}.` : null,
        addressChanged && address ? `Nueva dirección: ${address.fullAddress}.` : null,
        deliveryTooEarly ? 'La entrega debe programarse de nuevo.' : null,
        unassign ? 'El chofer asignado se liberó; la sede asignará uno para el nuevo horario.' : null,
      ].filter(Boolean).join(' ');
      await tx.orderEvent.create({
        data: {
          orderId: id, status: nextStatus,
          title: isInbound ? 'Recogida reprogramada' : 'Entrega reprogramada',
          description: details, actorId: user.id, actorRole: user.role,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id, actorRole: user.role,
          action: isInbound ? 'INBOUND_RESCHEDULED' : 'OUTBOUND_RESCHEDULED',
          entity: 'Order', entityId: id, reason: details,
          before: { status: order.status, slotId: leg.slotId, driverId: leg.driverId },
          after: { status: nextStatus, slotId: slot.id, driverId: unassign ? null : leg.driverId },
        },
      });
      return this.loadOrder(id, tx);
    });
    // Avisa también al chofer liberado: ya no figura en el pedido, pero debe quitarlo de su lista.
    this.notifyOrderRealtimeStatus(updated, releasedDriverUserIds);
    return this.view(updated);
  }

  private async slotReservationRelease(tx: Tx, id: string) {
    await tx.slotReservation.update({
      where: { id },
      data: { active: false, releasedAt: new Date() },
    });
  }

  // ------------------------------------------------------------------ Pago y cierre

  // Pagado = -(suma de pagos y reembolsos del propio pedido); los cargos van aparte.
  async paidAmount(db: Pick<PrismaService, 'ledgerEntry'> | Tx, orderId: string) {
    const { _sum } = await db.ledgerEntry.aggregate({
      where: { orderId, chargeId: null, type: { in: ['DEBIT', 'REFUND'] } },
      _sum: { amount: true },
    });
    return new D(_sum.amount ?? 0).neg();
  }

  // Salda con la billetera lo que falte por pagar. Sirve para el pago inicial (y confirma el
  // pedido) y para diferencias posteriores por ajustes de precio.
  async pay(user: AuthUser, id: string, dto: { expectedVersion: number }) {
    const order = await this.loadOrder(id);
    this.assertCanView(user, order);
    if (user.role !== 'CLIENT') throw new ForbiddenException('Solo el cliente paga su pedido.');
    this.assertVersion(order, dto.expectedVersion);
    if (['CANCELLED', 'COMPLETED'].includes(order.status))
      throw new ConflictException('El pedido ya no admite pagos.');

    const paidOrder = await this.prisma.$transaction(async (tx) => {
      await this.wallet.lockCustomer(tx, order.customerId);
      const outstanding = new D(order.total).sub(await this.paidAmount(tx, id));
      if (outstanding.lte(0)) throw new ConflictException('El pedido no tiene saldo pendiente.');
      if ((await this.wallet.balance(tx, order.customerId)).lt(outstanding))
        throw new ConflictException('Saldo insuficiente en la billetera.');
      await this.wallet.post(tx, {
        customerId: order.customerId,
        orderId: id,
        type: 'DEBIT',
        amount: outstanding.neg(),
        reference: `ORDER:${order.number}`,
        description: 'Pago del pedido',
        idempotencyKey: `order-payment:${id}:v${order.version}`,
      });
      if (order.status === 'PAYMENT_PENDING') {
        await this.applyTransition(tx, order, 'CONFIRMED', user, 'Pago recibido');
        await tx.order.update({
          where: { id },
          data: { paymentStatus: 'PAID', paymentMethodKind: 'WALLET' },
        });
      } else {
        await this.bump(tx, order, user, 'Pago de diferencia recibido');
        await tx.order.update({ where: { id }, data: { paymentStatus: 'PAID' } });
      }
      return this.loadOrder(id, tx);
    });
    if (paidOrder.status !== order.status) this.notifyOrderRealtimeStatus(paidOrder);
    return this.view(paidOrder);
  }

  // Confirmación manual del personal (transferencia o pago fuera de la app). El dinero externo
  // se asienta como abono y pago del pedido en el mismo acto: el saldo de la billetera no cambia
  // y el pedido queda pagado para el cierre y para un eventual reembolso.
  async confirmPayment(user: AuthUser, id: string, dto: { expectedVersion: number; note?: string }) {
    const order = await this.loadOrder(id);
    this.assertCanView(user, order);
    if (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR')
      throw new ForbiddenException('Solo el personal confirma pagos manuales.');
    this.assertVersion(order, dto.expectedVersion);
    // Pago inicial pendiente, o diferencia por un precio final mayor (pago por transferencia).
    const difference = order.status !== 'PAYMENT_PENDING';
    if (difference && (order.paymentStatus !== 'PENDING' || ['CANCELLED', 'COMPLETED'].includes(order.status)))
      throw new ConflictException('El pedido no tiene un pago pendiente por confirmar.');

    const note = dto.note?.trim() || 'Pago confirmado por administración';
    const confirmedOrder = await this.prisma.$transaction(async (tx) => {
      await this.wallet.lockCustomer(tx, order.customerId);
      const outstanding = new D(order.total).sub(await this.paidAmount(tx, id));
      if (difference && outstanding.lte(0))
        throw new ConflictException('El pedido no tiene saldo pendiente.');
      if (outstanding.gt(0)) {
        await this.wallet.post(tx, {
          customerId: order.customerId,
          orderId: id,
          type: 'CREDIT',
          amount: outstanding,
          reference: `ORDER:${order.number}:MANUAL_PAYMENT`,
          description: note,
          // Por versión: el pago inicial y una diferencia posterior son abonos distintos.
          idempotencyKey: `order-manual-credit:${id}:v${order.version}`,
        });
        await this.wallet.post(tx, {
          customerId: order.customerId,
          orderId: id,
          type: 'DEBIT',
          amount: outstanding.neg(),
          reference: `ORDER:${order.number}`,
          description: 'Pago del pedido (confirmación manual)',
          idempotencyKey: `order-payment:${id}:v${order.version}`,
        });
      }
      if (difference) await this.bump(tx, order, user, `Pago de diferencia confirmado: ${note}`);
      else await this.applyTransition(tx, order, 'CONFIRMED', user, note);
      await tx.order.update({
        where: { id },
        data: { paymentStatus: 'PAID', paymentMethodKind: 'TRANSFER' },
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id, actorRole: user.role, action: 'ORDER_PAYMENT_CONFIRMED',
          entity: 'Order', entityId: id, reason: note,
          after: { amount: outstanding.toString() },
        },
      });
      return this.loadOrder(id, tx);
    });
    if (confirmedOrder.status !== order.status) this.notifyOrderRealtimeStatus(confirmedOrder);
    return this.view(confirmedOrder);
  }

  // Cierra el pedido entregado. Requiere que no quede saldo por cobrar.
  async complete(user: AuthUser, id: string, dto: { expectedVersion: number }) {
    const order = await this.loadOrder(id);
    this.assertCanView(user, order);
    if (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR')
      throw new ForbiddenException('Solo el personal cierra pedidos.');
    this.assertVersion(order, dto.expectedVersion);
    if (order.status !== 'DELIVERED')
      throw new ConflictException('Solo se cierra un pedido entregado.');
    const closedOrder = await this.prisma.$transaction(async (tx) => {
      const outstanding = new D(order.total).sub(await this.paidAmount(tx, id));
      if (outstanding.gt(0))
        throw new ConflictException(
          `El pedido tiene saldo pendiente de ${outstanding.toString()}.`,
        );
      await this.applyTransition(tx, order, 'COMPLETED', user, 'Pedido cerrado');
      await this.points.accrueForOrder(tx, order);
      return this.loadOrder(id, tx);
    });
    this.notifyOrderRealtimeStatus(closedOrder);
    return this.view(closedOrder);
  }

  // Carga el pedido validando que el usuario pueda verlo (para módulos colaboradores).
  async forUser(user: AuthUser, id: string) {
    const order = await this.loadOrder(id);
    this.assertCanView(user, order);
    return order;
  }

  async viewFor(user: AuthUser, id: string) {
    return this.view(await this.forUser(user, id));
  }

  // ------------------------------------------------------------------ Internos

  // Para los módulos dueños de una puerta (pago, custodia, pesaje...): mueve el pedido sin pasar
  // por la restricción de puerta, pero sí validando que la transición exista y la versión coincida.
  async applyTransition(
    tx: Tx,
    order: {
      id: string;
      version: number;
      status: OrderStatus;
      mode: FullOrder['mode'];
      pricingModel?: FullOrder['pricingModel'];
    },
    to: OrderStatus,
    actor: AuthUser,
    note?: string,
  ) {
    if (!findTransition(order.status, to, order.mode, order.pricingModel))
      throw new ConflictException(`No se permite pasar de ${order.status} a ${to}.`);
    const { count } = await tx.order.updateMany({
      where: { id: order.id, version: order.version, status: order.status },
      data: { status: to, version: { increment: 1 } },
    });
    if (!count)
      throw new ConflictException('El pedido cambió; recárgalo e intenta de nuevo.');
    // El avance del tramo vive en FulfillmentLeg.
    const kind = to.endsWith('PICKUP') ? 'INBOUND' : 'OUTBOUND';
    if (to === 'HEADING_TO_PICKUP' || to === 'OUT_FOR_DELIVERY')
      await tx.fulfillmentLeg.updateMany({
        where: { orderId: order.id, kind },
        data: { status: 'IN_PROGRESS', startedAt: new Date() },
      });
    if (to === 'ARRIVED_FOR_PICKUP' || to === 'ARRIVED_FOR_DELIVERY')
      await tx.fulfillmentLeg.updateMany({
        where: { orderId: order.id, kind },
        data: { status: 'AWAITING_HANDOFF' },
      });
    // La custodia cierra el tramo: la ropa llega a la sede (recogida) o al cliente (entrega).
    if (to === 'AT_FACILITY' || to === 'DELIVERED')
      await tx.fulfillmentLeg.updateMany({
        where: { orderId: order.id, kind: to === 'AT_FACILITY' ? 'INBOUND' : 'OUTBOUND' },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
    await tx.orderEvent.create({
      data: {
        orderId: order.id, status: to, title: `Estado: ${to}`,
        description: note, actorId: actor.id, actorRole: actor.role,
      },
    });
    const owner = await tx.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { id: true, customerId: true },
    });
    await this.notifications.orderStatus(tx, owner, to);
  }

  private async bump(tx: Tx, order: FullOrder, actor: AuthUser, title: string) {
    const { count } = await tx.order.updateMany({
      where: { id: order.id, version: order.version },
      data: { version: { increment: 1 } },
    });
    if (!count) throw new ConflictException('El pedido cambió; recárgalo e intenta de nuevo.');
    await tx.orderEvent.create({
      data: { orderId: order.id, status: order.status, title, actorId: actor.id, actorRole: actor.role },
    });
  }

  private async createLeg(
    tx: Tx,
    orderId: string,
    kind: 'INBOUND' | 'OUTBOUND',
    method: 'DRIVER' | 'CUSTOMER',
    addressText: string,
    latitude: Prisma.Decimal | number,
    longitude: Prisma.Decimal | number,
    slot: TimeSlot | null,
  ) {
    const leg = await tx.fulfillmentLeg.create({
      data: {
        orderId, kind, method, addressText,
        latitude, longitude,
        status: slot ? 'SCHEDULED' : 'PENDING',
        scheduledDate: slot?.date ?? null,
        slotId: slot?.id ?? null,
      },
    });
    if (slot) {
      await this.slots.reserveCapacity(tx, slot.id);
      await tx.slotReservation.create({ data: { slotId: slot.id, legId: leg.id } });
    }
  }

  private async usableSlot(
    db: Pick<PrismaService, 'timeSlot'> | Tx,
    slotId: string,
    context: TimeSlot['context'],
    facilityId: string,
    timezone: string,
  ): Promise<TimeSlot> {
    const slot = await db.timeSlot.findUnique({ where: { id: slotId } });
    if (!slot || !slot.active) throw new NotFoundException('La franja no existe o está inactiva.');
    if (slot.context !== context || slot.facilityId !== facilityId)
      throw new BadRequestException('La franja no corresponde a la sede o al tipo de servicio.');
    if (zonedToUtc(ymd(slot.date), slot.endTime, timezone) <= new Date())
      throw new UnprocessableEntityException('La franja ya terminó.');
    if (slot.reservedCount >= slot.capacity)
      throw new ConflictException('La franja ya no tiene cupo disponible.');
    return slot;
  }

  // La entrega no puede empezar antes de que termine la franja de recogida.
  private assertDeliveryAfterPickup(
    pickup: Pick<TimeSlot, 'date' | 'endTime'>,
    delivery: Pick<TimeSlot, 'date' | 'startTime'>,
  ) {
    if (`${ymd(delivery.date)} ${delivery.startTime}` < `${ymd(pickup.date)} ${pickup.endTime}`)
      throw new UnprocessableEntityException(
        'La franja de entrega debe empezar cuando termina la recogida o después.',
      );
  }

  private isPastCutoff(slot: TimeSlot, cutoffMinutes: number, policy: BusinessPolicy) {
    const start = zonedToUtc(ymd(slot.date), slot.startTime, policy.timezone);
    return Date.now() > start.getTime() - cutoffMinutes * 60_000;
  }

  private async ownedAddress(customerId: string, id: string) {
    const a = await this.prisma.address.findFirst({ where: { id, customerId, deletedAt: null } });
    if (!a) throw new NotFoundException('La dirección no existe.');
    return a;
  }

  private assertCoverage(polygon: Prisma.JsonValue, p: { latitude: Prisma.Decimal | number; longitude: Prisma.Decimal | number }) {
    const point: LatLng = { lat: Number(p.latitude), lng: Number(p.longitude) };
    if (!pointInPolygon(point, polygon as unknown as LatLng[]))
      throw new UnprocessableEntityException('La dirección está fuera de la zona de cobertura de la sede.');
  }

  private async priceLines(dto: CreateOrderDto) {
    if (!dto.items?.length) return [];
    const garmentIds = [...new Set(dto.items.map((i) => i.garmentId))];
    const serviceIds = [...new Set(dto.items.map((i) => i.serviceId))];
    const [garments, services] = await Promise.all([
      this.prisma.garmentType.findMany({ where: { id: { in: garmentIds }, active: true } }),
      this.prisma.serviceType.findMany({ where: { id: { in: serviceIds }, active: true } }),
    ]);
    return dto.items.map((it) => {
      const g = garments.find((x) => x.id === it.garmentId);
      const s = services.find((x) => x.id === it.serviceId);
      if (!g || !s)
        throw new UnprocessableEntityException('Una prenda o servicio no existe o está inactivo.');
      return { unitPrice: new D(g.basePrice).add(s.extraPrice), quantity: it.quantity };
    });
  }

  private async activeExtras(ids: string[]) {
    const extras = await this.prisma.extra.findMany({ where: { id: { in: ids }, active: true } });
    if (extras.length !== ids.length)
      throw new UnprocessableEntityException('Un extra no existe o está inactivo.');
    return extras;
  }

  private async activeWeightTier(id: string) {
    const tier = await this.prisma.weightTier.findUnique({ where: { id } });
    if (!tier || !tier.active)
      throw new UnprocessableEntityException('La bolsa elegida no existe o ya no está disponible.');
    return tier;
  }

  private async findPromotion(code: string, customerId: string) {
    const promo = await this.prisma.promotion.findUnique({ where: { code: code.trim().toUpperCase() } });
    if (!promo || !promo.active || (promo.customerId && promo.customerId !== customerId)) {
      throw new NotFoundException('La promoción no existe.');
    }
    return promo;
  }

  private promotionApplies(p: { validFrom: Date | null; validUntil: Date | null }, now: Date) {
    return (!p.validFrom || p.validFrom <= now) && (!p.validUntil || p.validUntil >= now);
  }

  // Todos los estados del modelo, también los que no salen de una transición (INCIDENT,
  // CANCELLED): la sede necesita listar los pedidos retenidos.
  private parseStatus(s: string): OrderStatus {
    if (!(Object.values($Enums.OrderStatus) as string[]).includes(s))
      throw new BadRequestException('Estado desconocido.');
    return s as OrderStatus;
  }

  private async scopeFilter(user: AuthUser): Promise<Prisma.OrderWhereInput> {
    switch (user.role) {
      case 'ADMIN':
        return {};
      case 'SUPERVISOR':
        return { facilityId: user.facilityId ?? '00000000-0000-0000-0000-000000000000' };
      case 'DRIVER':
        return { legs: { some: { driver: { userId: user.id } } } };
      default:
        return { customer: { userId: user.id } };
    }
  }

  private assertCanView(user: AuthUser, order: FullOrder) {
    const ok =
      user.role === 'ADMIN' ||
      (user.role === 'SUPERVISOR' && user.facilityId === order.facilityId) ||
      (user.role === 'CLIENT' && order.customer.userId === user.id) ||
      (user.role === 'DRIVER' && order.legs.some((l) => l.driver?.userId === user.id));
    if (!ok) throw new NotFoundException('El pedido no existe.');
  }

  // El chofer solo mueve el pedido mientras el tramo vigente esté asignado a él.
  private assertAssignedDriver(user: AuthUser, order: FullOrder) {
    const leg = order.legs.find((l) => l.kind === legKindFor(order.status));
    if (leg?.driver?.userId !== user.id)
      throw new ForbiddenException('El pedido no está asignado a ti.');
  }

  private assertVersion(order: { version: number }, expected: number) {
    if (order.version !== expected)
      throw new ConflictException(
        `El pedido cambió (versión ${order.version}); recárgalo e intenta de nuevo.`,
      );
  }

  private async loadOrder(id: string, db: Pick<PrismaService, 'order'> | Tx = this.prisma) {
    const order = await db.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (!order) throw new NotFoundException('El pedido no existe.');
    return order;
  }

  // ------------------------------------------------------------------ Seguimiento en vivo

  // Vista táctica del pedido: tramo activo, dirección del cliente, sede y chofer con su
  // última ubicación. Aplica la misma visibilidad que el detalle del pedido.
  async tracking(user: AuthUser, id: string) {
    const order = await this.loadOrder(id);
    this.assertCanView(user, order);
    const activeLeg = trackingLegFor(order.status);
    const leg = activeLeg ? order.legs.find((l) => l.kind === activeLeg) : undefined;
    // Sin tramo activo se muestra la dirección de recogida del cliente.
    const addressLeg = leg ?? order.legs.find((l) => l.kind === 'INBOUND')!;

    const facility = await this.prisma.facility.findUniqueOrThrow({
      where: { id: order.facilityId },
      select: { id: true, name: true, address: true, latitude: true, longitude: true },
    });
    const driver = leg?.driverId
      ? await this.prisma.driver.findUnique({
          where: { id: leg.driverId },
          include: { user: { select: { name: true, phone: true } } },
        })
      : null;

    const live = driver ? this.trackingGateway?.getLatestDriverLocation(driver.id) : null;
    const useLive = !!live && isLocationFresh(live.timestamp);
    const driverLat = useLive
      ? live.lat
      : driver?.latitude === null || driver?.latitude === undefined
        ? null
        : Number(driver.latitude);
    const driverLng = useLive
      ? live.lng
      : driver?.longitude === null || driver?.longitude === undefined
        ? null
        : Number(driver.longitude);
    const driverLocationAt = useLive
      ? new Date(live.timestamp).toISOString()
      : driver?.locationAt
        ? driver.locationAt.toISOString()
        : null;

    return {
      orderId: order.id,
      orderNumber: order.number,
      status: order.status,
      mode: order.mode,
      activeLeg,
      isLiveTrackingActive: isLiveCustomerTrackingStatus(order.status),
      customerAddress: {
        text: addressLeg.addressText,
        latitude: Number(addressLeg.latitude),
        longitude: Number(addressLeg.longitude),
      },
      facility: {
        id: facility.id,
        name: facility.name,
        address: facility.address,
        latitude: Number(facility.latitude),
        longitude: Number(facility.longitude),
      },
      assignedDriver: driver
        ? {
            driverId: driver.id,
            name: driver.user.name,
            phone: driver.user.phone,
            plate: driver.plate,
            vehicle: driver.vehicle,
            status: driver.status,
            latitude: driverLat,
            longitude: driverLng,
            heading: useLive ? (live.heading ?? null) : null,
            speed: useLive ? (live.speed ?? null) : null,
            locationAt: driverLocationAt,
          }
        : null,
    };
  }

  async route(user: AuthUser, id: string) {
    const order = await this.loadOrder(id);
    this.assertCanView(user, order);
    if (!this.orderEta) {
      throw new BadRequestException('Servicio de rutas no disponible.');
    }
    this.orderEta.consumeUserBudget(user.id);
    return this.orderEta.getRouteForOrder(id);
  }

  async eta(user: AuthUser, id: string) {
    const order = await this.loadOrder(id);
    this.assertCanView(user, order);
    if (!this.orderEta) {
      throw new BadRequestException('Servicio de ETA no disponible.');
    }
    this.orderEta.consumeUserBudget(user.id);
    return this.orderEta.getEtaForOrder(id);
  }

  async notifyStatusChangedById(orderId: string): Promise<void> {
    const updated = await this.loadOrder(orderId);
    this.notifyOrderRealtimeStatus(updated);
  }

  private notifyOrderRealtimeStatus(order: FullOrder, extraDriverUserIds: string[] = []): void {
    const activeLeg = liveTrackingLegFor(order.status);
    const driverUserIds = [
      ...new Set([
        ...order.legs
          .map((l) => l.driver?.userId)
          .filter((uid): uid is string => typeof uid === 'string'),
        ...extraDriverUserIds,
      ]),
    ];

    this.trackingGateway?.emitOrderStatusChanged({
      orderId: order.id,
      orderNumber: order.number,
      facilityId: order.facilityId,
      status: order.status,
      activeLeg,
      customerUserId: order.customer.userId,
      driverUserIds,
      updatedAt: new Date().toISOString(),
    });
    this.orderEta?.syncTrackingForStatus(order.id, order.status);
  }

  private view(order: FullOrder) {
    return {
      ...order,
      customerName: order.customer?.user?.name,
      customerEmail: order.customer?.user?.email,
      customerPhone: order.customer?.user?.phone,
    };
  }
}
