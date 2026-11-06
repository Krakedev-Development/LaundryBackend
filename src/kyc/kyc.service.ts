import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { CustomersService } from '../customers/customers.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ReviewKycDto, SubmitKycDto } from './dto/kyc.dto';

@Injectable()
export class KycService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly notifications: NotificationsService,
  ) {}

  async mine(user: AuthUser) {
    const c = await this.customers.customerOf(user);
    return {
      status: c.kycStatus,
      rejectionReason: c.kycRejectionReason,
      documentType: c.kycDocumentType,
      reviewedAt: c.kycReviewedAt,
    };
  }

  // Los documentos se envían como referencias opacas: el almacenamiento aún no está definido.
  async submit(user: AuthUser, dto: SubmitKycDto) {
    const customer = await this.customers.customerOf(user);
    // Solo se puede (re)enviar si no hay una revisión en curso ni ya está aprobado.
    const { count } = await this.prisma.customer.updateMany({
      where: { id: customer.id, kycStatus: { in: ['NOT_SUBMITTED', 'REJECTED'] } },
      data: {
        kycStatus: 'PENDING',
        kycRejectionReason: null,
        kycDocumentType: dto.documentType.trim(),
        kycDocumentNumber: dto.documentNumber.trim(),
        kycDocumentRef: dto.documentRef?.trim(),
        kycSelfieRef: dto.selfieRef?.trim(),
        kycReviewedAt: null,
        kycReviewedById: null,
      },
    });
    if (!count)
      throw new ConflictException(
        'Tu verificación ya está en revisión o fue aprobada.',
      );
    return this.mine(user);
  }

  // ---- Personal

  async queue(status?: string) {
    const allowed = ['NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED'];
    if (status && !allowed.includes(status))
      throw new BadRequestException('Estado desconocido.');
    return this.prisma.customer.findMany({
      where: { kycStatus: (status ?? 'PENDING') as 'PENDING' },
      orderBy: { updatedAt: 'asc' },
      select: {
        id: true,
        kycStatus: true,
        kycDocumentType: true,
        kycDocumentNumber: true,
        kycDocumentRef: true,
        kycSelfieRef: true,
        updatedAt: true,
        user: { select: { name: true, email: true, phone: true } },
      },
    });
  }

  async review(actor: AuthUser, customerId: string, dto: ReviewKycDto) {
    if (!dto.approve && !dto.reason?.trim())
      throw new BadRequestException('Indica el motivo del rechazo.');
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.customer.updateMany({
        where: { id: customerId, kycStatus: 'PENDING' },
        data: {
          kycStatus: dto.approve ? 'APPROVED' : 'REJECTED',
          kycRejectionReason: dto.approve ? null : dto.reason!.trim(),
          kycReviewedById: actor.id,
          kycReviewedAt: new Date(),
        },
      });
      if (!count)
        throw new ConflictException('El cliente no tiene una verificación pendiente.');
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: dto.approve ? 'KYC_APPROVED' : 'KYC_REJECTED',
          entity: 'Customer',
          entityId: customerId,
          reason: dto.reason?.trim(),
        },
      });
      await this.notifications.notify(tx, customerId, {
        category: 'KYC',
        title: dto.approve ? 'Identidad verificada' : 'Verificación rechazada',
        body: dto.approve
          ? 'Tu identidad fue verificada.'
          : `No pudimos verificar tu identidad: ${dto.reason!.trim()}`,
      });
      return { customerId, status: dto.approve ? 'APPROVED' : 'REJECTED' };
    });
  }
}
