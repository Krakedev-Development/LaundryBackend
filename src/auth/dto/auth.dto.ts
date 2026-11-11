import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,72}$/;
export const PASSWORD_MESSAGE =
  'La contraseña debe tener entre 8 y 72 caracteres, con letras y números.';

export class RegisterDto {
  @IsString() @IsNotEmpty() @MaxLength(50) firstName: string;
  @IsString() @IsNotEmpty() @MaxLength(50) lastName: string;
  @IsEmail() email: string;
  @IsString()
  @Matches(/^\+?[0-9\s-]{8,20}$/, { message: 'Teléfono inválido.' })
  phone: string;
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE }) password: string;
}

export class LoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(1) password: string;
}

export class RefreshDto {
  @IsString() @IsNotEmpty() refreshToken: string;
}

export class ChangePasswordDto {
  @IsString() @IsNotEmpty() currentPassword: string;
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE }) newPassword: string;
}
