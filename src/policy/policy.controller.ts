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
  async active(@CurrentUser() user: AuthUser) {
    const policy = await this.policy.getActive();
    if (!policy) throw new NotFoundException('No hay política configurada.');
    if (user.role === 'ADMIN' || user.role === 'SUPERVISOR') return policy;
    // Cliente y chofer ven solo lo que afecta lo que pagan o deben cumplir.
    return {
      version: policy.version,
      timezone: policy.timezone,
      minimumOrderAmount: policy.minimumOrderAmount,
      taxRate: policy.taxRate,
      taxIncluded: policy.taxIncluded,
      pickupFee: policy.pickupFee,
      deliveryFee: policy.deliveryFee,
      pricePerPound: policy.pricePerPound,
      cutoffMinutes: policy.cutoffMinutes,
      lateCancellationFee: policy.lateCancellationFee,
      noShowFee: policy.noShowFee,
      failedPickupFee: policy.failedPickupFee,
      requireStorePickupSlot: policy.requireStorePickupSlot,
      pointsPerCurrencyUnit: policy.pointsPerCurrencyUnit,
      walletTopUpMin: policy.walletTopUpMin,
      walletTopUpMax: policy.walletTopUpMax,
    };
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
