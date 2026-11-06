import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { HandoffsController } from './handoffs.controller';
import { HandoffsService } from './handoffs.service';

@Module({
  imports: [OrdersModule],
  controllers: [HandoffsController],
  providers: [HandoffsService],
})
export class HandoffsModule {}
