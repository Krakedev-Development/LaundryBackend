import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { ALLOW_WITHOUT_KYC } from '../decorators/auth.decorators';

const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);

// Un cliente con la identidad sin aprobar puede entrar y consultar, pero no ejecutar acciones.
@Injectable()
export class KycGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const user = req.user;
    if (!user || user.role !== 'CLIENT' || READ_ONLY.has(req.method)) return true;
    if (
      this.reflector.getAllAndOverride<boolean>(ALLOW_WITHOUT_KYC, [
        ctx.getHandler(),
        ctx.getClass(),
      ])
    )
      return true;
    const customer = await this.prisma.customer.findUnique({
      where: { userId: user.id },
      select: { kycStatus: true },
    });
    if (customer?.kycStatus !== 'APPROVED')
      throw new ForbiddenException(
        'Tu identidad aún no está aprobada. Podrás realizar acciones cuando el administrador apruebe tu verificación.',
      );
    return true;
  }
}
