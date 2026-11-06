import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class ManualCreditDto {
  @IsUUID() customerId: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount: number;
  // Comprobante verificable (p. ej. referencia de la transferencia confirmada).
  @IsString() @IsNotEmpty() @MaxLength(120) reference: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsOptional() @IsString() @MaxLength(80) idempotencyKey?: string;
}

export class WaiveChargeDto {
  @IsString() @IsNotEmpty() @MaxLength(300) reason: string;
}

export class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}
