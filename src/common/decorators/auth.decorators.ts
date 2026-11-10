import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { UserRole, UserStatus } from '../../generated/prisma/client';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

// Permite operar a una cuenta que debe cambiar su contraseña temporal.
export const ALLOW_PASSWORD_CHANGE = 'allowPasswordChange';
export const AllowPasswordChange = () =>
  SetMetadata(ALLOW_PASSWORD_CHANGE, true);

export const ROLES = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES, roles);

export interface AuthUser {
  id: string;
  role: UserRole;
  status: UserStatus;
  facilityId: string | null;
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest().user,
);

// Un cliente solo puede operar (rutas que no son de lectura) con la identidad aprobada.
// Estas rutas quedan exentas: autenticación, verificación y avisos.
export const ALLOW_WITHOUT_KYC = 'allowWithoutKyc';
export const AllowWithoutKyc = () => SetMetadata(ALLOW_WITHOUT_KYC, true);
