import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { TrimPipe } from './common/pipes/trim.pipe';
import { ConfiguredIoAdapter } from './tracking/configured-io.adapter';

// Configuración HTTP compartida por el arranque real y las pruebas e2e.
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);
  app.use(helmet());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new TrimPipe(),
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  const origins = (config.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins, credentials: true });
  // El WebSocket usa la misma lista de orígenes que el HTTP.
  app.useWebSocketAdapter(new ConfiguredIoAdapter(app, origins));
  app.enableShutdownHooks();
}
