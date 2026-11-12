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

export class SetUserStatusDto {
  @IsIn(['ACTIVE', 'SUSPENDED']) status: 'ACTIVE' | 'SUSPENDED';
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

// Contraseña temporal del personal: 8 a 12 caracteres con letras y números.
const TEMP_PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,12}$/;
const TEMP_PASSWORD_MESSAGE =
  'La contraseña temporal debe tener entre 8 y 12 caracteres, con letras y números.';

export class ResetPasswordDto {
  @Matches(TEMP_PASSWORD_RULE, { message: TEMP_PASSWORD_MESSAGE })
  temporaryPassword: string;
}

// Reglas más estrictas que las de la cuenta base: se suman a las heredadas.
export class CreateStaffDto extends BaseAccountDto {
  @MaxLength(50, { message: 'El nombre admite como máximo 50 caracteres.' })
  declare name: string;
  @IsEmail({}, { message: 'Ingresa un correo válido.' })
  @MaxLength(50, { message: 'El correo admite como máximo 50 caracteres.' })
  declare email: string;
  // Celular de Ecuador: 10 dígitos que empiezan por cero.
  @Matches(/^0\d{9}$/, { message: 'El teléfono debe tener 10 dígitos y empezar por 0.' })
  declare phone: string;
  @Matches(TEMP_PASSWORD_RULE, { message: TEMP_PASSWORD_MESSAGE })
  declare temporaryPassword: string;
  @IsIn(['SUPERVISOR', 'ADMIN']) role: 'SUPERVISOR' | 'ADMIN';
  // Obligatorio para el supervisor: su alcance se limita a una sede.
  @IsOptional() @IsUUID() facilityId?: string;
}
