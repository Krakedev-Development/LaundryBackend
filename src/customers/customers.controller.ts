import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  CurrentUser,
  Roles,
  type AuthUser,
} from '../common/decorators/auth.decorators';
import { CustomersService } from './customers.service';
import { CreateAddressDto, UpdateAddressDto } from './dto/customers.dto';

@Roles('CLIENT')
@Controller('customers/me')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  profile(@CurrentUser() user: AuthUser) {
    return this.customers.profile(user);
  }

  @Get('addresses')
  list(@CurrentUser() user: AuthUser) {
    return this.customers.listAddresses(user);
  }

  @Post('addresses')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateAddressDto) {
    return this.customers.createAddress(user, dto);
  }

  @Patch('addresses/:id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.customers.updateAddress(user, id, dto);
  }

  @HttpCode(204)
  @Delete('addresses/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.deleteAddress(user, id);
  }
}
