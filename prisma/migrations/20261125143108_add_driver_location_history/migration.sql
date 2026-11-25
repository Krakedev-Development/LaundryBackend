-- CreateTable
CREATE TABLE "DriverLocationPoint" (
    "id" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "orderId" UUID,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "heading" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverLocationPoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DriverLocationPoint_driverId_recordedAt_idx" ON "DriverLocationPoint"("driverId", "recordedAt");

-- CreateIndex
CREATE INDEX "DriverLocationPoint_orderId_recordedAt_idx" ON "DriverLocationPoint"("orderId", "recordedAt");

-- AddForeignKey
ALTER TABLE "DriverLocationPoint" ADD CONSTRAINT "DriverLocationPoint_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverLocationPoint" ADD CONSTRAINT "DriverLocationPoint_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
