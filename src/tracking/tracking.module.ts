import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { MapboxDirectionsService } from './mapbox-directions.service';
import { OrderEtaService } from './order-eta.service';
import { TrackingGateway } from './tracking.gateway';

@Global()
@Module({
  imports: [
    PrismaModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: { algorithm: 'HS256' },
      }),
    }),
  ],
  providers: [MapboxDirectionsService, TrackingGateway, OrderEtaService],
  exports: [MapboxDirectionsService, TrackingGateway, OrderEtaService],
})
export class TrackingModule {}
