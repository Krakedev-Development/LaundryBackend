import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import type { KycStatus, User } from '../generated/prisma/client';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  ChangePasswordDto,
  ConfirmPasswordResetDto,
  LoginDto,
  RegisterDto,
  RequestPasswordResetDto,
} from './dto/auth.dto';

const RESET_TTL_MS = 15 * 60 * 1000;
const RESET_COOLDOWN_MS = 60 * 1000;
const RESET_MAX_ATTEMPTS = 5;

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
    private readonly mail: MailService,
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
    // Los ingresos del personal y los choferes quedan registrados para su seguimiento.
    if (user.role !== 'CLIENT')
      await this.prisma.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          action: 'LOGIN',
          entity: 'User',
          entityId: user.id,
        },
      });
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

  // ---- Recuperación de contraseña por código (solo clientes; el personal y los
  // choferes la restablecen con el administrador).

  // Responde siempre lo mismo, exista o no la cuenta, para no revelar qué correos
  // están registrados.
  async requestPasswordReset(dto: RequestPasswordResetDto): Promise<{ message: string }> {
    const message =
      'Si el correo está registrado, te enviamos un código para restablecer tu contraseña.';
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.trim().toLowerCase() },
    });
    if (!user || user.role !== 'CLIENT' || user.status === 'SUSPENDED') return { message };

    // Un código nuevo por minuto como máximo: evita inundar el correo del cliente.
    const recent = await this.prisma.passwordResetCode.findFirst({
      where: { userId: user.id, createdAt: { gt: new Date(Date.now() - RESET_COOLDOWN_MS) } },
    });
    if (recent) return { message };

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.prisma.$transaction([
      // Solo vale el último código emitido.
      this.prisma.passwordResetCode.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
      this.prisma.passwordResetCode.create({
        data: {
          userId: user.id,
          codeHash: this.resetHash(user.id, code),
          expiresAt: new Date(Date.now() + RESET_TTL_MS),
        },
      }),
    ]);
    await this.mail.send({
      to: user.email,
      subject: 'Código para restablecer tu contraseña',
      text: [
        `Hola ${user.name},`,
        '',
        `Tu código para restablecer la contraseña de Laundry Clean Fresh es: ${code}`,
        '',
        `Vence en ${RESET_TTL_MS / 60_000} minutos y solo puede usarse una vez.`,
        'Si no lo pediste, ignora este correo: tu contraseña no cambiará.',
      ].join('\n'),
    });
    return { message };
  }

  async confirmPasswordReset(dto: ConfirmPasswordResetDto): Promise<{ message: string }> {
    const invalid = new BadRequestException(
      'El código no es válido o ya venció. Solicita uno nuevo.',
    );
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.trim().toLowerCase() },
    });
    if (!user || user.role !== 'CLIENT' || user.status === 'SUSPENDED') throw invalid;
    const pending = await this.prisma.passwordResetCode.findFirst({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!pending || pending.attempts >= RESET_MAX_ATTEMPTS) throw invalid;

    const expected = Buffer.from(pending.codeHash, 'hex');
    const given = Buffer.from(this.resetHash(user.id, dto.code), 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      // Cada intento fallido cuenta; al llegar al límite el código queda inutilizado.
      const attempts = pending.attempts + 1;
      await this.prisma.passwordResetCode.update({
        where: { id: pending.id },
        data: { attempts, ...(attempts >= RESET_MAX_ATTEMPTS ? { usedAt: new Date() } : {}) },
      });
      throw invalid;
    }

    const passwordHash = await argon2.hash(dto.newPassword);
    // El código se marca usado solo si nadie lo usó en paralelo.
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetCode.updateMany({
        where: { id: pending.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) throw invalid;
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      // Cierra todas las sesiones abiertas: quien tenía la contraseña anterior pierde acceso.
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          action: 'PASSWORD_RESET_BY_CODE',
          entity: 'User',
          entityId: user.id,
        },
      });
    });
    return { message: 'Tu contraseña fue actualizada. Ya puedes iniciar sesión.' };
  }

  private resetHash(userId: string, code: string): string {
    return createHmac('sha256', this.config.getOrThrow<string>('JWT_REFRESH_SECRET'))
      .update(`password-reset:${userId}:${code}`)
      .digest('hex');
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
