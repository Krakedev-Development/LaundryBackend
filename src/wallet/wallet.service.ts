import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { CustomersService } from '../customers/customers.service';
import { Prisma, type LedgerEntryType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ManualCreditDto, PageQuery, WaiveChargeDto } from './dto/wallet.dto';

const D = Prisma.Decimal;
type Tx = Prisma.TransactionClient;

export interface LedgerPost {
  customerId: string;
  type: LedgerEntryType;
  // Positivo = a favor del cliente; negativo = cargo.
  amount: Prisma.Decimal | number | string;
  reference: string;
  description?: string;
  orderId?: string;
  chargeId?: string;
  idempotencyKey?: string;
}

// El libro mayor es inmutable: solo se insertan asientos. El saldo siempre se deriva.
@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
  ) {}

  async balance(
    db: Pick<PrismaService, 'ledgerEntry'> | Tx,
    customerId: string,
  ): Promise<Prisma.Decimal> {
    const { _sum } = await db.ledgerEntry.aggregate({
      where: { customerId },
      _sum: { amount: true },
    });
    return new D(_sum.amount ?? 0);
  }

  // Serializa los movimientos de un cliente: evita sobregiros por pagos simultáneos.
  async lockCustomer(tx: Tx, customerId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${customerId}::uuid FOR UPDATE`;
  }

  async post(tx: Tx, e: LedgerPost) {
    try {
      return await tx.ledgerEntry.create({ data: { ...e, amount: new D(e.amount) } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw new ConflictException('Este movimiento ya fue registrado.');
      throw err;
    }
  }

  // ---- API del cliente

  async myWallet(user: AuthUser, q: PageQuery) {
    const customer = await this.customers.customerOf(user);
    const page = q.page ?? 1;
    const pageSize = Math.min(q.pageSize ?? 20, 100);
    const [balance, entries] = await Promise.all([
      this.balance(this.prisma, customer.id),
      this.prisma.ledgerEntry.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          type: true,
          amount: true,
          reference: true,
          description: true,
          orderId: true,
          chargeId: true,
          createdAt: true,
        },
      }),
    ]);
    return { balance, page, pageSize, entries };
  }

  async myCharges(user: AuthUser) {
    const customer = await this.customers.customerOf(user);
    return this.prisma.customerCharge.findMany({
      where: { customerId: customer.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async payCharge(user: AuthUser, chargeId: string) {
    const customer = await this.customers.customerOf(user);
    return this.prisma.$transaction(async (tx) => {
      await this.lockCustomer(tx, customer.id);
      const charge = await tx.customerCharge.findFirst({
        where: { id: chargeId, customerId: customer.id },
      });
      if (!charge) throw new NotFoundException('El cargo no existe.');
      if (charge.status !== 'PENDING')
        throw new ConflictException('El cargo ya no está pendiente.');
      if ((await this.balance(tx, customer.id)).lt(charge.amount))
        throw new ConflictException('Saldo insuficiente en la billetera.');
      await this.post(tx, {
        customerId: customer.id,
        chargeId: charge.id,
        orderId: charge.orderId ?? undefined,
        type: 'DEBIT',
        amount: new D(charge.amount).neg(),
        reference: `CHARGE:${charge.type}`,
        description: charge.reason,
        idempotencyKey: `charge-payment:${charge.id}`,
      });
      return tx.customerCharge.update({
        where: { id: charge.id },
        data: { status: 'PAID', paidAt: new Date() },
      });
    });
  }

  // ---- API del administrador

  // Abono manual (p. ej. transferencia verificada), mientras no exista proveedor de pagos.
  async manualCredit(actor: AuthUser, dto: ManualCreditDto) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: dto.customerId },
    });
    if (!customer) throw new NotFoundException('El cliente no existe.');
    return this.prisma.$transaction(async (tx) => {
      await this.lockCustomer(tx, customer.id);
      const entry = await this.post(tx, {
        customerId: customer.id,
        type: 'CREDIT',
        amount: dto.amount,
        reference: dto.reference.trim(),
        description: dto.description?.trim(),
        idempotencyKey: dto.idempotencyKey ? `credit:${dto.idempotencyKey}` : undefined,
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: 'WALLET_MANUAL_CREDIT',
          entity: 'Customer',
          entityId: customer.id,
          after: { ledgerEntryId: entry.id, amount: dto.amount, reference: dto.reference },
        },
      });
      return { entry, balance: await this.balance(tx, customer.id) };
    });
  }

  async waiveCharge(actor: AuthUser, chargeId: string, dto: WaiveChargeDto) {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.customerCharge.updateMany({
        where: { id: chargeId, status: 'PENDING' },
        data: { status: 'WAIVED', waivedReason: dto.reason.trim() },
      });
      if (!count)
        throw new ConflictException('El cargo no existe o ya no está pendiente.');
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: 'CHARGE_WAIVED',
          entity: 'CustomerCharge',
          entityId: chargeId,
          reason: dto.reason.trim(),
        },
      });
      return tx.customerCharge.findUniqueOrThrow({ where: { id: chargeId } });
    });
  }
}
