import { Module, forwardRef } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import {
  CustomersController,
  CustomersDirectoryController,
} from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [forwardRef(() => WalletModule)],
  controllers: [CustomersController, CustomersDirectoryController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
