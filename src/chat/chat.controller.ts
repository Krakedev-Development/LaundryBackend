import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { CurrentUser, type AuthUser } from '../common/decorators/auth.decorators';
import { ChatService } from './chat.service';

class SendMessageDto {
  @IsString() @IsNotEmpty() @MaxLength(1000) text: string;
}

class ListMessagesQuery {
  @IsOptional() @IsDateString() after?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
}

@Controller('orders/:id/messages')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post()
  send(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.chat.send(user, id, dto.text);
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: ListMessagesQuery,
  ) {
    return this.chat.list(user, id, q.after, q.limit);
  }
}
