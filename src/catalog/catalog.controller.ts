import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  CurrentUser,
  Public,
  Roles,
  type AuthUser,
} from '../common/decorators/auth.decorators';
import { CatalogService } from './catalog.service';
import {
  CreateExtraDto,
  CreateGarmentDto,
  CreateMembershipPlanDto,
  CreatePromotionDto,
  CreateRewardDto,
  CreateServiceTypeDto,
  CreateWeightRestrictionDto,
  CreateWeightTierDto,
  UpdateExtraDto,
  UpdateGarmentDto,
  UpdateMembershipPlanDto,
  UpdatePromotionDto,
  UpdateRewardDto,
  UpdateServiceTypeDto,
  UpdateWeightRestrictionDto,
  UpdateWeightTierDto,
} from './dto/catalog.dto';

const isAdmin = (u?: AuthUser) => u?.role === 'ADMIN';

// Lectura: pública (los inactivos solo los ve el administrador autenticado).
// Escritura: solo administrador. No hay borrado: se desactiva para conservar el historial.
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  // ---- Prendas
  @Public()
  @Get('garments')
  garments(@CurrentUser() u?: AuthUser) {
    return this.catalog.list('garmentType', isAdmin(u));
  }
  @Roles('ADMIN')
  @Post('garments')
  createGarment(@CurrentUser() u: AuthUser, @Body() dto: CreateGarmentDto) {
    return this.catalog.create(u, 'garmentType', { ...dto });
  }
  @Roles('ADMIN')
  @Patch('garments/:id')
  updateGarment(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGarmentDto,
  ) {
    return this.catalog.update(u, 'garmentType', id, { ...dto });
  }

  // ---- Servicios
  @Public()
  @Get('services')
  services(@CurrentUser() u?: AuthUser) {
    return this.catalog.list('serviceType', isAdmin(u));
  }
  @Roles('ADMIN')
  @Post('services')
  createService(@CurrentUser() u: AuthUser, @Body() dto: CreateServiceTypeDto) {
    return this.catalog.create(u, 'serviceType', { ...dto });
  }
  @Roles('ADMIN')
  @Patch('services/:id')
  updateService(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateServiceTypeDto,
  ) {
    return this.catalog.update(u, 'serviceType', id, { ...dto });
  }

  // ---- Extras
  @Public()
  @Get('extras')
  extras(@CurrentUser() u?: AuthUser) {
    return this.catalog.list('extra', isAdmin(u));
  }
  @Roles('ADMIN')
  @Post('extras')
  createExtra(@CurrentUser() u: AuthUser, @Body() dto: CreateExtraDto) {
    return this.catalog.create(u, 'extra', { ...dto });
  }
  @Roles('ADMIN')
  @Patch('extras/:id')
  updateExtra(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExtraDto,
  ) {
    return this.catalog.update(u, 'extra', id, { ...dto });
  }

  // ---- Servicio por peso: bolsas (cada una con su precio por libra) y restricciones
  @Public()
  @Get('weight-tiers')
  weightTiers(@CurrentUser() u?: AuthUser) {
    return this.catalog.list('weightTier', isAdmin(u));
  }
  @Roles('ADMIN')
  @Post('weight-tiers')
  createWeightTier(@CurrentUser() u: AuthUser, @Body() dto: CreateWeightTierDto) {
    return this.catalog.create(u, 'weightTier', { ...dto });
  }
  @Roles('ADMIN')
  @Patch('weight-tiers/:id')
  updateWeightTier(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWeightTierDto,
  ) {
    return this.catalog.update(u, 'weightTier', id, { ...dto });
  }

  @Public()
  @Get('weight-restrictions')
  weightRestrictions(@CurrentUser() u?: AuthUser) {
    return this.catalog.list('weightRestriction', isAdmin(u));
  }
  @Roles('ADMIN')
  @Post('weight-restrictions')
  createWeightRestriction(
    @CurrentUser() u: AuthUser,
    @Body() dto: CreateWeightRestrictionDto,
  ) {
    return this.catalog.create(u, 'weightRestriction', { ...dto });
  }
  @Roles('ADMIN')
  @Patch('weight-restrictions/:id')
  updateWeightRestriction(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWeightRestrictionDto,
  ) {
    return this.catalog.update(u, 'weightRestriction', id, { ...dto });
  }

  // ---- Membresías
  @Public()
  @Get('memberships')
  memberships(@CurrentUser() u?: AuthUser) {
    return this.catalog.list('membershipPlan', isAdmin(u));
  }
  @Roles('ADMIN')
  @Post('memberships')
  createMembership(
    @CurrentUser() u: AuthUser,
    @Body() dto: CreateMembershipPlanDto,
  ) {
    return this.catalog.create(u, 'membershipPlan', { ...dto });
  }
  @Roles('ADMIN')
  @Patch('memberships/:id')
  updateMembership(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMembershipPlanDto,
  ) {
    return this.catalog.update(u, 'membershipPlan', id, { ...dto });
  }

  // ---- Recompensas
  @Public()
  @Get('rewards')
  rewards(@CurrentUser() u?: AuthUser) {
    return this.catalog.list('reward', isAdmin(u));
  }
  @Roles('ADMIN')
  @Post('rewards')
  createReward(@CurrentUser() u: AuthUser, @Body() dto: CreateRewardDto) {
    return this.catalog.create(u, 'reward', { ...dto });
  }
  @Roles('ADMIN')
  @Patch('rewards/:id')
  updateReward(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRewardDto,
  ) {
    return this.catalog.update(u, 'reward', id, { ...dto });
  }

  // ---- Promociones
  @Public()
  @Get('promotions')
  promotions() {
    return this.catalog.listPromotions();
  }
  @Roles('ADMIN')
  @Post('promotions')
  createPromotion(@CurrentUser() u: AuthUser, @Body() dto: CreatePromotionDto) {
    return this.catalog.createPromotion(u, dto);
  }
  @Roles('ADMIN')
  @Patch('promotions/:id')
  updatePromotion(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePromotionDto,
  ) {
    return this.catalog.updatePromotion(u, id, dto);
  }
}
