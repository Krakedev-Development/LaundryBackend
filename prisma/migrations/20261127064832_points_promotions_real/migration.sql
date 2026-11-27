-- CreateEnum
CREATE TYPE "RewardFulfillmentType" AS ENUM ('NONE', 'WALLET_CREDIT', 'PROMO_COUPON');

-- AlterTable
ALTER TABLE "PointsLedgerEntry" ADD COLUMN     "actorId" UUID,
ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "Promotion" ADD COLUMN     "customerId" UUID,
ADD COLUMN     "firstOrderOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maxUsesPerCustomer" INTEGER,
ADD COLUMN     "name" TEXT;

-- AlterTable
ALTER TABLE "Reward" ADD COLUMN     "couponDiscountType" "DiscountType",
ADD COLUMN     "couponDiscountValue" DECIMAL(12,2),
ADD COLUMN     "couponMinOrderAmount" DECIMAL(12,2),
ADD COLUMN     "couponValidityDays" INTEGER,
ADD COLUMN     "fulfillmentType" "RewardFulfillmentType" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "walletCreditAmount" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "RewardRedemption" ADD COLUMN     "generatedPromoCode" TEXT,
ADD COLUMN     "generatedPromotionId" UUID,
ADD COLUMN     "ledgerEntryId" UUID,
ADD COLUMN     "walletCreditAmount" DECIMAL(12,2);

-- CreateIndex
CREATE INDEX "Promotion_customerId_idx" ON "Promotion"("customerId");

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
