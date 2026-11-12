import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class PolygonPointDto {
  @IsLatitude() lat: number;
  @IsLongitude() lng: number;
}

export class CreateZoneDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @IsArray()
  @ArrayMinSize(3, { message: 'El polígono requiere al menos 3 vértices.' })
  @ValidateNested({ each: true })
  @Type(() => PolygonPointDto)
  polygon: PolygonPointDto[];
}

export class UpdateZoneDto extends PartialType(CreateZoneDto) {
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CreateFacilityDto {
  @IsUUID(undefined, { message: 'Selecciona una zona válida.' }) zoneId: string;
  @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @IsString() @IsNotEmpty() @MaxLength(200) address: string;
  @IsOptional() @IsString() @MaxLength(80) city?: string;
  @IsOptional() @IsString() @MaxLength(40) taxId?: string;
  @IsOptional()
  @Matches(/^\+?[0-9\s-]{8,20}$/, { message: 'Teléfono inválido.' })
  phone?: string;
  @IsOptional() @IsString() @MaxLength(120) managerName?: string;
  @IsOptional() @IsObject() openingHours?: Record<string, unknown>;
  @IsLatitude() latitude: number;
  @IsLongitude() longitude: number;
  @IsOptional()
  @IsInt({ message: 'La capacidad diaria debe ser un número entero de kilos.' })
  @Min(1, { message: 'La capacidad diaria debe ser de al menos 1 kg.' })
  dailyCapacity?: number;
}

export class UpdateFacilityDto extends PartialType(CreateFacilityDto) {
  @IsOptional() @IsBoolean() active?: boolean;
}
