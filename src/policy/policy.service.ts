import {
  BadRequestException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, type BusinessPolicy } from '../generated/prisma/client';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePolicyDto, isValidTimezone } from './dto/policy.dto';

// Parámetros numéricos/booleanos de la política que otros módulos pueden exigir.
export type PolicyParam =
  | 'minimumOrderAmount'
  | 'taxRate'
  | 'taxIncluded'
  | 'pickupFee'
  | 'deliveryFee'
  | 'pricePerPound'
  | 'cutoffMinutes'
  | 'lateCancellationFee'
  | 'noShowFee'
  | 'failedPickupFee'
  | 'handoffMaxAttempts'
  | 'handoffTtlMinutes'
  | 'pointsPerCurrencyUnit'
  | 'walletTopUpMin'
  | 'walletTopUpMax';

const PARAM_LABELS: Record<PolicyParam, string> = {
  minimumOrderAmount: 'monto mínimo de pedido',
  taxRate: 'tasa de IVA',
  taxIncluded: 'indicador de IVA incluido',
  pickupFee: 'tarifa de recogida',
  deliveryFee: 'tarifa de entrega',
  pricePerPound: 'precio por libra',
  cutoffMinutes: 'corte para cambios y cancelaciones',
  lateCancellationFee: 'cargo por cancelación tardía',
  noShowFee: 'cargo por ausencia',
  failedPickupFee: 'cargo por recogida fallida',
  handoffMaxAttempts: 'intentos máximos de código de custodia',
  handoffTtlMinutes: 'vigencia del código de custodia',
  pointsPerCurrencyUnit: 'puntos por unidad monetaria',
  walletTopUpMin: 'recarga mínima de billetera',
  walletTopUpMax: 'recarga máxima de billetera',
};

@Injectable()
export class PolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async getActive(): Promise<BusinessPolicy | null> {
    return this.prisma.businessPolicy.findFirst({ where: { active: true } });
  }

  // La operación no puede arrancar sin una política definida por el administrador.
  async requireActive(): Promise<BusinessPolicy> {
    const policy = await this.getActive();
    if (!policy)
      throw new UnprocessableEntityException(
        'El administrador aún no configuró la política de negocio.',
      );
    return policy;
  }

  // Devuelve el parámetro o rechaza la regla: nunca se asume un valor.
  async requireParam<K extends PolicyParam>(
    key: K,
    policy?: BusinessPolicy,
  ): Promise<NonNullable<BusinessPolicy[K]>> {
    const active = policy ?? (await this.requireActive());
    const value = active[key];
    if (value === null || value === undefined)
      throw new UnprocessableEntityException(
        `Falta configurar en la política: ${PARAM_LABELS[key]}.`,
      );
    return value as NonNullable<BusinessPolicy[K]>;
  }

  history(): Promise<BusinessPolicy[]> {
    return this.prisma.businessPolicy.findMany({ orderBy: { version: 'desc' } });
  }

  // Cada cambio crea una versión nueva y desactiva la anterior; los pedidos existentes
  // conservan la versión con la que se crearon.
  async publish(actor: AuthUser, dto: CreatePolicyDto): Promise<BusinessPolicy> {
    if (!isValidTimezone(dto.timezone))
      throw new BadRequestException('Zona horaria inválida.');
    if (dto.enforceDriverLimit && !dto.driverLimit)
      throw new BadRequestException(
        'Define el límite de carga del chofer para poder exigirlo.',
      );
    if (
      dto.walletTopUpMin !== undefined &&
      dto.walletTopUpMax !== undefined &&
      dto.walletTopUpMin > dto.walletTopUpMax
    )
      throw new BadRequestException(
        'La recarga mínima no puede superar la máxima.',
      );
    const { reason, ...values } = dto;

    return this.prisma.$transaction(
      async (tx) => {
        const last = await tx.businessPolicy.findFirst({
          orderBy: { version: 'desc' },
        });
        await tx.businessPolicy.updateMany({
          where: { active: true },
          data: { active: false },
        });
        const created = await tx.businessPolicy.create({
          data: {
            ...values,
            reason,
            version: (last?.version ?? 0) + 1,
            active: true,
            createdById: actor.id,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: actor.id,
            actorRole: actor.role,
            action: 'POLICY_PUBLISHED',
            entity: 'BusinessPolicy',
            entityId: created.id,
            reason,
            before: last ? (JSON.parse(JSON.stringify(last)) as Prisma.InputJsonValue) : Prisma.JsonNull,
            after: JSON.parse(JSON.stringify(created)) as Prisma.InputJsonValue,
          },
        });
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
