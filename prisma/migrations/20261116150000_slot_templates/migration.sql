-- Plantilla semanal de franjas por sede y tipo de tramo.
CREATE TABLE "SlotTemplate" (
    "id" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "context" "SlotContext" NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlotTemplate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SlotTemplate_weekday_check" CHECK ("weekday" BETWEEN 0 AND 6),
    CONSTRAINT "SlotTemplate_capacity_check" CHECK ("capacity" >= 1)
);

CREATE UNIQUE INDEX "SlotTemplate_facilityId_context_weekday_startTime_endTime_key"
    ON "SlotTemplate"("facilityId", "context", "weekday", "startTime", "endTime");
CREATE INDEX "SlotTemplate_active_weekday_idx" ON "SlotTemplate"("active", "weekday");

ALTER TABLE "SlotTemplate" ADD CONSTRAINT "SlotTemplate_facilityId_fkey"
    FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
