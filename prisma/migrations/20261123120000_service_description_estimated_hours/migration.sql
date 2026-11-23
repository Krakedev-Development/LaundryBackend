-- Descripción y tiempo estimado (en horas) de cada servicio del catálogo. Ambos opcionales:
-- los servicios existentes quedan sin ellos hasta que el administrador los complete.
ALTER TABLE "ServiceType" ADD COLUMN     "description" TEXT,
ADD COLUMN     "estimatedHours" INTEGER;
