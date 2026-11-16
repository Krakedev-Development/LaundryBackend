import { Module } from '@nestjs/common';
import { SlotTemplatesController } from './slot-templates.controller';
import { SlotTemplatesService } from './slot-templates.service';
import { SlotsController } from './slots.controller';
import { SlotsService } from './slots.service';

@Module({
  controllers: [SlotsController, SlotTemplatesController],
  providers: [SlotsService, SlotTemplatesService],
  exports: [SlotsService],
})
export class SlotsModule {}
