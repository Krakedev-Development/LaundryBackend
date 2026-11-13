import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import {
  CurrentUser,
  Roles,
  type AuthUser,
} from '../common/decorators/auth.decorators';
import {
  ListDriversQuery,
  UpdateDriverDto,
  UpdateLocationDto,
} from './dto/drivers.dto';
import { DriversService } from './drivers.service';

@Controller('drivers')
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  // Las rutas /me se declaran antes de /:id para que no las capture el parámetro.
  @Roles('DRIVER')
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.drivers.me(user);
  }

  @Roles('DRIVER')
  @Patch('me/location')
  updateLocation(@CurrentUser() user: AuthUser, @Body() dto: UpdateLocationDto) {
    return this.drivers.updateLocation(user, dto);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListDriversQuery) {
    return this.drivers.list(user, query);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.drivers.get(user, id);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDriverDto,
  ) {
    return this.drivers.update(user, id, dto);
  }
}
