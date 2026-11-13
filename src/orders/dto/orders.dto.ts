import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class OrderItemDto {
  @IsUUID() garmentId: string;
  @IsUUID() serviceId: string;
  @IsInt() @Min(1) quantity: number;
  @IsOptional() @IsString() @MaxLength(300) notes?: string;
}

export class OutboundDto {
  // Solo entrega a domicilio: por defecto la dirección de recogida.
  @IsOptional() @IsUUID() addressId?: string;
  @IsOptional() @IsUUID() slotId?: string;
}

export class CreateOrderDto {
  @IsUUID() facilityId: string;
  @IsIn(['HOME_HOME', 'HOME_STORE']) mode: 'HOME_HOME' | 'HOME_STORE';
  @IsUUID() pickupAddressId: string;
  @IsUUID() pickupSlotId: string;

  // Exactamente uno de los dos: prendas (precio fijo) o una bolsa del servicio por peso.
  // Las libras estimadas y el precio por libra salen de la bolsa, nunca del cliente.
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items?: OrderItemDto[];
  @IsOptional() @IsUUID('all', { message: 'Selecciona una bolsa válida.' }) weightTierId?: string;

  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true }) extraIds?: string[];
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{3,32}$/, { message: 'Código de promoción inválido.' })
  promotionCode?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsIn(['WALLET', 'CARD', 'TRANSFER']) paymentMethodKind?: 'WALLET' | 'CARD' | 'TRANSFER';
  @IsOptional() @ValidateNested() @Type(() => OutboundDto) outbound?: OutboundDto;
}

export class VersionedDto {
  // Versión del pedido que el cliente vio; evita pisar cambios concurrentes.
  @IsInt() @Min(1) expectedVersion: number;
}

export class ScheduleOutboundDto extends VersionedDto {
  @IsUUID() slotId: string;
  @IsOptional() @IsUUID() addressId?: string;
}

export class TransitionDto extends VersionedDto {
  @IsString() @IsNotEmpty() to: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class ConfirmPaymentDto extends VersionedDto {
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class CancelOrderDto extends VersionedDto {
  @IsString() @IsNotEmpty() @MaxLength(300) reason: string;
}

export class AssignDriverDto extends VersionedDto {
  @IsIn(['INBOUND', 'OUTBOUND']) leg: 'INBOUND' | 'OUTBOUND';
  @IsUUID() driverId: string;
}

export class ListOrdersQuery {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}
