import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { IncomingMessage } from 'node:http';
import type { Server, ServerOptions } from 'socket.io';

// Decide si se acepta la conexión según su origen. Los navegadores siempre envían `Origin`:
// solo se aceptan los de CORS_ORIGINS (web y Expo web). Las apps móviles nativas no envían
// esa cabecera y se aceptan; igual deben presentar un token válido al conectar.
export function isSocketOriginAllowed(
  origin: string | undefined,
  allowed: readonly string[],
): boolean {
  if (!origin) return true;
  return allowed.includes(origin);
}

// Socket.IO con la misma lista de orígenes que el HTTP. La opción `cors` solo cubre el
// transporte por sondeo; `allowRequest` también corta el WebSocket directo desde una página
// ajena (secuestro de WebSocket entre sitios).
export class ConfiguredIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly allowedOrigins: readonly string[],
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const allowed = this.allowedOrigins;
    return super.createIOServer(port, {
      ...options,
      cors: { origin: [...allowed], credentials: true },
      allowRequest: (req: IncomingMessage, callback) => {
        callback(null, isSocketOriginAllowed(req.headers.origin, allowed));
      },
    } as ServerOptions) as Server;
  }
}
