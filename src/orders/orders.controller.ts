import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  CurrentUser,
  Roles,
  type AuthUser,
} from '../common/decorators/auth.decorators';
import {
  AssignDriverDto,
  CancelOrderDto,
  CreateOrderDto,
  ListOrdersQuery,
  ScheduleOutboundDto,
  TransitionDto,
  VersionedDto,
} from './dto/orders.dto';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  // Idempotency-Key opcional: un reintento con la misma clave devuelve el pedido ya creado.
  @Roles('CLIENT')
  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateOrderDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.orders.create(user, dto, key?.trim() || undefined);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListOrdersQuery) {
    return this.orders.list(user, query);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(user, id);
  }

  @Post(':id/transitions')
  transition(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionDto,
  ) {
    return this.orders.transition(user, id, dto);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Post(':id/assign')
  assign(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignDriverDto,
  ) {
    return this.orders.assign(user, id, dto);
  }

  @Roles('CLIENT')
  @Put(':id/outbound')
  scheduleOutbound(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ScheduleOutboundDto,
  ) {
    return this.orders.scheduleOutbound(user, id, dto);
  }

  @Roles('CLIENT', 'ADMIN', 'SUPERVISOR')
  @Post(':id/cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelOrderDto,
  ) {
    return this.orders.cancel(user, id, dto);
  }

  // Paga con la billetera lo pendiente (pago inicial o diferencia por ajustes).
  @Roles('CLIENT')
  @Post(':id/pay')
  pay(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VersionedDto,
  ) {
    return this.orders.pay(user, id, dto);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Post(':id/complete')
  complete(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VersionedDto,
  ) {
    return this.orders.complete(user, id, dto);
  }
}
