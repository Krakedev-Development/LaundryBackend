import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/auth.decorators';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateAddressDto, UpdateAddressDto } from './dto/customers.dto';

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async customerOf(user: AuthUser) {
    const customer = await this.prisma.customer.findUnique({
      where: { userId: user.id },
    });
    if (!customer) throw new ForbiddenException('La cuenta no es de un cliente.');
    return customer;
  }

  async profile(user: AuthUser) {
    const customer = await this.customerOf(user);
    return {
      id: customer.id,
      kycStatus: customer.kycStatus,
      membershipPlanId: customer.membershipPlanId,
    };
  }

  async listAddresses(user: AuthUser) {
    const customer = await this.customerOf(user);
    return this.prisma.address.findMany({
      where: { customerId: customer.id, deletedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async createAddress(user: AuthUser, dto: CreateAddressDto) {
    const customer = await this.customerOf(user);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.address.count({
        where: { customerId: customer.id, deletedAt: null },
      });
      // La primera dirección es siempre la principal.
      const isPrimary = existing === 0 ? true : !!dto.isPrimary;
      if (isPrimary)
        await tx.address.updateMany({
          where: { customerId: customer.id, isPrimary: true },
          data: { isPrimary: false },
        });
      return tx.address.create({
        data: { ...dto, isPrimary, customerId: customer.id },
      });
    });
  }

  async updateAddress(user: AuthUser, id: string, dto: UpdateAddressDto) {
    const customer = await this.customerOf(user);
    await this.addressOrFail(customer.id, id);
    return this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary)
        await tx.address.updateMany({
          where: { customerId: customer.id, isPrimary: true },
          data: { isPrimary: false },
        });
      // No se puede dejar al cliente sin dirección principal desmarcándola.
      const { isPrimary, ...rest } = dto;
      return tx.address.update({
        where: { id },
        data: { ...rest, ...(isPrimary ? { isPrimary: true } : {}) },
      });
    });
  }

  // Borrado lógico: los pedidos conservan su propia copia de la dirección.
  async deleteAddress(user: AuthUser, id: string) {
    const customer = await this.customerOf(user);
    const address = await this.addressOrFail(customer.id, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.address.update({
        where: { id },
        data: { deletedAt: new Date(), isPrimary: false },
      });
      if (address.isPrimary) {
        const next = await tx.address.findFirst({
          where: { customerId: customer.id, deletedAt: null },
          orderBy: { createdAt: 'asc' },
        });
        if (next)
          await tx.address.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
    });
  }

  private async addressOrFail(customerId: string, id: string) {
    const address = await this.prisma.address.findFirst({
      where: { id, customerId, deletedAt: null },
    });
    if (!address) throw new NotFoundException('La dirección no existe.');
    return address;
  }
}
