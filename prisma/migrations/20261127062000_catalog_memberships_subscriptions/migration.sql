-- CreateEnum
CREATE TYPE "MembershipInterval" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "membershipExpiresAt" TIMESTAMP(3),
ADD COLUMN "membershipStartedAt" TIMESTAMP(3),
ADD COLUMN "membershipStatus" "MembershipStatus";

-- AlterTable
ALTER TABLE "GarmentType" ADD COLUMN "category" TEXT,
ADD COLUMN "description" TEXT,
ADD COLUMN "estimatedHours" INTEGER;

-- AlterTable
ALTER TABLE "MembershipPlan" ADD COLUMN "description" TEXT,
ADD COLUMN "includedWeight" DECIMAL(10,2),
ADD COLUMN "interval" "MembershipInterval" NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN "priorityService" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "weightUnit" TEXT NOT NULL DEFAULT 'KG';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "freeLogisticsApplied" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "MembershipSubscription" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "priceCharged" DECIMAL(12,2) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "assignedById" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MembershipSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MembershipSubscription_customerId_status_idx" ON "MembershipSubscription"("customerId", "status");

-- CreateIndex
CREATE INDEX "MembershipSubscription_planId_status_idx" ON "MembershipSubscription"("planId", "status");

-- AddForeignKey
ALTER TABLE "MembershipSubscription" ADD CONSTRAINT "MembershipSubscription_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipSubscription" ADD CONSTRAINT "MembershipSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MembershipPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
