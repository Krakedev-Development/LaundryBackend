// Inicializa de forma idempotente las franjas horarias operativas (TimeSlots)
// para los próximos 14 días en las sedes activas de Guayaquil (America/Guayaquil).
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { nowIn } from '../src/common/time';
import {
  Prisma,
  PrismaClient,
  type SlotContext,
} from '../src/generated/prisma/client';

const TIMEZONE = 'America/Guayaquil';
const DAYS_AHEAD = 14;

const CONTEXTS: SlotContext[] = [
  'DRIVER_PICKUP',
  'DRIVER_DELIVERY',
  'FACILITY_PICKUP',
];

const DAILY_WINDOWS: Array<{
  label: string;
  startTime: string;
  endTime: string;
  capacity: number;
}> = [
  { label: 'Manana', startTime: '08:00', endTime: '12:00', capacity: 10 },
  { label: 'Tarde', startTime: '13:00', endTime: '17:00', capacity: 10 },
  { label: 'Noche', startTime: '17:00', endTime: '20:00', capacity: 10 },
];

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta la variable de entorno ${name}.`);
  return value;
}

function addDaysUtc(baseYmd: string, days: number): { ymd: string; date: Date } {
  const baseMs = new Date(`${baseYmd}T00:00:00.000Z`).getTime();
  const date = new Date(baseMs + days * 24 * 60 * 60 * 1000);
  const ymd = date.toISOString().slice(0, 10);
  return { ymd, date };
}

async function ensureActivePolicy(prisma: PrismaClient): Promise<void> {
  const active = await prisma.businessPolicy.findFirst({
    where: { active: true },
  });
  if (active) {
    console.log(
      `[BusinessPolicy] Politica activa existente: version ${active.version} (${active.timezone})`,
    );
    return;
  }

  const last = await prisma.businessPolicy.findFirst({
    orderBy: { version: 'desc' },
  });
  const created = await prisma.businessPolicy.create({
    data: {
      version: (last?.version ?? 0) + 1,
      active: true,
      timezone: TIMEZONE,
      minimumOrderAmount: new Prisma.Decimal('5.00'),
      taxRate: new Prisma.Decimal('0.1500'),
      taxIncluded: false,
      pickupFee: new Prisma.Decimal('1.50'),
      deliveryFee: new Prisma.Decimal('1.50'),
      pricePerPound: new Prisma.Decimal('0.8000'),
      cutoffMinutes: 120,
      lateCancellationFee: new Prisma.Decimal('3.00'),
      noShowFee: new Prisma.Decimal('3.00'),
      failedPickupFee: new Prisma.Decimal('3.00'),
      blockNewOrdersOnCharges: false,
      enforceDriverLimit: false,
      driverMayReorder: false,
      requireStorePickupSlot: false,
      requireKycForOrders: false,
      handoffMaxAttempts: 3,
      handoffTtlMinutes: 60,
      pointsPerCurrencyUnit: new Prisma.Decimal('1.00'),
      walletTopUpMin: new Prisma.Decimal('5.00'),
      walletTopUpMax: new Prisma.Decimal('500.00'),
      reason: 'Politica comercial base Guayaquil',
    },
  });
  console.log(
    `[BusinessPolicy] Creada politica activa version ${created.version} (${created.timezone})`,
  );
}

async function ensureGuayaquilFacilities(prisma: PrismaClient) {
  let facilities = await prisma.facility.findMany({
    where: { active: true },
    orderBy: { createdAt: 'asc' },
  });

  if (facilities.length > 0) {
    return facilities;
  }

  let zone = await prisma.zone.findUnique({
    where: { name: 'Guayaquil Centro y Samborondón' },
  });
  if (!zone) {
    zone = await prisma.zone.create({
      data: {
        name: 'Guayaquil Centro y Samborondón',
        polygon: [
          { lat: -2.12, lng: -79.92 },
          { lat: -2.12, lng: -79.84 },
          { lat: -2.25, lng: -79.84 },
          { lat: -2.25, lng: -79.92 },
        ],
        active: true,
      },
    });
  }

  const facility = await prisma.facility.create({
    data: {
      zoneId: zone.id,
      name: 'Sede Central Guayaquil',
      address: 'Av. 9 de Octubre y Malecón Simón Bolívar',
      city: 'Guayaquil',
      latitude: new Prisma.Decimal('-2.189400'),
      longitude: new Prisma.Decimal('-79.889100'),
      dailyCapacity: 100,
      active: true,
    },
  });

  facilities = [facility];
  return facilities;
}

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: required('DATABASE_URL') }),
  });

  try {
    console.log(
      `Iniciando seed de franjas horarias (TimeSlots) en zona ${TIMEZONE}...`,
    );

    await ensureActivePolicy(prisma);
    const facilities = await ensureGuayaquilFacilities(prisma);
    const todayYmd = nowIn(TIMEZONE).date;

    let createdCount = 0;
    let skippedCount = 0;

    for (const facility of facilities) {
      console.log(`[Facility] Procesando sede activa: ${facility.name} (${facility.id})`);

      for (let dayOffset = 0; dayOffset < DAYS_AHEAD; dayOffset++) {
        const { date } = addDaysUtc(todayYmd, dayOffset);

        for (const context of CONTEXTS) {
          for (const window of DAILY_WINDOWS) {
            const existing = await prisma.timeSlot.findUnique({
              where: {
                facilityId_context_date_startTime_endTime: {
                  facilityId: facility.id,
                  context,
                  date,
                  startTime: window.startTime,
                  endTime: window.endTime,
                },
              },
            });

            if (existing) {
              skippedCount++;
              continue;
            }

            await prisma.timeSlot.create({
              data: {
                facilityId: facility.id,
                context,
                date,
                startTime: window.startTime,
                endTime: window.endTime,
                capacity: window.capacity,
                active: true,
              },
            });
            createdCount++;
          }
        }
      }
    }

    console.log(
      `Seed de TimeSlots finalizado. Creadas: ${createdCount} | Existentes omitidas: ${skippedCount}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
