import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  CurrentUser,
  Roles,
  type AuthUser,
} from '../common/decorators/auth.decorators';
import { VersionedDto } from '../orders/dto/orders.dto';
import { AdjustmentsService } from './adjustments.service';
import {
  CreateAdjustmentDto,
  DecideAdjustmentDto,
  RecordWeightDto,
} from './dto/adjustments.dto';

@Controller('orders/:id')
export class AdjustmentsController {
  constructor(private readonly adjustments: AdjustmentsService) {}

  @Roles('ADMIN', 'SUPERVISOR')
  @Post('weight')
  weight(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordWeightDto,
  ) {
    return this.adjustments.recordWeight(user, id, dto);
  }

  @Get('adjustments')
  list(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.adjustments.list(user, id);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Post('adjustments')
  create(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAdjustmentDto,
  ) {
    return this.adjustments.create(user, id, dto);
  }

  @Roles('CLIENT')
  @Post('adjustments/:adjustmentId/decision')
  decide(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('adjustmentId', ParseUUIDPipe) adjustmentId: string,
    @Body() dto: DecideAdjustmentDto,
  ) {
    return this.adjustments.decide(user, id, adjustmentId, dto);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Post('pricing/resolve')
  resolve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VersionedDto,
  ) {
    return this.adjustments.resolve(user, id, dto);
  }
}
