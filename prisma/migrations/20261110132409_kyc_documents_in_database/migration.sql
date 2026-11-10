/*
  Warnings:

  - You are about to drop the column `requireKycForOrders` on the `BusinessPolicy` table. All the data in the column will be lost.
  - You are about to drop the column `kycDocumentRef` on the `Customer` table. All the data in the column will be lost.
  - You are about to drop the column `kycSelfieRef` on the `Customer` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "KycDocumentType" AS ENUM ('SELFIE', 'ID_FRONT', 'ID_BACK');

-- AlterTable
ALTER TABLE "BusinessPolicy" DROP COLUMN "requireKycForOrders",
ADD COLUMN     "kycMaxResubmissions" INTEGER NOT NULL DEFAULT 3;

-- AlterTable
ALTER TABLE "Customer" DROP COLUMN "kycDocumentRef",
DROP COLUMN "kycSelfieRef",
ADD COLUMN     "kycSubmissions" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "KycDocument" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "submission" INTEGER NOT NULL,
    "type" "KycDocumentType" NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KycDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KycDocument_customerId_submission_type_key" ON "KycDocument"("customerId", "submission", "type");

-- AddForeignKey
ALTER TABLE "KycDocument" ADD CONSTRAINT "KycDocument_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Clientes con una verificacion previa cuentan ese envio.
UPDATE "Customer" SET "kycSubmissions" = 1 WHERE "kycStatus" <> 'NOT_SUBMITTED';
