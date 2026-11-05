import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { toPublic } from '../auth/auth.service';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateDriverDto, CreateStaffDto } from './dto/users.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async createDriver(actor: AuthUser, dto: CreateDriverDto) {
    const email = dto.email.trim().toLowerCase();
    await this.assertEmailFree(email);
    const facility = await this.prisma.facility.findUnique({
      where: { id: dto.facilityId },
    });
    if (!facility || !facility.active)
      throw new NotFoundException('La sede no existe o está inactiva.');
    const passwordHash = await argon2.hash(dto.temporaryPassword);
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          name: dto.name.trim(),
          phone: dto.phone.trim(),
          role: 'DRIVER',
          status: 'PASSWORD_CHANGE_REQUIRED',
          passwordHash,
          facilityId: facility.id,
          driver: {
            create: {
              facilityId: facility.id,
              vehicle: dto.vehicle?.trim(),
              plate: dto.plate?.trim(),
            },
          },
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: 'DRIVER_CREATED',
          entity: 'User',
          entityId: user.id,
        },
      });
      return toPublic(user);
    });
  }

  async createStaff(actor: AuthUser, dto: CreateStaffDto) {
    if (dto.role === 'SUPERVISOR' && !dto.facilityId)
      throw new BadRequestException('El supervisor requiere una sede.');
    if (dto.role === 'ADMIN' && dto.facilityId)
      throw new BadRequestException('El administrador no se limita a una sede.');
    const email = dto.email.trim().toLowerCase();
    await this.assertEmailFree(email);
    if (dto.facilityId) {
      const facility = await this.prisma.facility.findUnique({
        where: { id: dto.facilityId },
      });
      if (!facility) throw new NotFoundException('La sede no existe.');
    }
    const passwordHash = await argon2.hash(dto.temporaryPassword);
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          name: dto.name.trim(),
          phone: dto.phone.trim(),
          role: dto.role,
          status: 'PASSWORD_CHANGE_REQUIRED',
          passwordHash,
          facilityId: dto.facilityId ?? null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: `${dto.role}_CREATED`,
          entity: 'User',
          entityId: user.id,
        },
      });
      return toPublic(user);
    });
  }

  private async assertEmailFree(email: string): Promise<void> {
    if (await this.prisma.user.findUnique({ where: { email } }))
      throw new ConflictException('El correo ya tiene una cuenta.');
  }
}
