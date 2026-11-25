import { Module } from '@nestjs/common';
import { ActiveZonesSpatialIndexProvider } from './active-zones-spatial-index.provider';
import { GeoController } from './geo.controller';
import { GeoService } from './geo.service';

@Module({
  controllers: [GeoController],
  providers: [ActiveZonesSpatialIndexProvider, GeoService],
  exports: [GeoService, ActiveZonesSpatialIndexProvider],
})
export class GeoModule {}
