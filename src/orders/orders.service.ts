import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
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
  ListOrdersQuery,
  ScheduleOutboundDto,
  TransitionDto,
} from './dto/orders.dto';
import {
  CLIENT_CANCELLABLE,
  findTransition,
  legKindFor,
  STAFF_CANCELLABLE,
  TRANSITIONS,
  type Gate,
} from './order-state-machine';
import { computePricing } from './pricing';

const D = Prisma.Decimal;
type Tx = Prisma.TransactionClient;

const ORDER_INCLUDE = {
  items: true,
  extras: true,
  legs: { include: { slot: true, driver: { select: { userId: true } } }, orderBy: { kind: 'asc' } },
  events: { orderBy: { createdAt: 'asc' } },
  weightTier: { select: { id: true, name: true } },
  customer: {
    select: {
      id: true,
      userId: true,
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

    // Catálogo y precios: siempre desde la base de datos.
    const lines = await this.priceLines(dto);
    const extras = dto.extraIds?.length
      ? await this.activeExtras(dto.extraIds)
      : [];
    const promotion = dto.promotionCode
      ? await this.findPromotion(dto.promotionCode)
      : null;
    const plan = customer.membershipPlanId
      ? await this.prisma.membershipPlan.findUnique({ where: { id: customer.membershipPlanId } })
      : null;

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

    const price = computePricing({
      items: lines,
      weightLb: tier ? new D(tier.estimatedWeightLb) : undefined,
      pricePerPound,
      extras: extras.map((e) => new D(e.price)),
      membershipPercent: plan?.active ? new D(plan.garmentDiscountPercent) : new D(0),
      promotion:
        promotion && this.promotionApplies(promotion, new Date())
          ? { type: promotion.discountType, value: new D(promotion.discountValue) }
          : null,
      logisticsFee: pickupFee.add(deliveryFee),
      taxRate,
      taxIncluded,
    });
    if (promotion) {
      if (!this.promotionApplies(promotion, new Date()))
        throw new UnprocessableEntityException('La promoción no está vigente.');
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
        if (promotion?.maxUses) {
          // Bloquea la promoción para que usos simultáneos no superen el máximo.
          await tx.$queryRaw`SELECT id FROM "Promotion" WHERE id = ${promotion.id}::uuid FOR UPDATE`;
          const used = await tx.order.count({
            where: { promotionId: promotion.id, status: { not: 'CANCELLED' } },
          });
          if (used >= promotion.maxUses)
            throw new UnprocessableEntityException('La promoción alcanzó su máximo de usos.');
        }
        const order = await tx.order.create({
          data: {
            customerId: customer.id,
            facilityId: facility.id,
            mode: dto.mode,
            status: 'PAYMENT_PENDING',
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
    return this.view(order);
  }

  // ------------------------------------------------------------------ Transiciones

  async transition(user: AuthUser, id: string, dto: TransitionDto) {
    const order = await this.loadOrder(id);
    this.assertCanView(user, order);
    this.assertVersion(order, dto.expectedVersion);
    if (!TRANSITIONS.some((t) => t.to === dto.to))
      throw new BadRequestException('Estado destino desconocido.');
    const to = dto.to as OrderStatus;
    const t = findTransition(order.status, to, order.mode);
    if (!t)
      throw new ConflictException(`No se permite pasar de ${order.status} a ${to}.`);
    if (!t.roles.includes(user.role))
      throw new ForbiddenException('Tu rol no puede ejecutar esta transición.');
    if (t.gate !== 'NONE')
      throw new ConflictException(
        `Esta transición la realiza el módulo de ${GATE_OWNER[t.gate]}, no se fuerza manualmente.`,
      );
    if (user.role === 'DRIVER') this.assertAssignedDriver(user, order);

    return this.prisma.$transaction(async (tx) => {
      await this.applyTransition(tx, order, to, user, dto.note);
      return this.view(await this.loadOrder(id, tx));
    });
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

    return this.prisma.$transaction(async (tx) => {
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
      return this.view(await this.loadOrder(id, tx));
    });
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

  async cancel(user: AuthUser, id: string, dto: CancelOrderDto) {
    const order = await this.loadOrder(id);
    this.assertCanView(user, order);
    this.assertVersion(order, dto.expectedVersion);
    const isClient = user.role === 'CLIENT';
    if (user.role === 'DRIVER') throw new ForbiddenException('Un chofer no cancela pedidos.');
    const allowed = isClient ? CLIENT_CANCELLABLE : STAFF_CANCELLABLE;
    if (!allowed.includes(order.status))
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

    return this.prisma.$transaction(async (tx) => {
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
      return this.view(await this.loadOrder(id, tx));
    });
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

    return this.prisma.$transaction(async (tx) => {
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
      return this.view(await this.loadOrder(id, tx));
    });
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
    return this.prisma.$transaction(async (tx) => {
      const outstanding = new D(order.total).sub(await this.paidAmount(tx, id));
      if (outstanding.gt(0))
        throw new ConflictException(
          `El pedido tiene saldo pendiente de ${outstanding.toString()}.`,
        );
      await this.applyTransition(tx, order, 'COMPLETED', user, 'Pedido cerrado');
      await this.points.accrueForOrder(tx, order);
      return this.view(await this.loadOrder(id, tx));
    });
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
    order: { id: string; version: number; status: OrderStatus; mode: FullOrder['mode'] },
    to: OrderStatus,
    actor: AuthUser,
    note?: string,
  ) {
    if (!findTransition(order.status, to, order.mode))
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

  private async findPromotion(code: string) {
    const promo = await this.prisma.promotion.findUnique({ where: { code: code.toUpperCase() } });
    if (!promo || !promo.active) throw new NotFoundException('La promoción no existe.');
    return promo;
  }

  private promotionApplies(p: { validFrom: Date | null; validUntil: Date | null }, now: Date) {
    return (!p.validFrom || p.validFrom <= now) && (!p.validUntil || p.validUntil >= now);
  }

  private parseStatus(s: string): OrderStatus {
    const known = new Set<string>(TRANSITIONS.flatMap((t) => [t.from, t.to]));
    known.add('CANCELLED');
    if (!known.has(s)) throw new BadRequestException('Estado desconocido.');
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

  private view(order: FullOrder) {
    return {
      ...order,
      customerName: order.customer?.user?.name,
      customerEmail: order.customer?.user?.email,
      customerPhone: order.customer?.user?.phone,
    };
  }
}
