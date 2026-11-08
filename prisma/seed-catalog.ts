// Inicializa de forma idempotente el catálogo comercial base y geografía para Guayaquil (USD).
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  type DiscountType,
  Prisma,
  PrismaClient,
} from '../src/generated/prisma/client';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta la variable de entorno ${name}.`);
  return value;
}

const GUAYAQUIL_ZONE = {
  name: 'Guayaquil Centro y Samborondón',
  polygon: [
    { lat: -2.12, lng: -79.92 },
    { lat: -2.12, lng: -79.84 },
    { lat: -2.25, lng: -79.84 },
    { lat: -2.25, lng: -79.92 },
  ],
};

const GUAYAQUIL_FACILITY = {
  name: 'Sede Central Guayaquil',
  address: 'Av. 9 de Octubre y Malecón Simón Bolívar',
  city: 'Guayaquil',
  latitude: new Prisma.Decimal('-2.189400'),
  longitude: new Prisma.Decimal('-79.889100'),
  dailyCapacity: 100,
};

const SERVICES: Array<{
  code: string;
  name: string;
  pricingModel: 'PER_WEIGHT' | 'FIXED';
  extraPrice: Prisma.Decimal;
  minWeightKg?: Prisma.Decimal;
  deliveryHours: number;
}> = [
  {
    code: 'LAV_PESO',
    name: 'Lavado y Doblado por Peso',
    pricingModel: 'PER_WEIGHT',
    extraPrice: new Prisma.Decimal('1.75'),
    minWeightKg: new Prisma.Decimal('3.00'),
    deliveryHours: 24,
  },
  {
    code: 'LAV_PRENDA',
    name: 'Lavado y Planchado por Prenda',
    pricingModel: 'FIXED',
    extraPrice: new Prisma.Decimal('2.50'),
    deliveryHours: 48,
  },
  {
    code: 'DRY_CLEAN',
    name: 'Limpieza en Seco / Dry Cleaning',
    pricingModel: 'FIXED',
    extraPrice: new Prisma.Decimal('5.00'),
    deliveryHours: 72,
  },
];

const GARMENTS: Array<{
  name: string;
  basePrice: Prisma.Decimal;
  icon: string;
}> = [
  {
    name: 'Camisa / Blusa',
    basePrice: new Prisma.Decimal('2.50'),
    icon: 'shirt',
  },
  {
    name: 'Pantalón / Jean',
    basePrice: new Prisma.Decimal('3.00'),
    icon: 'pants',
  },
  {
    name: 'Terno / Traje Completo',
    basePrice: new Prisma.Decimal('8.50'),
    icon: 'suit',
  },
  {
    name: 'Vestido Casual',
    basePrice: new Prisma.Decimal('4.50'),
    icon: 'dress',
  },
  {
    name: 'Edredón / Plumón 2 Plazas',
    basePrice: new Prisma.Decimal('12.00'),
    icon: 'bedding',
  },
];

const EXTRAS: Array<{
  name: string;
  description: string;
  price: Prisma.Decimal;
}> = [
  {
    name: 'Desmanchado Profundo',
    description: 'Tratamiento focalizado para manchas difíciles.',
    price: new Prisma.Decimal('1.50'),
  },
  {
    name: 'Suavizante Hipoalergénico',
    description: 'Fórmula dermatológicamente probada para piel sensible.',
    price: new Prisma.Decimal('0.75'),
  },
  {
    name: 'Perfume Textil Premium',
    description: 'Fragancia de larga duración aplicada en el acabado final.',
    price: new Prisma.Decimal('0.50'),
  },
  {
    name: 'Empaque Protector Rígido',
    description: 'Funda y soporte estructurado para prendas delicadas o trajes.',
    price: new Prisma.Decimal('1.00'),
  },
];

const MEMBERSHIP_PLANS: Array<{
  name: string;
  priceMonthly: Prisma.Decimal;
  garmentDiscountPercent: Prisma.Decimal;
  weeklyPickups: number | null;
  benefits: string[];
}> = [
  {
    name: 'Básico',
    priceMonthly: new Prisma.Decimal('0.00'),
    garmentDiscountPercent: new Prisma.Decimal('0.00'),
    weeklyPickups: 0,
    benefits: ['Tier 1', '0% descuento en prendas', '0 envíos gratis'],
  },
  {
    name: 'Estándar',
    priceMonthly: new Prisma.Decimal('9.99'),
    garmentDiscountPercent: new Prisma.Decimal('10.00'),
    weeklyPickups: 2,
    benefits: ['Tier 2', '10% descuento en prendas', '2 envíos gratis'],
  },
  {
    name: 'Premium',
    priceMonthly: new Prisma.Decimal('19.99'),
    garmentDiscountPercent: new Prisma.Decimal('20.00'),
    weeklyPickups: null,
    benefits: ['Tier 3', '20% descuento en prendas', 'Envíos gratis ilimitados'],
  },
];

const PROMOTIONS: Array<{
  code: string;
  description: string;
  discountType: DiscountType;
  discountValue: Prisma.Decimal;
  minOrderAmount: Prisma.Decimal;
}> = [
  {
    code: 'BIENVENIDO',
    description: '15% de descuento en la primera orden (monto mínimo $10.00)',
    discountType: 'PERCENTAGE',
    discountValue: new Prisma.Decimal('15.00'),
    minOrderAmount: new Prisma.Decimal('10.00'),
  },
];

const REWARDS: Array<{
  title: string;
  description: string;
  category: string;
  pointsCost: number;
}> = [
  {
    title: 'Bolsa Ecológica de Lavandería',
    description: 'Bolsa reutilizable de alta resistencia para tus entregas',
    category: 'Productos',
    pointsCost: 150,
  },
  {
    title: 'Cupón de Entrega a Domicilio Gratis',
    description: 'Cubre el valor de envío de tu siguiente pedido',
    category: 'Descuentos',
    pointsCost: 200,
  },
  {
    title: '15% de Descuento en Pedido por Peso',
    description: 'Aplica 15% de descuento en el total de tu orden',
    category: 'Descuentos',
    pointsCost: 350,
  },
];

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: required('DATABASE_URL') }),
  });

  try {
    console.log('Iniciando seed de catálogo comercial base para Guayaquil (USD)...');

    // 0. Zona y Sede Base de Guayaquil
    let zone = await prisma.zone.findUnique({
      where: { name: GUAYAQUIL_ZONE.name },
    });
    if (zone) {
      console.log(`[Zone] Ya existe: ${zone.name}`);
    } else {
      zone = await prisma.zone.create({
        data: {
          name: GUAYAQUIL_ZONE.name,
          polygon: GUAYAQUIL_ZONE.polygon,
          active: true,
        },
      });
      console.log(`[Zone] Creada: ${zone.name}`);
    }

    const existingFacility = await prisma.facility.findFirst({
      where: { name: GUAYAQUIL_FACILITY.name },
    });
    if (existingFacility) {
      console.log(`[Facility] Ya existe: ${existingFacility.name}`);
    } else {
      await prisma.facility.create({
        data: {
          zoneId: zone.id,
          name: GUAYAQUIL_FACILITY.name,
          address: GUAYAQUIL_FACILITY.address,
          city: GUAYAQUIL_FACILITY.city,
          latitude: GUAYAQUIL_FACILITY.latitude,
          longitude: GUAYAQUIL_FACILITY.longitude,
          dailyCapacity: GUAYAQUIL_FACILITY.dailyCapacity,
          active: true,
        },
      });
      console.log(`[Facility] Creada: ${GUAYAQUIL_FACILITY.name}`);
    }

    // 1. Servicios (ServiceType)
    for (const svc of SERVICES) {
      const existing = await prisma.serviceType.findUnique({
        where: { name: svc.name },
      });
      if (existing) {
        console.log(`[ServiceType] Ya existe: ${svc.name} (${svc.code})`);
      } else {
        await prisma.serviceType.create({
          data: {
            name: svc.name,
            extraPrice: svc.extraPrice,
            active: true,
          },
        });
        console.log(
          `[ServiceType] Creado: ${svc.name} (${svc.code} - ${svc.pricingModel} - $${svc.extraPrice.toFixed(2)} - ${svc.deliveryHours}h)`,
        );
      }
    }

    // 2. Prendas (GarmentType)
    for (const garment of GARMENTS) {
      const existing = await prisma.garmentType.findUnique({
        where: { name: garment.name },
      });
      if (existing) {
        console.log(`[GarmentType] Ya existe: ${garment.name}`);
      } else {
        await prisma.garmentType.create({
          data: {
            name: garment.name,
            basePrice: garment.basePrice,
            icon: garment.icon,
            active: true,
          },
        });
        console.log(
          `[GarmentType] Creado: ${garment.name} ($${garment.basePrice.toFixed(2)})`,
        );
      }
    }

    // 3. Extras (Extra)
    for (const extra of EXTRAS) {
      const existing = await prisma.extra.findUnique({
        where: { name: extra.name },
      });
      if (existing) {
        console.log(`[Extra] Ya existe: ${extra.name}`);
      } else {
        await prisma.extra.create({
          data: {
            name: extra.name,
            description: extra.description,
            price: extra.price,
            active: true,
          },
        });
        console.log(`[Extra] Creado: ${extra.name} ($${extra.price.toFixed(2)})`);
      }
    }

    // 4. Planes de Membresía (MembershipPlan)
    for (const plan of MEMBERSHIP_PLANS) {
      const existing = await prisma.membershipPlan.findUnique({
        where: { name: plan.name },
      });
      if (existing) {
        console.log(`[MembershipPlan] Ya existe: ${plan.name}`);
      } else {
        await prisma.membershipPlan.create({
          data: {
            name: plan.name,
            priceMonthly: plan.priceMonthly,
            garmentDiscountPercent: plan.garmentDiscountPercent,
            weeklyPickups: plan.weeklyPickups,
            benefits: plan.benefits,
            active: true,
          },
        });
        console.log(
          `[MembershipPlan] Creado: ${plan.name} ($${plan.priceMonthly.toFixed(2)}/mes, ${plan.garmentDiscountPercent.toFixed(0)}% dto.)`,
        );
      }
    }

    // 5. Promociones (Promotion)
    for (const promo of PROMOTIONS) {
      const existing = await prisma.promotion.findUnique({
        where: { code: promo.code },
      });
      if (existing) {
        console.log(`[Promotion] Ya existe: ${promo.code}`);
      } else {
        await prisma.promotion.create({
          data: {
            code: promo.code,
            description: promo.description,
            discountType: promo.discountType,
            discountValue: promo.discountValue,
            minOrderAmount: promo.minOrderAmount,
            active: true,
          },
        });
        console.log(
          `[Promotion] Creada: ${promo.code} (${promo.discountValue.toFixed(0)}% - mín. $${promo.minOrderAmount.toFixed(2)})`,
        );
      }
    }

    // 6. Recompensas (Reward)
    for (const reward of REWARDS) {
      const existing = await prisma.reward.findFirst({
        where: { title: reward.title },
      });
      if (existing) {
        console.log(`[Reward] Ya existe: ${reward.title}`);
      } else {
        await prisma.reward.create({
          data: {
            title: reward.title,
            description: reward.description,
            category: reward.category,
            pointsCost: reward.pointsCost,
            active: true,
          },
        });
        console.log(
          `[Reward] Creada: ${reward.title} (${reward.pointsCost} pts - ${reward.category})`,
        );
      }
    }

    console.log('Seed de catálogo comercial completado exitosamente.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
