import 'dotenv/config';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service';

// Las pruebas e2e usan SIEMPRE la base `<DB>_test`, nunca la de desarrollo.
function useTestEnvironment(): void {
  const url = new URL(process.env.DATABASE_URL!);
  if (!url.pathname.endsWith('_test')) url.pathname += '_test';
  process.env.DATABASE_URL = url.toString();
  process.env.PORT = '4999';
  process.env.THROTTLE_LIMIT = '100000';
  process.env.THROTTLE_TTL_SECONDS = '60';
  process.env.AUTH_THROTTLE_LIMIT = '100000';
  process.env.HANDOFF_HMAC_SECRET = randomBytes(32).toString('hex');
  process.env.JWT_ACCESS_SECRET = randomBytes(32).toString('hex');
  process.env.JWT_REFRESH_SECRET = randomBytes(32).toString('hex');
  process.env.JWT_ACCESS_TTL_SECONDS = '900';
  process.env.JWT_REFRESH_TTL_SECONDS = '3600';
  // Nunca se envían correos reales desde las pruebas: quedan en el buzón en memoria.
  process.env.SMTP_HOST = '';
}

export const ADMIN_PASSWORD = 'AdminTest2026ok';

export interface TestApp {
  app: INestApplication;
  http: ReturnType<typeof request>;
  prisma: PrismaService;
  close(): Promise<void>;
}

export async function bootApp(): Promise<TestApp> {
  useTestEnvironment();
  const { Test } = await import('@nestjs/testing');
  const { AppModule } = require('../src/app.module') as typeof import('../src/app.module');
  const { configureApp } = require('../src/app.setup') as typeof import('../src/app.setup');
  const { PrismaService: Prisma } = require('../src/prisma/prisma.service') as typeof import('../src/prisma/prisma.service');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  // Servidor real en puerto efímero: supertest no abre/cierra uno por petición.
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as { port: number };
  const prisma = app.get(Prisma);
  await truncateAll(prisma);
  return {
    app,
    http: request(`http://127.0.0.1:${port}`),
    prisma,
    close: () => app.close(),
  };
}

async function truncateAll(prisma: PrismaService): Promise<void> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export async function createUser(
  t: TestApp,
  data: {
    email: string;
    role: 'ADMIN' | 'CLIENT' | 'SUPERVISOR' | 'DRIVER';
    password?: string;
  },
) {
  return t.prisma.user.create({
    data: {
      email: data.email,
      name: data.email.split('@')[0],
      role: data.role,
      status: 'ACTIVE',
      passwordHash: await argon2.hash(data.password ?? ADMIN_PASSWORD),
    },
  });
}

export async function login(
  t: TestApp,
  email: string,
  password = ADMIN_PASSWORD,
): Promise<string> {
  const res = await t.http
    .post('/api/v1/auth/login')
    .send({ email, password })
    .expect(200);
  return res.body.tokens.accessToken as string;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
