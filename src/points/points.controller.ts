import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  CurrentUser,
  Roles,
  type AuthUser,
} from '../common/decorators/auth.decorators';
import { PointsService } from './points.service';

class RedeemDto {
  @IsUUID() rewardId: string;
}

class ReviewRedemptionDto {
  @IsBoolean() approve: boolean;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

@Controller()
export class PointsController {
  constructor(private readonly points: PointsService) {}

  @Roles('CLIENT')
  @Get('points')
  mine(@CurrentUser() user: AuthUser) {
    return this.points.mine(user);
  }

  @Roles('CLIENT')
  @Post('points/redeem')
  redeem(@CurrentUser() user: AuthUser, @Body() dto: RedeemDto) {
    return this.points.redeem(user, dto.rewardId);
  }

  // Cliente: sus solicitudes. Personal: todas, filtrables por estado.
  @Roles('CLIENT', 'ADMIN', 'SUPERVISOR')
  @Get('redemptions')
  list(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return this.points.redemptions(user, status);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Post('redemptions/:id/review')
  review(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewRedemptionDto,
  ) {
    return this.points.review(actor, id, dto);
  }
}
