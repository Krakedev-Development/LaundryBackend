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
  Public,
  Roles,
  type AuthUser,
} from '../common/decorators/auth.decorators';
import { CreateSlotDto, ListSlotsQuery, UpdateSlotDto } from './dto/slots.dto';
import { SlotsService } from './slots.service';

@Controller('slots')
export class SlotsController {
  constructor(private readonly slots: SlotsService) {}

  // Clientes, visitantes anónimos y choferes ven solo agenda futura con cupo; el personal ve todo.
  @Public()
  @Get()
  list(@Query() query: ListSlotsQuery, @CurrentUser() user?: AuthUser) {
    return this.slots.list(user, query);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Post()
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateSlotDto) {
    return this.slots.create(actor, dto);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Patch(':id')
  update(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSlotDto,
  ) {
    return this.slots.update(actor, id, dto);
  }
}
