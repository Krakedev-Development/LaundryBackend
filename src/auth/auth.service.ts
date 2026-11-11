import { createHash, randomBytes } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import type { KycStatus, User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ChangePasswordDto, LoginDto, RegisterDto } from './dto/auth.dto';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: User['role'];
  status: User['status'];
  facilityId: string | null;
  // Estado de verificación de identidad; solo aplica a clientes.
  kycStatus: KycStatus | null;
  // Plan de membresía elegido por el cliente; null mientras no haya elegido ninguno.
  membershipPlan: { id: string; name: string } | null;
}

// Datos del cliente que viajan con el usuario público.
const CUSTOMER_PUBLIC = {
  kycStatus: true,
  membershipPlan: { select: { id: true, name: true } },
} as const;

export function toPublic(
  user: User,
  kycStatus: KycStatus | null = null,
  membershipPlan: { id: string; name: string } | null = null,
): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    facilityId: user.facilityId,
    kycStatus,
    membershipPlan,
  };
}

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(
    dto: RegisterDto,
  ): Promise<{ user: PublicUser; tokens: TokenPair }> {
    const email = dto.email.trim().toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } }))
      throw new ConflictException('El correo ya tiene una cuenta.');
    const name = `${dto.firstName.trim()} ${dto.lastName.trim()}`;
    const user = await this.prisma.user.create({
      data: {
        email,
        name,
        phone: dto.phone.trim(),
        role: 'CLIENT',
        passwordHash: await argon2.hash(dto.password),
        customer: {
          create: {
            billingName: name,
            billingEmail: email,
            billingPhone: dto.phone.trim(),
          },
        },
      },
    });
    return {
      user: toPublic(user, 'NOT_SUBMITTED', null),
      tokens: await this.issueTokens(user),
    };
  }

  async login(dto: LoginDto): Promise<{ user: PublicUser; tokens: TokenPair }> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.trim().toLowerCase() },
      include: { customer: { select: CUSTOMER_PUBLIC } },
    });
    // Correo inexistente y clave errónea responden igual y cuestan lo mismo.
    let ok = false;
    if (user) ok = await argon2.verify(user.passwordHash, dto.password);
    else await argon2.hash(dto.password);
    if (!user || !ok || user.status === 'SUSPENDED')
      throw new UnauthorizedException('Correo o contraseña incorrectos.');
    return {
      user: toPublic(
        user,
        user.customer?.kycStatus ?? null,
        user.customer?.membershipPlan ?? null,
      ),
      tokens: await this.issueTokens(user),
    };
  }

  // Rotación: cada refresh invalida el token usado. Reusar uno ya revocado indica
  // un posible robo, así que se cierran todas las sesiones del usuario.
  async refresh(refreshToken: string): Promise<TokenPair> {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
      include: { user: true },
    });
    if (!stored) throw new UnauthorizedException('Sesión inválida.');
    if (stored.revokedAt) {
      await this.revokeAll(stored.userId);
      throw new UnauthorizedException('Sesión inválida.');
    }
    if (stored.expiresAt <= new Date() || stored.user.status === 'SUSPENDED')
      throw new UnauthorizedException('Sesión expirada.');
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count !== 1) throw new UnauthorizedException('Sesión inválida.');
    return this.issueTokens(stored.user);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
  ): Promise<TokenPair> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (!(await argon2.verify(user.passwordHash, dto.currentPassword)))
      throw new UnauthorizedException('La contraseña actual es incorrecta.');
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await argon2.hash(dto.newPassword),
        status:
          user.status === 'PASSWORD_CHANGE_REQUIRED' ? 'ACTIVE' : user.status,
      },
    });
    await this.revokeAll(userId);
    return this.issueTokens(updated);
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { customer: { select: CUSTOMER_PUBLIC } },
    });
    return toPublic(
      user,
      user.customer?.kycStatus ?? null,
      user.customer?.membershipPlan ?? null,
    );
  }

  private revokeAll(userId: string) {
    return this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issueTokens(user: User): Promise<TokenPair> {
    const accessTtl = this.config.getOrThrow<number>('JWT_ACCESS_TTL_SECONDS');
    const refreshTtl = this.config.getOrThrow<number>(
      'JWT_REFRESH_TTL_SECONDS',
    );
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
      },
    });
    const accessToken = await this.jwt.signAsync(
      { sub: user.id },
      { expiresIn: accessTtl },
    );
    return { accessToken, refreshToken, expiresIn: accessTtl };
  }
}
