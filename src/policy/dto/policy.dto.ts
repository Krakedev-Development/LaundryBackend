import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// Zonas horarias IANA aceptadas por el runtime; se valida contra Intl, no contra una lista fija.
export const isValidTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

// Cada campo opcional omitido queda "sin configurar". No existe ningún valor por defecto.
export class CreatePolicyDto {
  @IsString() @IsNotEmpty() timezone: string;
  @IsString() @IsNotEmpty() @MaxLength(500) reason: string;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) minimumOrderAmount?: number;
  // Fracción: 0.15 = 15 %.
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(1) taxRate?: number;
  @IsOptional() @IsBoolean() taxIncluded?: boolean;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) pickupFee?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) deliveryFee?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) pricePerPound?: number;
  @IsOptional() @IsInt() @Min(0) cutoffMinutes?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) lateCancellationFee?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) noShowFee?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) failedPickupFee?: number;
  @IsBoolean() blockNewOrdersOnCharges: boolean;
  @IsBoolean() enforceDriverLimit: boolean;
  @IsOptional() @IsInt() @Min(1) driverLimit?: number;
  @IsBoolean() driverMayReorder: boolean;
  @IsBoolean() requireStorePickupSlot: boolean;
  // Reenvíos de la verificación de identidad tras un rechazo; sin valor, se usan 3.
  @IsOptional() @IsInt() @Min(0) @Max(10) kycMaxResubmissions?: number;
  @IsOptional() @IsInt() @Min(1) handoffMaxAttempts?: number;
  @IsOptional() @IsInt() @Min(1) handoffTtlMinutes?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) pointsPerCurrencyUnit?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) walletTopUpMin?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) walletTopUpMax?: number;
}
