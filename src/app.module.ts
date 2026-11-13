import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppThrottlerGuard } from './common/guards/app-throttler.guard';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { GeoModule } from './geo/geo.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { KycGuard } from './common/guards/kyc.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { validateEnv } from './config/env.validation';
import { CustomersModule } from './customers/customers.module';
import { WalletModule } from './wallet/wallet.module';
import { AdjustmentsModule } from './adjustments/adjustments.module';
import { HandoffsModule } from './handoffs/handoffs.module';
import { ChatModule } from './chat/chat.module';
import { IncidentsModule } from './incidents/incidents.module';
import { KycModule } from './kyc/kyc.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PointsModule } from './points/points.module';
import { OrdersModule } from './orders/orders.module';
import { SlotsModule } from './slots/slots.module';
import { PolicyModule } from './policy/policy.module';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { DriversModule } from './drivers/drivers.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const ttl = config.getOrThrow<number>('THROTTLE_TTL_SECONDS') * 1000;
        return [
          { name: 'default', ttl, limit: config.getOrThrow<number>('THROTTLE_LIMIT') },
          // Freno adicional contra fuerza bruta: solo aplica a registro e inicio de sesión.
          {
            name: 'auth',
            ttl,
            limit: config.getOrThrow<number>('AUTH_THROTTLE_LIMIT'),
            skipIf: (ctx) =>
              !['register', 'login'].includes(ctx.getHandler().name),
          },
        ];
      },
    }),
    PrismaModule,
    PolicyModule,
    AuthModule,
    UsersModule,
    DriversModule,
    GeoModule,
    CatalogModule,
    SlotsModule,
    CustomersModule,
    WalletModule,
    OrdersModule,
    HandoffsModule,
    AdjustmentsModule,
    NotificationsModule,
    PointsModule,
    KycModule,
    IncidentsModule,
    ChatModule,
  ],
  providers: [
    // Orden: límite de tasa, autenticación, autorización por rol.
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: KycGuard },
  ],
})
export class AppModule {}
