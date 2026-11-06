import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { WalletModule } from '../wallet/wallet.module';
import { SlotsModule } from '../slots/slots.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PointsModule } from '../points/points.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [
    CustomersModule,
    SlotsModule,
    WalletModule,
    NotificationsModule,
    PointsModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
