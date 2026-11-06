import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';

@Module({
  imports: [CustomersModule, NotificationsModule],
  controllers: [KycController],
  providers: [KycService],
})
export class KycModule {}
