import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateIncidentDto {
  @IsUUID() orderId: string;
  // Clasificación libre (p. ej. DAMAGE, CUSTOMER_ABSENT); el catálogo lo define la operación.
  @IsString() @IsNotEmpty() @MaxLength(60) type: string;
  @IsIn(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  @IsString() @IsNotEmpty() @MaxLength(1000) description: string;
  // Referencias opacas a evidencia; el almacenamiento aún no está definido.
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) evidenceRefs?: string[];
  // Pausa el flujo del pedido (estado INCIDENT) hasta resolver la incidencia.
  @IsOptional() @IsBoolean() holdOrder?: boolean;
}

export class SetIncidentStatusDto {
  @IsIn(['IN_REVIEW', 'RESOLVED', 'CLOSED']) status: 'IN_REVIEW' | 'RESOLVED' | 'CLOSED';
  @IsOptional() @IsString() @MaxLength(1000) resolution?: string;
}
