-- AlterTable
ALTER TABLE "BusinessPolicy" ADD COLUMN     "requireKycForOrders" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Incident" ADD COLUMN     "previousStatus" "OrderStatus";
