import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsString,
  MaxLength,
  Min,
  NotEquals,
} from 'class-validator';

export class RecordWeightDto {
  @IsInt() @Min(1) weightGrams: number;
  @IsInt() @Min(1) expectedVersion: number;
}

export class CreateAdjustmentDto {
  @IsIn(['SERVICE_RECLASSIFICATION', 'EXTRA_ITEM', 'PRICE_ADJUSTMENT'])
  type: 'SERVICE_RECLASSIFICATION' | 'EXTRA_ITEM' | 'PRICE_ADJUSTMENT';
  @IsString() @IsNotEmpty() @MaxLength(300) internalReason: string;
  @IsString() @IsNotEmpty() @MaxLength(300) customerMessage: string;
  // Impacto en el total (con impuesto incluido). Positivo = cobra más; negativo = descuenta.
  @IsNumber({ maxDecimalPlaces: 2 }) @NotEquals(0) amountDifference: number;
  @IsInt() @Min(1) expectedVersion: number;
}

export class DecideAdjustmentDto {
  @IsBoolean() approve: boolean;
  @IsInt() @Min(1) expectedVersion: number;
}
