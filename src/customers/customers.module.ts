import { Module } from '@nestjs/common';
import {
  CustomersController,
  CustomersDirectoryController,
} from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  controllers: [CustomersController, CustomersDirectoryController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
