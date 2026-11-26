// Limpieza de la base de desarrollo:
//  1. Borra las cuentas que crean los scripts de prueba (y todo lo que depende de ellas).
//  2. Opcional: libera un pedido en recogida para que vuelva a la cola de despacho.
//
// Por defecto solo muestra lo que haría. Para ejecutar de verdad:
//   pnpm db:cleanup:test --apply
//   pnpm db:cleanup:test --apply --release=7     (además libera el pedido #7)
//
// Nunca toca cuentas ADMIN ni SUPERVISOR, y se niega a correr con NODE_ENV=production.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../src/generated/prisma/client';

// Correos que generan los scripts de prueba. Cualquier otra cuenta se conserva.
const TEST_EMAIL_PATTERNS = [
  /^cliente\.api\.\d+@laundryfresh\.com$/,
  /^smoke\.[a-z0-9.]+@laundry\.test$/,
];

// Estados desde los que un pedido puede volver a "confirmado, sin chofer".
const RELEASABLE = ['PICKUP_ASSIGNED', 'HEADING_TO_PICKUP', 'ARRIVED_FOR_PICKUP'] as const;

const apply = process.argv.includes('--apply');
const releaseArg = process.argv.find((a) => a.startsWith('--release='));
const releaseNumber = releaseArg ? Number(releaseArg.split('=')[1]) : null;

