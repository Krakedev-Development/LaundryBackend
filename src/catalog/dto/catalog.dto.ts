import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// Importe monetario no negativo con hasta 2 decimales.
const money = () => (target: object, key: string) => {
  IsNumber({ maxDecimalPlaces: 2 })(target, key);
  Min(0)(target, key);
};

class Activatable {
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CreateGarmentDto {
  @IsString() @IsNotEmpty() @MaxLength(80) name: string;
  @money() basePrice: number;
  @IsOptional() @IsString() @MaxLength(40) icon?: string;
}
export class UpdateGarmentDto extends PartialType(CreateGarmentDto) {
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CreateServiceTypeDto {
  @IsString() @IsNotEmpty() @MaxLength(80) name: string;
  @money() extraPrice: number;
}
export class UpdateServiceTypeDto extends PartialType(CreateServiceTypeDto) {
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CreateExtraDto {
  @IsString() @IsNotEmpty() @MaxLength(80) name: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @money() price: number;
}
export class UpdateExtraDto extends PartialType(CreateExtraDto) {
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CreatePromotionDto {
  @Matches(/^[A-Z0-9_-]{3,32}$/, {
    message: 'El código admite A-Z, 0-9, guion y guion bajo (3 a 32).',
  })
  code: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsIn(['PERCENTAGE', 'FIXED']) discountType: 'PERCENTAGE' | 'FIXED';
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) discountValue: number;
  @IsOptional() @money() minOrderAmount?: number;
  @IsOptional() @Type(() => Date) @IsDate() validFrom?: Date;
  @IsOptional() @Type(() => Date) @IsDate() validUntil?: Date;
  @IsOptional() @IsInt() @Min(1) maxUses?: number;
}
// El código y el tipo de descuento no cambian: pedidos existentes los referencian.
export class UpdatePromotionDto extends Activatable {
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) discountValue?: number;
  @IsOptional() @money() minOrderAmount?: number;
  @IsOptional() @Type(() => Date) @IsDate() validFrom?: Date;
  @IsOptional() @Type(() => Date) @IsDate() validUntil?: Date;
  @IsOptional() @IsInt() @Min(1) maxUses?: number;
}

export class CreateMembershipPlanDto {
  @IsString() @IsNotEmpty() @MaxLength(80) name: string;
  @money() priceMonthly: number;
  @IsOptional() @IsInt() @Min(0) weeklyPickups?: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) garmentDiscountPercent: number;
  @IsArray() @IsString({ each: true }) @MaxLength(200, { each: true }) benefits: string[];
}
export class UpdateMembershipPlanDto extends PartialType(CreateMembershipPlanDto) {
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CreateRewardDto {
  @IsString() @IsNotEmpty() @MaxLength(120) title: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsInt() @Min(1) pointsCost: number;
}
export class UpdateRewardDto extends PartialType(CreateRewardDto) {
  @IsOptional() @IsBoolean() active?: boolean;
}
