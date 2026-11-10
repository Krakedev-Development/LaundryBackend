import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { CustomersService } from '../customers/customers.service';
import type { KycDocumentType } from '../generated/prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { isValidCedula } from './cedula';
import type { ReviewKycDto, SubmitKycDto } from './dto/kyc.dto';
import { detectImageMime } from './image-type';

export const KYC_DOCUMENT_TYPES: KycDocumentType[] = ['SELFIE', 'ID_FRONT', 'ID_BACK'];
export const MAX_KYC_IMAGE_BYTES = 6 * 1024 * 1024;
// Reenvíos tras un rechazo cuando la política no define otro valor.
export const DEFAULT_KYC_MAX_RESUBMISSIONS = 3;

const DOCUMENT_LABELS: Record<KycDocumentType, string> = {
  SELFIE: 'la selfie',
  ID_FRONT: 'el frente de la cédula',
  ID_BACK: 'el reverso de la cédula',
};

const REVIEWABLE_CUSTOMER = {
  id: true,
  kycStatus: true,
  kycDocumentType: true,
  kycDocumentNumber: true,
  kycSubmissions: true,
  kycRejectionReason: true,
  kycReviewedAt: true,
  updatedAt: true,
  user: { select: { name: true, email: true, phone: true, createdAt: true } },
} as const;

@Injectable()
export class KycService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly notifications: NotificationsService,
    private readonly policies: PolicyService,
  ) {}

  private async maxResubmissions(): Promise<number> {
    const policy = await this.policies.getActive();
    return policy?.kycMaxResubmissions ?? DEFAULT_KYC_MAX_RESUBMISSIONS;
  }

  // El primer envío no cuenta como reenvío; los siguientes sí.
  private canSubmit(
    c: { kycStatus: string; kycSubmissions: number },
    max: number,
  ): boolean {
    if (c.kycStatus !== 'NOT_SUBMITTED' && c.kycStatus !== 'REJECTED') return false;
    return c.kycSubmissions === 0 || c.kycSubmissions - 1 < max;
  }

  private blockedMessage(status: string): string {
    if (status === 'PENDING') return 'Tu verificación ya está en revisión.';
    if (status === 'APPROVED') return 'Tu identidad ya fue aprobada.';
    return 'Alcanzaste el máximo de reenvíos de verificación. Contacta a soporte.';
  }

  async mine(user: AuthUser) {
    const c = await this.customers.customerOf(user);
    const max = await this.maxResubmissions();
    const editable = this.canSubmit(c, max);
    const uploaded = editable
      ? await this.prisma.kycDocument.findMany({
          where: { customerId: c.id, submission: c.kycSubmissions + 1 },
          select: { type: true },
        })
      : [];
    return {
      status: c.kycStatus,
      rejectionReason: c.kycRejectionReason,
      reviewedAt: c.kycReviewedAt,
      submissions: c.kycSubmissions,
      resubmissionsLeft: Math.max(0, max - Math.max(0, c.kycSubmissions - 1)),
      canSubmit: editable,
      uploaded: uploaded.map((d) => d.type),
    };
  }

  // Cada imagen reemplaza a la anterior del mismo tipo mientras el envío es borrador.
  async uploadDocument(
    user: AuthUser,
    type: KycDocumentType,
    file?: { buffer: Buffer },
  ) {
    if (!file?.buffer?.length)
      throw new BadRequestException('Adjunta la imagen en el campo "file".');
    const mime = detectImageMime(file.buffer);
    if (!mime)
      throw new BadRequestException(
        'El archivo debe ser una imagen JPEG, PNG o WebP.',
      );
    const c = await this.customers.customerOf(user);
    if (!this.canSubmit(c, await this.maxResubmissions()))
      throw new ConflictException(this.blockedMessage(c.kycStatus));
    const submission = c.kycSubmissions + 1;
    const values = {
      mimeType: mime,
      sizeBytes: file.buffer.length,
      sha256: createHash('sha256').update(file.buffer).digest('hex'),
      data: new Uint8Array(file.buffer),
    };
    await this.prisma.kycDocument.upsert({
      where: { customerId_submission_type: { customerId: c.id, submission, type } },
      create: { customerId: c.id, submission, type, ...values },
      update: values,
    });
    return this.mine(user);
  }

  async submit(user: AuthUser, dto: SubmitKycDto) {
    if (!isValidCedula(dto.documentNumber))
      throw new BadRequestException('El número de cédula no es válido.');
    const max = await this.maxResubmissions();
    await this.prisma.$transaction(async (tx) => {
      const c = await this.customers.customerOf(user);
      if (!this.canSubmit(c, max))
        throw new ConflictException(this.blockedMessage(c.kycStatus));
      const docs = await tx.kycDocument.findMany({
        where: { customerId: c.id, submission: c.kycSubmissions + 1 },
        select: { type: true },
      });
      const missing = KYC_DOCUMENT_TYPES.filter(
        (t) => !docs.some((d) => d.type === t),
      );
      if (missing.length)
        throw new BadRequestException(
          `Falta subir ${missing.map((t) => DOCUMENT_LABELS[t]).join(', ')}.`,
        );
      // La condición vive en el UPDATE: dos envíos simultáneos no duplican la solicitud.
      const { count } = await tx.customer.updateMany({
        where: {
          id: c.id,
          kycStatus: { in: ['NOT_SUBMITTED', 'REJECTED'] },
          kycSubmissions: c.kycSubmissions,
        },
        data: {
          kycStatus: 'PENDING',
          kycSubmissions: { increment: 1 },
          kycRejectionReason: null,
          kycDocumentType: 'CEDULA',
          kycDocumentNumber: dto.documentNumber,
          kycReviewedAt: null,
          kycReviewedById: null,
        },
      });
      if (!count)
        throw new ConflictException(
          'Tu verificación ya está en revisión o fue aprobada.',
        );
    });
    return this.mine(user);
  }

  // ---- Administrador

  async queue(status?: string) {
    const allowed = ['NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED'];
    if (status && !allowed.includes(status))
      throw new BadRequestException('Estado desconocido.');
    return this.prisma.customer.findMany({
      where: { kycStatus: (status ?? 'PENDING') as 'PENDING' },
      orderBy: { updatedAt: 'asc' },
      take: 200,
      select: REVIEWABLE_CUSTOMER,
    });
  }

  // Ficha para revisar: datos del cliente y metadatos de las imágenes del último envío.
  async detail(customerId: string) {
    const c = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: REVIEWABLE_CUSTOMER,
    });
    if (!c || c.kycSubmissions === 0)
      throw new NotFoundException('Verificación no encontrada.');
    const documents = await this.prisma.kycDocument.findMany({
      where: { customerId, submission: c.kycSubmissions },
      select: { type: true, mimeType: true, sizeBytes: true, createdAt: true },
    });
    return { ...c, documents };
  }

  async document(actor: AuthUser, customerId: string, type: KycDocumentType) {
    const c = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { kycSubmissions: true },
    });
    const doc = c
      ? await this.prisma.kycDocument.findUnique({
          where: {
            customerId_submission_type: {
              customerId,
              submission: c.kycSubmissions,
              type,
            },
          },
        })
      : null;
    if (!doc) throw new NotFoundException('Documento no encontrado.');
    await this.prisma.auditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'KYC_DOCUMENT_VIEWED',
        entity: 'Customer',
        entityId: customerId,
        reason: type,
      },
    });
    return { data: Buffer.from(doc.data), mimeType: doc.mimeType };
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
        throw new ConflictException(
          'El cliente no tiene una verificación pendiente.',
        );
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
