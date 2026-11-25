import {
  BadRequestException,
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
  ConfirmPaymentDto,
  CreateOrderDto,
  FailedPickupDto,
  ListOrdersQuery,
  ScheduleInboundDto,
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
    const idempotencyKey = key?.trim() || undefined;
    if (idempotencyKey && !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey))
      throw new BadRequestException(
        'Idempotency-Key debe tener entre 8 y 128 caracteres (letras, números, . _ : -).',
      );
    return this.orders.create(user, dto, idempotencyKey);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListOrdersQuery) {
    return this.orders.list(user, query);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(user, id);
  }

  @Roles('CLIENT', 'ADMIN', 'SUPERVISOR', 'DRIVER')
  @Get(':id/tracking')
  tracking(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.tracking(user, id);
  }

  // El origen de la ruta es siempre la última posición conocida del chofer. Las coordenadas
  // que envíe quien consulta (driverLat, driverLng, driverHeading) se ignoran: nadie puede
  // pedir rutas a Mapbox desde un origen arbitrario.
  @Roles('CLIENT', 'ADMIN', 'SUPERVISOR', 'DRIVER')
  @Get(':id/route')
  route(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.route(user, id);
  }

  @Roles('CLIENT', 'ADMIN', 'SUPERVISOR', 'DRIVER')
  @Get(':id/eta')
  eta(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.eta(user, id);
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

  // El chofer, en el domicilio, no pudo recoger: la solicitud queda retenida para la sede.
  @Roles('DRIVER')
  @Post(':id/failed-pickup')
  failedPickup(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FailedPickupDto,
  ) {
    return this.orders.failedPickup(user, id, dto);
  }

  // La sede programa una nueva franja de recogida (p. ej. tras una recogida fallida).
  @Roles('ADMIN', 'SUPERVISOR')
  @Put(':id/inbound')
  scheduleInbound(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ScheduleInboundDto,
  ) {
    return this.orders.scheduleInbound(user, id, dto);
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

  // El personal confirma un pago recibido fuera de la app (p. ej. transferencia verificada).
  @Roles('ADMIN', 'SUPERVISOR')
  @Post(':id/confirm-payment')
  confirmPayment(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmPaymentDto,
  ) {
    return this.orders.confirmPayment(user, id, dto);
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
