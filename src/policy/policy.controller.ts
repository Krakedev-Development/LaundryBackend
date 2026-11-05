import { Body, Controller, Get, NotFoundException, Post } from '@nestjs/common';
import {
  CurrentUser,
  Roles,
  type AuthUser,
} from '../common/decorators/auth.decorators';
import { CreatePolicyDto } from './dto/policy.dto';
import { PolicyService } from './policy.service';

@Controller('policy')
export class PolicyController {
  constructor(private readonly policy: PolicyService) {}

  // Cualquier usuario autenticado consulta la política vigente (cortes, tarifas, IVA).
  @Get()
  async active() {
    const policy = await this.policy.getActive();
    if (!policy) throw new NotFoundException('No hay política configurada.');
    return policy;
  }

  @Roles('ADMIN')
  @Get('history')
  history() {
    return this.policy.history();
  }

  @Roles('ADMIN')
  @Post()
  publish(@CurrentUser() actor: AuthUser, @Body() dto: CreatePolicyDto) {
    return this.policy.publish(actor, dto);
  }
}
