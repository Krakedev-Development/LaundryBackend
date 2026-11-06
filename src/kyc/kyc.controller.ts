import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  CurrentUser,
  Roles,
  type AuthUser,
} from '../common/decorators/auth.decorators';
import { ReviewKycDto, SubmitKycDto } from './dto/kyc.dto';
import { KycService } from './kyc.service';

@Controller('kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Roles('CLIENT')
  @Get('me')
  mine(@CurrentUser() user: AuthUser) {
    return this.kyc.mine(user);
  }

  @Roles('CLIENT')
  @Post('me')
  submit(@CurrentUser() user: AuthUser, @Body() dto: SubmitKycDto) {
    return this.kyc.submit(user, dto);
  }

  // Cola de revisión: por defecto, las verificaciones pendientes.
  @Roles('ADMIN', 'SUPERVISOR')
  @Get()
  queue(@Query('status') status?: string) {
    return this.kyc.queue(status);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Post(':customerId/review')
  review(
    @CurrentUser() actor: AuthUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: ReviewKycDto,
  ) {
    return this.kyc.review(actor, customerId, dto);
  }
}
