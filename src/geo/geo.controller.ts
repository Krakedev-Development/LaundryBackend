import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CurrentUser,
  Roles,
  type AuthUser,
} from '../common/decorators/auth.decorators';
import {
  CreateFacilityDto,
  CreateZoneDto,
  UpdateFacilityDto,
  UpdateZoneDto,
} from './dto/geo.dto';
import { GeoService } from './geo.service';

// Lectura: cualquier usuario autenticado (los inactivos solo los ve el administrador).
// Escritura: solo administrador. No hay borrado: se desactiva para conservar el historial.
@Controller()
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  @Get('zones')
  zones(@CurrentUser() user: AuthUser) {
    return this.geo.listZones(user.role === 'ADMIN');
  }

  @Roles('ADMIN')
  @Post('zones')
  createZone(@CurrentUser() actor: AuthUser, @Body() dto: CreateZoneDto) {
    return this.geo.createZone(actor, dto);
  }

  @Roles('ADMIN')
  @Patch('zones/:id')
  updateZone(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateZoneDto,
  ) {
    return this.geo.updateZone(actor, id, dto);
  }

  @Get('facilities')
  facilities(
    @CurrentUser() user: AuthUser,
    @Query('zoneId') zoneId?: string,
  ) {
    return this.geo.listFacilities(user.role === 'ADMIN', zoneId);
  }

  @Get('facilities/:id')
  facility(@Param('id', ParseUUIDPipe) id: string) {
    return this.geo.getFacility(id);
  }

  @Roles('ADMIN')
  @Post('facilities')
  createFacility(
    @CurrentUser() actor: AuthUser,
    @Body() dto: CreateFacilityDto,
  ) {
    return this.geo.createFacility(actor, dto);
  }

  @Roles('ADMIN')
  @Patch('facilities/:id')
  updateFacility(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFacilityDto,
  ) {
    return this.geo.updateFacility(actor, id, dto);
  }
}
