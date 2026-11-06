import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { nowIn } from '../common/time';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { Prisma, type TimeSlot } from '../generated/prisma/client';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateSlotDto,
  ListSlotsQuery,
  UpdateSlotDto,
} from './dto/slots.dto';

const toDate = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
export { nowIn };
const isStaff = (u: AuthUser) => u.role === 'ADMIN' || u.role === 'SUPERVISOR';

@Injectable()
export class SlotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
  ) {}

  async list(user: AuthUser, q: ListSlotsQuery) {
    const staff = isStaff(user);
    const policy = await this.policy.requireActive();
    const today = nowIn(policy.timezone).date;
    // Quien no es personal solo ve agenda futura, activa y con cupo.
    const from = staff ? q.from : q.from && q.from > today ? q.from : today;
    const onlyAvailable = staff ? q.onlyAvailable === 'true' : true;
    const rows = await this.prisma.timeSlot.findMany({
      where: {
        facilityId: q.facilityId,
        context: q.context,
        date: {
          gte: from ? toDate(from) : undefined,
          lte: q.to ? toDate(q.to) : undefined,
        },
        ...(staff ? {} : { active: true }),
      },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    });
    return rows
      .filter((s) => !onlyAvailable || (s.active && s.reservedCount < s.capacity))
      .map((s) => this.view(s, staff));
  }

  async create(actor: AuthUser, dto: CreateSlotDto) {
    this.assertScope(actor, dto.facilityId);
    if (dto.startTime >= dto.endTime)
      throw new BadRequestException('startTime debe ser anterior a endTime.');
    const policy = await this.policy.requireActive();
    const now = nowIn(policy.timezone);
    if (dto.date < now.date || (dto.date === now.date && dto.endTime <= now.time))
      throw new BadRequestException('No se pueden crear franjas en el pasado.');
    const facility = await this.prisma.facility.findUnique({
      where: { id: dto.facilityId },
    });
    if (!facility || !facility.active)
      throw new NotFoundException('La sede no existe o está inactiva.');

    return this.prisma.$transaction(
      async (tx) => {
        const sameDay = await tx.timeSlot.findMany({
          where: {
            facilityId: dto.facilityId,
            context: dto.context,
            date: toDate(dto.date),
          },
        });
        // Dos franjas del mismo contexto no pueden solaparse.
        const clash = sameDay.find(
          (s) => dto.startTime < s.endTime && s.startTime < dto.endTime,
        );
        if (clash)
          throw new ConflictException(
            `Se solapa con la franja ${clash.startTime}-${clash.endTime}.`,
          );
        const slot = await tx.timeSlot.create({
          data: {
            facilityId: dto.facilityId,
            context: dto.context,
            date: toDate(dto.date),
            startTime: dto.startTime,
            endTime: dto.endTime,
            capacity: dto.capacity,
          },
        });
        await this.audit(tx, actor, 'SLOT_CREATED', slot.id);
        return this.view(slot, true);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async update(actor: AuthUser, id: string, dto: UpdateSlotDto) {
    const slot = await this.prisma.timeSlot.findUnique({ where: { id } });
    if (!slot) throw new NotFoundException('La franja no existe.');
    this.assertScope(actor, slot.facilityId);
    if (dto.capacity !== undefined && dto.capacity < slot.reservedCount)
      throw new ConflictException(
        `La capacidad no puede ser menor que los cupos ya reservados (${slot.reservedCount}).`,
      );
    return this.prisma.$transaction(async (tx) => {
      // La condición evita bajar la capacidad por debajo de lo reservado entre lectura y escritura.
      const { count } = await tx.timeSlot.updateMany({
        where: {
          id,
          ...(dto.capacity !== undefined
            ? { reservedCount: { lte: dto.capacity } }
            : {}),
        },
        data: { capacity: dto.capacity, active: dto.active },
      });
      if (!count)
        throw new ConflictException('Cambió la ocupación de la franja; reintenta.');
      await this.audit(tx, actor, 'SLOT_UPDATED', id);
      return this.view(await tx.timeSlot.findUniqueOrThrow({ where: { id } }), true);
    });
  }

  // ---- API interna para pedidos

  // Reserva un cupo de forma atómica: la condición vive en el UPDATE, no en una lectura previa,
  // por lo que dos solicitudes concurrentes nunca superan la capacidad.
  async reserveCapacity(tx: Prisma.TransactionClient, slotId: string) {
    const n = await tx.$executeRaw`
      UPDATE "TimeSlot" SET "reservedCount" = "reservedCount" + 1
      WHERE id = ${slotId}::uuid AND active AND "reservedCount" < capacity`;
    if (n === 1) return;
    const exists = await tx.timeSlot.findUnique({ where: { id: slotId } });
    if (!exists) throw new NotFoundException('La franja no existe.');
    throw new ConflictException('La franja ya no tiene cupo disponible.');
  }

  async releaseCapacity(tx: Prisma.TransactionClient, slotId: string) {
    await tx.$executeRaw`
      UPDATE "TimeSlot" SET "reservedCount" = GREATEST("reservedCount" - 1, 0)
      WHERE id = ${slotId}::uuid`;
  }

  // ---- Utilidades

  // El supervisor opera únicamente sobre su sede.
  private assertScope(actor: AuthUser, facilityId: string) {
    if (actor.role === 'SUPERVISOR' && actor.facilityId !== facilityId)
      throw new ForbiddenException('Solo puedes gestionar franjas de tu sede.');
  }

  private view(s: TimeSlot, staff: boolean) {
    const base = {
      id: s.id,
      facilityId: s.facilityId,
      context: s.context,
      date: s.date.toISOString().slice(0, 10),
      startTime: s.startTime,
      endTime: s.endTime,
      available: s.active ? Math.max(s.capacity - s.reservedCount, 0) : 0,
    };
    return staff
      ? {
          ...base,
          capacity: s.capacity,
          reservedCount: s.reservedCount,
          active: s.active,
        }
      : base;
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
        action,
        entity: 'TimeSlot',
        entityId,
      },
    });
  }
}
