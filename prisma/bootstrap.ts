// Crea el primer administrador a partir de variables de entorno.
// No inserta catálogo, sedes, políticas ni datos de prueba: todo eso lo configura el
// administrador desde la API. Es idempotente: si ya existe un ADMIN, no hace nada.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';
import { PrismaClient } from '../src/generated/prisma/client';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta la variable de entorno ${name}.`);
  return value;
}

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: required('DATABASE_URL') }),
  });
  try {
    if (await prisma.user.findFirst({ where: { role: 'ADMIN' } })) {
      console.log('Ya existe un administrador. No se realizaron cambios.');
      return;
    }
    const email = required('BOOTSTRAP_ADMIN_EMAIL').toLowerCase();
    const password = required('BOOTSTRAP_ADMIN_PASSWORD');
    if (password.length < 12)
      throw new Error('BOOTSTRAP_ADMIN_PASSWORD debe tener al menos 12 caracteres.');
    const admin = await prisma.user.create({
      data: {
        email,
        name: required('BOOTSTRAP_ADMIN_NAME'),
        role: 'ADMIN',
        // Obliga a cambiar la contraseña de arranque en el primer ingreso.
        status: 'PASSWORD_CHANGE_REQUIRED',
        passwordHash: await argon2.hash(password),
      },
    });
    await prisma.auditLog.create({
      data: {
        actorId: admin.id,
        actorRole: 'ADMIN',
        action: 'BOOTSTRAP_ADMIN_CREATED',
        entity: 'User',
        entityId: admin.id,
      },
    });
    console.log(`Administrador creado: ${email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
