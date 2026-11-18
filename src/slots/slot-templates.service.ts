import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { nowIn } from '../common/time';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { Prisma, type SlotTemplate } from '../generated/prisma/client';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateSlotTemplateDto,
  ListSlotTemplatesQuery,
  UpdateSlotTemplateDto,
} from './dto/slots.dto';

// Días hacia adelante que el servidor mantiene creados a partir de la plantilla semanal.
export const SLOT_HORIZON_DAYS = 28;
// Cada cuánto se revisa la agenda (también se revisa al arrancar y al cambiar la plantilla).
const GENERATE_EVERY_MS = 60 * 60 * 1000;

export interface GenerationResult {
  created: number;
  existing: number;
  // Franjas de la plantilla que no se crearon porque se solapan con otra ya existente.
  conflicts: number;
  horizonDays: number;
  until: string | null;
  skippedReason?: string;
}

const toDate = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => {
  const d = toDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};

@Injectable()
export class SlotTemplatesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(SlotTemplatesService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
  ) {}

  // La generación automática corre al arrancar y luego cada hora. En pruebas se desactiva
  // (SLOT_AUTOGEN=off) para que no cree franjas en medio de un caso.
  onApplicationBootstrap() {
    if (process.env.SLOT_AUTOGEN === 'off') return;
    const run = () =>
      this.generate().then(
        (r) => r.created && this.log.log(`Franjas creadas desde la plantilla: ${r.created}`),
        (e: unknown) => this.log.error(`No se pudo generar la agenda: ${String(e)}`),
      );
    void run();
    this.timer = setInterval(() => void run(), GENERATE_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  list(actor: AuthUser, q: ListSlotTemplatesQuery) {
    const facilityId = actor.role === 'SUPERVISOR' ? actor.facilityId ?? undefined : q.facilityId;
    if (actor.role === 'SUPERVISOR' && q.facilityId && q.facilityId !== facilityId)
      throw new ForbiddenException('Solo puedes ver la plantilla de tu sede.');
    return this.prisma.slotTemplate.findMany({
      where: { facilityId, context: q.context },
      orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
    });
  }

  async create(actor: AuthUser, dto: CreateSlotTemplateDto) {
    this.assertScope(actor, dto.facilityId);
    if (dto.startTime >= dto.endTime)
      throw new BadRequestException('startTime debe ser anterior a endTime.');
    const facility = await this.prisma.facility.findUnique({ where: { id: dto.facilityId } });
    if (!facility || !facility.active)
      throw new NotFoundException('La sede no existe o está inactiva.');

    const template = await this.prisma.$transaction(
      async (tx) => {
        const sameDay = await tx.slotTemplate.findMany({
          where: { facilityId: dto.facilityId, context: dto.context, weekday: dto.weekday },
        });
        const clash = sameDay.find(
          (t) => dto.startTime < t.endTime && t.startTime < dto.endTime,
        );
        if (clash)
          throw new ConflictException(
            `Se solapa con la franja semanal ${clash.startTime}-${clash.endTime}${clash.active ? '' : ' (inactiva)'}.`,
          );
        const created = await tx.slotTemplate.create({ data: { ...dto } });
        await this.audit(tx, actor, 'SLOT_TEMPLATE_CREATED', created.id);
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    const generated = await this.generate({ facilityId: template.facilityId });
    return { ...template, generated };
  }

  async update(actor: AuthUser, id: string, dto: UpdateSlotTemplateDto) {
    const current = await this.prisma.slotTemplate.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('La franja semanal no existe.');
    this.assertScope(actor, current.facilityId);
    const template = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.slotTemplate.update({
        where: { id },
        data: { capacity: dto.capacity, active: dto.active },
      });
      await this.audit(tx, actor, 'SLOT_TEMPLATE_UPDATED', id);
      return updated;
    });
    // Los cambios aplican a las franjas que se creen desde ahora; las existentes no cambian.
    const generated = template.active
      ? await this.generate({ facilityId: template.facilityId })
      : null;
    return { ...template, generated };
  }

  // Generación manual: el supervisor solo puede generar la agenda de su sede.
  generateFor(actor: AuthUser, facilityId?: string) {
    if (actor.role === 'SUPERVISOR') {
      if (facilityId && facilityId !== actor.facilityId)
        throw new ForbiddenException('Solo puedes generar la agenda de tu sede.');
      return this.generate({ facilityId: actor.facilityId ?? undefined });
    }
    return this.generate({ facilityId });
  }

  // Crea, para los próximos SLOT_HORIZON_DAYS días, las franjas que indica la plantilla y que
  // todavía no existen. Es idempotente: nunca duplica, nunca modifica franjas existentes y omite
  // las que se solapan con otra franja del mismo tramo (p. ej. una creada a mano).
  async generate(opts: { facilityId?: string; now?: Date } = {}): Promise<GenerationResult> {
    const result: GenerationResult = {
      created: 0,
      existing: 0,
      conflicts: 0,
      horizonDays: SLOT_HORIZON_DAYS,
      until: null,
    };
    const policy = await this.policy.getActive();
    if (!policy) return { ...result, skippedReason: 'No hay política de negocio activa.' };
    const now = nowIn(policy.timezone, opts.now);
    const from = now.date;
    const until = addDays(from, SLOT_HORIZON_DAYS - 1);
    result.until = until;

    const templates = await this.prisma.slotTemplate.findMany({
      where: { active: true, facilityId: opts.facilityId, facility: { active: true } },
    });
    if (!templates.length) return result;

    const existing = await this.prisma.timeSlot.findMany({
      where: {
        facilityId: { in: [...new Set(templates.map((t) => t.facilityId))] },
        date: { gte: toDate(from), lte: toDate(until) },
      },
      select: { facilityId: true, context: true, date: true, startTime: true, endTime: true },
    });
    const byDay = new Map<string, { startTime: string; endTime: string }[]>();
    const key = (facilityId: string, context: string, day: string) => `${facilityId}|${context}|${day}`;
    for (const s of existing) {
      const k = key(s.facilityId, s.context, ymd(s.date));
      byDay.set(k, [...(byDay.get(k) ?? []), s]);
    }

    const toCreate: Prisma.TimeSlotCreateManyInput[] = [];
    for (let i = 0; i < SLOT_HORIZON_DAYS; i++) {
      const day = addDays(from, i);
      const weekday = toDate(day).getUTCDay();
      for (const t of templates.filter((x) => x.weekday === weekday)) {
        // La franja de hoy que ya terminó no se crea.
        if (day === now.date && t.endTime <= now.time) continue;
        const k = key(t.facilityId, t.context, day);
        const sameDay = byDay.get(k) ?? [];
        if (sameDay.some((s) => s.startTime === t.startTime && s.endTime === t.endTime)) {
          result.existing++;
          continue;
        }
        if (sameDay.some((s) => t.startTime < s.endTime && s.startTime < t.endTime)) {
          result.conflicts++;
          continue;
        }
        toCreate.push({
          facilityId: t.facilityId,
          context: t.context,
          date: toDate(day),
          startTime: t.startTime,
          endTime: t.endTime,
          capacity: t.capacity,
        });
        byDay.set(k, [...sameDay, t]);
      }
    }
    if (toCreate.length) {
      // skipDuplicates cubre una generación concurrente (arranque y petición manual a la vez).
      const { count } = await this.prisma.timeSlot.createMany({
        data: toCreate,
        skipDuplicates: true,
      });
      result.created = count;
      result.existing += toCreate.length - count;
    }
    return result;
  }

  private assertScope(actor: AuthUser, facilityId: string) {
    if (actor.role === 'SUPERVISOR' && actor.facilityId !== facilityId)
      throw new ForbiddenException('Solo puedes gestionar la plantilla de tu sede.');
  }

  private audit(tx: Prisma.TransactionClient, actor: AuthUser, action: string, entityId: string) {
    return tx.auditLog.create({
      data: { actorId: actor.id, actorRole: actor.role, action, entity: 'SlotTemplate', entityId },
    });
  }
}

export type { SlotTemplate };
