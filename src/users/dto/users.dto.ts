import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  PASSWORD_MESSAGE,
  PASSWORD_RULE,
} from '../../auth/dto/auth.dto';

class BaseAccountDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @IsEmail() email: string;
  @IsString()
  @Matches(/^\+?[0-9\s-]{8,20}$/, { message: 'Teléfono inválido.' })
  phone: string;
  // Contraseña temporal: la cuenta queda obligada a cambiarla en el primer ingreso.
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  temporaryPassword: string;
}

export class CreateDriverDto extends BaseAccountDto {
  @IsUUID() facilityId: string;
  @IsOptional() @IsString() @MaxLength(80) vehicle?: string;
  @IsOptional() @IsString() @MaxLength(20) plate?: string;
}

export class CreateStaffDto extends BaseAccountDto {
  @IsIn(['SUPERVISOR', 'ADMIN']) role: 'SUPERVISOR' | 'ADMIN';
  // Obligatorio para el supervisor: su alcance se limita a una sede.
  @IsOptional() @IsUUID() facilityId?: string;
}
