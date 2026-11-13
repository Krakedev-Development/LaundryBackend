import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

interface TrackedRequest {
  ip?: string;
  path?: string;
  originalUrl?: string;
  body?: { email?: unknown };
}

// Identifica al cliente por IP; en el inicio de sesión se añade la cuenta, de modo que los
// intentos contra un mismo correo se limitan aunque cambie la IP de origen dentro de un
// mismo equipo/red y un atacante no pueda agotar el cupo de otra cuenta.
export function throttleTracker(req: TrackedRequest): string {
  const ip = req.ip ?? 'unknown';
  const path = req.path ?? req.originalUrl ?? '';
  const email = req.body?.email;
  const perAccount =
    path.endsWith('/auth/login') ||
    path.endsWith('/auth/password-reset/request') ||
    path.endsWith('/auth/password-reset/confirm');
  if (perAccount && typeof email === 'string')
    return `${ip}|${email.trim().toLowerCase().slice(0, 254)}`;
  return ip;
}

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    return Promise.resolve(throttleTracker(req as TrackedRequest));
  }
}
