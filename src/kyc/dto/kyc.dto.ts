import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class SubmitKycDto {
  @IsString() @IsNotEmpty() @MaxLength(40) documentType: string;
  @IsString() @IsNotEmpty() @MaxLength(40) documentNumber: string;
  // Referencias opacas al archivo; se completarán cuando exista proveedor de almacenamiento.
  @IsOptional() @IsString() @MaxLength(300) documentRef?: string;
  @IsOptional() @IsString() @MaxLength(300) selfieRef?: string;
}

export class ReviewKycDto {
  @IsBoolean() approve: boolean;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
