import { Body, Controller, Post } from '@nestjs/common';
import {
  CurrentUser,
  Roles,
  type AuthUser,
} from '../common/decorators/auth.decorators';
import { CreateDriverDto, CreateStaffDto } from './dto/users.dto';
import { UsersService } from './users.service';

// Las cuentas de chofer y personal las provisiona exclusivamente el administrador.
@Roles('ADMIN')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post('drivers')
  createDriver(@CurrentUser() actor: AuthUser, @Body() dto: CreateDriverDto) {
    return this.users.createDriver(actor, dto);
  }

  @Post('staff')
  createStaff(@CurrentUser() actor: AuthUser, @Body() dto: CreateStaffDto) {
    return this.users.createStaff(actor, dto);
  }
}
