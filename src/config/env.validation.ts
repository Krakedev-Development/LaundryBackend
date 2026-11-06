import { plainToInstance } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export class EnvironmentVariables {
  @IsInt() @Min(1) PORT: number;
  @IsString() @IsNotEmpty() DATABASE_URL: string;
  @IsString() @IsOptional() CORS_ORIGINS?: string;
  // Límite de solicitudes por ventana y por cliente (sin valor por defecto).
  @IsInt() @Min(1) THROTTLE_LIMIT: number;
  @IsInt() @Min(1) THROTTLE_TTL_SECONDS: number;
  // Intentos de registro/login por ventana y cliente.
  @IsInt() @Min(1) AUTH_THROTTLE_LIMIT: number;

  // Clave HMAC para los códigos de custodia (>= 32 caracteres).
  @IsString() @MinLength(32) HANDOFF_HMAC_SECRET: string;

  @IsString() @MinLength(32) JWT_ACCESS_SECRET: string;
  @IsInt() @Min(60) JWT_ACCESS_TTL_SECONDS: number;
  @IsString() @MinLength(32) JWT_REFRESH_SECRET: string;
  @IsInt() @Min(300) JWT_REFRESH_TTL_SECONDS: number;
}

export function validateEnv(raw: Record<string, unknown>): EnvironmentVariables {
  const config = plainToInstance(EnvironmentVariables, raw, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(config, { skipMissingProperties: false });
  if (errors.length) {
    const detail = errors
      .map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('\n');
    throw new Error(`Configuracion de entorno invalida:\n${detail}`);
  }
  if (config.JWT_ACCESS_SECRET === config.JWT_REFRESH_SECRET)
    throw new Error('JWT_ACCESS_SECRET y JWT_REFRESH_SECRET deben ser distintos.');
  return config;
}
