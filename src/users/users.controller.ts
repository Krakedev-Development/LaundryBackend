import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Roles,
  type AuthUser,
} from '../common/decorators/auth.decorators';
import {
  ActivityQueryDto,
  CreateDriverDto,
  CreateStaffDto,
  ResetPasswordDto,
  SetUserStatusDto,
} from './dto/users.dto';
import { UsersService } from './users.service';

// Las cuentas de chofer y personal las provisiona y gestiona exclusivamente el administrador.
@Roles('ADMIN')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post('drivers')
  createDriver(@CurrentUser() actor: AuthUser, @Body() dto: CreateDriverDto) {
    return this.users.createDriver(actor, dto);
  }

  @Get('staff')
  listStaff() {
    return this.users.listStaff();
  }

  @Post('staff')
  createStaff(@CurrentUser() actor: AuthUser, @Body() dto: CreateStaffDto) {
    return this.users.createStaff(actor, dto);
  }

  @Patch(':id/status')
  setStatus(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetUserStatusDto,
  ) {
    return this.users.setStatus(actor, id, dto);
  }

  @Get(':id/activity')
  activity(@Param('id', ParseUUIDPipe) id: string, @Query() query: ActivityQueryDto) {
    return this.users.activity(id, query);
  }

  @Post(':id/reset-password')
  resetPassword(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordDto,
  ) {
    return this.users.resetPassword(actor, id, dto);
  }
}
