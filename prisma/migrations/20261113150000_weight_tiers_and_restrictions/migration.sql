-- CreateTable
CREATE TABLE "WeightTier" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "estimatedWeightLb" DECIMAL(10,2) NOT NULL,
    "pricePerPound" DECIMAL(12,4) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeightTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeightRestriction" (
    "id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeightRestriction_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "weightTierId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "WeightTier_name_key" ON "WeightTier"("name");

-- CreateIndex
CREATE UNIQUE INDEX "WeightRestriction_text_key" ON "WeightRestriction"("text");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_weightTierId_fkey" FOREIGN KEY ("weightTierId") REFERENCES "WeightTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
