import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Min,
} from 'class-validator';

export const SLOT_CONTEXTS = [
  'DRIVER_PICKUP',
  'DRIVER_DELIVERY',
  'FACILITY_PICKUP',
] as const;
export type SlotContextValue = (typeof SLOT_CONTEXTS)[number];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export class CreateSlotDto {
  @IsUUID() facilityId: string;
  @IsIn(SLOT_CONTEXTS) context: SlotContextValue;
  // Día calendario en la zona horaria de la política (AAAA-MM-DD).
  @Matches(DATE, { message: 'date debe tener formato AAAA-MM-DD.' }) date: string;
  @Matches(TIME, { message: 'startTime debe tener formato HH:mm.' }) startTime: string;
  @Matches(TIME, { message: 'endTime debe tener formato HH:mm.' }) endTime: string;
  @IsInt() @Min(1) capacity: number;
}

export class UpdateSlotDto {
  @IsOptional() @IsInt() @Min(1) capacity?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class ListSlotsQuery {
  @IsOptional() @IsUUID() facilityId?: string;
  @IsOptional() @IsIn(SLOT_CONTEXTS) context?: SlotContextValue;
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  // Por defecto solo franjas con cupo; `false` las muestra todas (personal).
  @IsOptional()
  @Type(() => String)
  @IsIn(['true', 'false'])
  onlyAvailable?: 'true' | 'false';
}
