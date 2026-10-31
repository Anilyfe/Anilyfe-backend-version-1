ALTER TABLE "User"
  ADD COLUMN "passwordResetTokenHash" TEXT,
  ADD COLUMN "passwordResetExpiresAt" TIMESTAMP(3),
  ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "SellerVerification"
  ADD COLUMN "ninVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "ninVerificationStatus" TEXT,
  ADD COLUMN "ninProvider" TEXT;
ALTER TABLE "SellerVerification" ADD COLUMN "ninProviderResponse" JSONB;

CREATE UNIQUE INDEX "Seller_foundingSellerNumber_key" ON "Seller"("foundingSellerNumber");
