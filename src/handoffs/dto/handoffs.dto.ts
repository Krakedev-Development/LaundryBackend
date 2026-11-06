import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { NotEquals } from 'class-validator';

export const HANDOFF_TYPES = [
  'CUSTOMER_TO_DRIVER',
  'DRIVER_TO_FACILITY',
  'FACILITY_TO_DRIVER',
  'DRIVER_TO_CUSTOMER',
  'FACILITY_TO_CUSTOMER',
] as const;
export type HandoffTypeValue = (typeof HANDOFF_TYPES)[number];

export class IssueHandoffDto {
  @IsIn(HANDOFF_TYPES) type: HandoffTypeValue;
}

export class VerifyHandoffDto {
  @IsIn(HANDOFF_TYPES) type: HandoffTypeValue;
  // Exactamente uno: código manual o token del QR.
  @IsOptional() @Matches(/^\d{6}$/, { message: 'El código tiene 6 dígitos.' }) code?: string;
  @IsOptional() @IsString() @MinLength(16) @MaxLength(128) qrToken?: string;
  @IsInt() @Min(1) expectedVersion: number;
  @IsOptional() @IsInt() @Min(0) declaredCount?: number;
  @IsOptional() @IsInt() @Min(0) receivedCount?: number;
  @IsOptional() @IsString() @MaxLength(120) recipientName?: string;
  @IsOptional() @IsString() @MaxLength(80) recipientRelationship?: string;
  @IsOptional() @IsString() @MaxLength(300) notes?: string;
}

export class RevokeHandoffDto {
  @IsString() @MinLength(3) @MaxLength(300) @NotEquals('') reason: string;
}
