import {
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export const DRIVER_STATUSES = ['AVAILABLE', 'ON_SERVICE', 'BREAK', 'OFFLINE'] as const;
export type DriverStatusValue = (typeof DRIVER_STATUSES)[number];

export class ListDriversQuery {
  @IsOptional() @IsUUID() facilityId?: string;
  @IsOptional() @IsIn(DRIVER_STATUSES) status?: DriverStatusValue;
}

export class UpdateDriverDto {
  @IsOptional() @IsUUID() facilityId?: string;
  @IsOptional() @IsString() @MaxLength(80) vehicle?: string;
  @IsOptional() @IsString() @MaxLength(20) plate?: string;
  @IsOptional() @IsIn(DRIVER_STATUSES) status?: DriverStatusValue;
}

// Ubicación real del dispositivo y/o estado. Sin coordenadas (p. ej. GPS desactivado) solo se
// actualiza el estado: la última ubicación conocida no se marca como reciente.
export class UpdateLocationDto {
  @IsOptional() @IsNumber() @IsLatitude() latitude?: number;
  @IsOptional() @IsNumber() @IsLongitude() longitude?: number;
  @IsOptional() @IsIn(DRIVER_STATUSES) status?: DriverStatusValue;
}