async function main() {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Este script es solo para la base de desarrollo.');
  if (releaseArg && (!Number.isInteger(releaseNumber) || releaseNumber! <= 0))
    throw new Error('--release debe ser el número del pedido, por ejemplo --release=7.');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL.');

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    console.log(apply ? 'Modo: EJECUTAR' : 'Modo: SOLO MOSTRAR (agrega --apply para ejecutar)');
    console.log(`Base: ${url.replace(/\/\/[^@]*@/, '//***@')}\n`);

    await prisma.$transaction(
      async (tx) => {
        await cleanupTestAccounts(tx);
        if (releaseNumber) await releaseOrder(tx, releaseNumber);
        if (!apply) throw new DryRun();
      },
      { timeout: 60_000 },
    );
    console.log('\nListo. Cambios guardados.');
  } catch (error) {
    if (error instanceof DryRun) {
      console.log('\nNo se guardó nada (modo de prueba).');
      return;
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

class DryRun extends Error {}

async function cleanupTestAccounts(tx: Prisma.TransactionClient) {
  const candidates = await tx.user.findMany({
    where: { role: { in: ['CLIENT', 'DRIVER'] } },
    select: { id: true, email: true, role: true },
  });
  const users = candidates.filter((u) => TEST_EMAIL_PATTERNS.some((p) => p.test(u.email)));
  if (users.length === 0) {
    console.log('No hay cuentas de prueba para borrar.');
    return;
  }
  const userIds = users.map((u) => u.id);
  console.log(`Cuentas de prueba a borrar (${users.length}):`);
  for (const u of users) console.log(`  - ${u.email} (${u.role})`);

  const customers = await tx.customer.findMany({
    where: { userId: { in: userIds } },
    select: { id: true },
  });
  const drivers = await tx.driver.findMany({
    where: { userId: { in: userIds } },
    select: { id: true },
  });
  const customerIds = customers.map((c) => c.id);
  const driverIds = drivers.map((d) => d.id);

  // Pedidos de los clientes de prueba: se borran completos.
  const orders = await tx.order.findMany({
    where: { customerId: { in: customerIds } },
    select: { id: true, number: true },
  });
  const orderIds = orders.map((o) => o.id);
  if (orders.length)
    console.log(`Pedidos de esas cuentas que se borran: ${orders.map((o) => `#${o.number}`).join(', ')}`);

  // Tramos de pedidos de otras personas atendidos por un chofer de prueba: se conserva el
  // pedido y su historial, solo se quita el chofer del tramo.
  const foreignLegs = await tx.fulfillmentLeg.findMany({
    where: { driverId: { in: driverIds }, orderId: { notIn: orderIds } },
    select: { id: true, kind: true, order: { select: { number: true } } },
  });
  for (const leg of foreignLegs)
    console.log(
      `Pedido #${leg.order.number} (de otra cuenta): se quita el chofer de prueba del tramo ${leg.kind}.`,
    );

  if (orderIds.length) {
    const legs = await tx.fulfillmentLeg.findMany({
      where: { orderId: { in: orderIds } },
      select: { id: true },
    });
    const legIds = legs.map((l) => l.id);
    // Devuelve el cupo de las franjas que esos pedidos aún tenían reservado.
    const active = await tx.slotReservation.findMany({
      where: { legId: { in: legIds }, active: true },
      select: { slotId: true },
    });
    for (const r of active)
      await tx.timeSlot.update({
        where: { id: r.slotId },
        data: { reservedCount: { decrement: 1 } },
      });
    await tx.slotReservation.deleteMany({ where: { legId: { in: legIds } } });
    await tx.incident.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.ledgerEntry.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.customerCharge.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.notification.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.driverLocationPoint.updateMany({
      where: { orderId: { in: orderIds } },
      data: { orderId: null },
    });
  }

  if (customerIds.length) {
    const c = { customerId: { in: customerIds } };
    await tx.ledgerEntry.deleteMany({ where: c });
    await tx.customerCharge.deleteMany({ where: c });
    await tx.pointsLedgerEntry.deleteMany({ where: c });
    await tx.rewardRedemption.deleteMany({ where: c });
    await tx.kycDocument.deleteMany({ where: c });
    // El resto (pasos, prendas, eventos, custodia, chat, ajustes) se borra en cascada.
    await tx.order.deleteMany({ where: { id: { in: orderIds } } });
    // Direcciones, métodos de pago y notificaciones se borran en cascada.
    await tx.customer.deleteMany({ where: { id: { in: customerIds } } });
  }

  if (driverIds.length) {
    await tx.fulfillmentLeg.updateMany({
      where: { driverId: { in: driverIds } },
      data: { driverId: null },
    });
    await tx.incident.updateMany({
      where: { driverId: { in: driverIds } },
      data: { driverId: null },
    });
    // Zonas e historial de ubicaciones se borran en cascada.
    await tx.driver.deleteMany({ where: { id: { in: driverIds } } });
  }

  // El registro de auditoría se conserva; solo pierde la referencia a la cuenta borrada.
  await tx.auditLog.updateMany({ where: { actorId: { in: userIds } }, data: { actorId: null } });
  // Sesiones y códigos de recuperación se borran en cascada.
  const { count } = await tx.user.deleteMany({ where: { id: { in: userIds } } });
  console.log(`Cuentas borradas: ${count}.`);
}

async function releaseOrder(tx: Prisma.TransactionClient, number: number) {
  console.log('');
  const order = await tx.order.findFirst({
    where: { number },
    select: { id: true, status: true, version: true },
  });
  if (!order) throw new Error(`No existe el pedido #${number}.`);
  if (!(RELEASABLE as readonly string[]).includes(order.status))
    throw new Error(
      `El pedido #${number} está en ${order.status}; solo se liberan pedidos en ${RELEASABLE.join(', ')}.`,
    );
  const leg = await tx.fulfillmentLeg.findFirst({
    where: { orderId: order.id, kind: 'INBOUND' },
    select: { id: true, driver: { select: { user: { select: { email: true } } } } },
  });
  const { count } = await tx.order.updateMany({
    where: { id: order.id, version: order.version, status: order.status },
    data: { status: 'CONFIRMED', version: { increment: 1 } },
  });
  if (!count) throw new Error(`El pedido #${number} cambió mientras se liberaba; vuelve a intentarlo.`);
  if (leg)
    await tx.fulfillmentLeg.update({
      where: { id: leg.id },
      data: { driverId: null, status: 'SCHEDULED', startedAt: null },
    });
  await tx.orderEvent.create({
    data: {
      orderId: order.id,
      status: 'CONFIRMED',
      title: 'Recogida liberada',
      description: 'Se quitó el chofer asignado; el pedido vuelve a la cola de despacho.',
    },
  });
  await tx.auditLog.create({
    data: {
      action: 'PICKUP_RELEASED',
      entity: 'Order',
      entityId: order.id,
      reason: 'Limpieza de la base de desarrollo',
      before: { status: order.status, driver: leg?.driver?.user.email ?? null },
      after: { status: 'CONFIRMED', driver: null },
    },
  });
  console.log(
    `Pedido #${number}: ${order.status} -> CONFIRMED, sin chofer` +
      (leg?.driver ? ` (antes: ${leg.driver.user.email}).` : '.'),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
