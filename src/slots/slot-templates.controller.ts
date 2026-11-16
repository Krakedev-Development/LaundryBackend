import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, Roles, type AuthUser } from '../common/decorators/auth.decorators';
import {
  CreateSlotTemplateDto,
  GenerateSlotsDto,
  ListSlotTemplatesQuery,
  UpdateSlotTemplateDto,
} from './dto/slots.dto';
import { SlotTemplatesService } from './slot-templates.service';

// Plantilla semanal de franjas: el servidor mantiene creadas las de los próximos días.
@Roles('ADMIN', 'SUPERVISOR')
@Controller('slot-templates')
export class SlotTemplatesController {
  constructor(private readonly templates: SlotTemplatesService) {}

  @Get()
  list(@CurrentUser() actor: AuthUser, @Query() query: ListSlotTemplatesQuery) {
    return this.templates.list(actor, query);
  }

  @Post()
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateSlotTemplateDto) {
    return this.templates.create(actor, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSlotTemplateDto,
  ) {
    return this.templates.update(actor, id, dto);
  }

  // Genera ya las franjas pendientes (no hace falta esperar la revisión automática).
  @Post('generate')
  generate(@CurrentUser() actor: AuthUser, @Body() dto: GenerateSlotsDto) {
    return this.templates.generateFor(actor, dto.facilityId);
  }
}
