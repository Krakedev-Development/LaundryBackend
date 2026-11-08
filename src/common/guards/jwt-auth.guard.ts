import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import {
  ALLOW_PASSWORD_CHANGE,
  IS_PUBLIC,
} from '../decorators/auth.decorators';

// Todas las rutas exigen sesión salvo las marcadas con @Public().
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) {
      const req = ctx.switchToHttp().getRequest();
      if (req.headers?.authorization?.startsWith('Bearer ')) {
        try {
          await super.canActivate(ctx);
        } catch {
          // En rutas públicas un token ausente o inválido opera como anónimo.
        }
      }
      return true;
    }
    await super.canActivate(ctx);
    const user = ctx.switchToHttp().getRequest().user;
    const allowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_PASSWORD_CHANGE,
      targets,
    );
    if (user.status === 'PASSWORD_CHANGE_REQUIRED' && !allowed)
      throw new ForbiddenException(
        'Debes cambiar tu contraseña temporal antes de continuar.',
      );
    return true;
  }
}
