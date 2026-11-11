import { PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsUUID,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateAddressDto {
  @IsString() @IsNotEmpty() @MaxLength(60) title: string;
  @IsString() @IsNotEmpty() @MaxLength(250) fullAddress: string;
  @IsOptional() @IsString() @MaxLength(250) reference?: string;
  @IsLatitude() latitude: number;
  @IsLongitude() longitude: number;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}

export class SetMembershipDto {
  @IsUUID() planId: string;
}

export class UpdateAddressDto extends PartialType(CreateAddressDto) {}
