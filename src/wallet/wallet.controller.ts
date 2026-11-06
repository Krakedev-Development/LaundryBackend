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
import { ManualCreditDto, PageQuery, WaiveChargeDto } from './dto/wallet.dto';
import { WalletService } from './wallet.service';

@Controller()
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Roles('CLIENT')
  @Get('wallet')
  mine(@CurrentUser() user: AuthUser, @Query() q: PageQuery) {
    return this.wallet.myWallet(user, q);
  }

  @Roles('CLIENT')
  @Get('wallet/charges')
  charges(@CurrentUser() user: AuthUser) {
    return this.wallet.myCharges(user);
  }

  @Roles('CLIENT')
  @Post('wallet/charges/:id/pay')
  payCharge(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.wallet.payCharge(user, id);
  }

  @Roles('ADMIN')
  @Post('wallet/credits')
  credit(@CurrentUser() actor: AuthUser, @Body() dto: ManualCreditDto) {
    return this.wallet.manualCredit(actor, dto);
  }

  @Roles('ADMIN')
  @Post('wallet/charges/:id/waive')
  waive(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WaiveChargeDto,
  ) {
    return this.wallet.waiveCharge(actor, id, dto);
  }
}
