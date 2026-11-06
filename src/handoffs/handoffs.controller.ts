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
import {
  IssueHandoffDto,
  RevokeHandoffDto,
  VerifyHandoffDto,
} from './dto/handoffs.dto';
import { HandoffsService } from './handoffs.service';

@Controller()
export class HandoffsController {
  constructor(private readonly handoffs: HandoffsService) {}

  // Quien presenta (cliente o chofer) genera su código/QR; se muestra una sola vez.
  @Roles('CLIENT', 'DRIVER')
  @Post('orders/:id/handoffs/issue')
  issue(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IssueHandoffDto,
  ) {
    return this.handoffs.issue(user, id, dto);
  }

  // Quien recibe o valida (chofer o personal de la sede) confirma el traspaso.
  @Roles('DRIVER', 'ADMIN', 'SUPERVISOR')
  @Post('orders/:id/handoffs/verify')
  verify(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerifyHandoffDto,
  ) {
    return this.handoffs.verify(user, id, dto);
  }

  @Get('orders/:id/handoffs')
  list(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.handoffs.list(user, id);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Post('handoffs/:id/revoke')
  revoke(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeHandoffDto,
  ) {
    return this.handoffs.revoke(user, id, dto);
  }
}
