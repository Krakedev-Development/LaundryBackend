import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class SubmitKycDto {
  // Número de la cédula, digitado por el cliente para contrastarlo con las fotos.
  @IsString()
  @Matches(/^\d{10}$/, { message: 'La cédula debe tener 10 dígitos.' })
  documentNumber: string;
}

export class ReviewKycDto {
  @IsBoolean() approve: boolean;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
