ALTER TABLE "Seller"
  ADD COLUMN "startingPrice" DECIMAL(15,2),
  ADD COLUMN "hasAcceptedTerms" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "termsAcceptedAt" TIMESTAMP(3);

ALTER TABLE "SellerVerification"
  ADD COLUMN "cacRegistrationNumber" TEXT;
