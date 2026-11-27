import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import {
  AllowWithoutKyc,
  CurrentUser,
  type AuthUser,
} from '../common/decorators/auth.decorators';
import { NotificationsService } from './notifications.service';

class NotificationsQuery {
  @IsOptional() @IsIn(['true', 'false']) unread?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

class RegisterDeviceTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  token: string;

  @IsIn(['IOS', 'ANDROID', 'WEB'])
  platform: 'IOS' | 'ANDROID' | 'WEB';

  @IsIn(['CLIENT', 'DRIVER', 'WEB'])
  appType: 'CLIENT' | 'DRIVER' | 'WEB';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceName?: string;
}

class UnregisterDeviceTokenDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  token?: string;
}

@AllowWithoutKyc()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: NotificationsQuery) {
    return this.notifications.list(user, q);
  }

  @Post('read-all')
  readAll(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user);
  }

  @Post('devices')
  registerDevice(
    @CurrentUser() user: AuthUser,
    @Body() dto: RegisterDeviceTokenDto,
  ) {
    return this.notifications.registerDevice(user, dto);
  }

  @Delete('devices')
  unregisterDevice(
    @CurrentUser() user: AuthUser,
    @Body() dto?: UnregisterDeviceTokenDto,
    @Query('token') queryToken?: string,
  ) {
    const token = (dto?.token ?? queryToken ?? '').trim();
    if (!token) {
      throw new BadRequestException('El token del dispositivo es obligatorio.');
    }
    return this.notifications.unregisterDevice(user, token);
  }

  @Post(':id/read')
  read(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(user, id);
  }
}
