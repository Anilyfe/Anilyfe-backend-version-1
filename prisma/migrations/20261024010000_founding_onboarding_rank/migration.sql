-- AlterTable
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "foundingPoliciesAcceptedAt" TIMESTAMP(3);
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "lastNotifiedRank" TEXT;
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "onboardingStep" INTEGER NOT NULL DEFAULT 1;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "FoundingApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "FoundingHubItemType" AS ENUM ('ANNOUNCEMENT', 'OFFER', 'EVENT', 'DOCUMENT', 'EARLY_ACCESS');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "FoundingSellerApplication" (
  "id" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "status" "FoundingApplicationStatus" NOT NULL DEFAULT 'PENDING',
  "productCountSnapshot" INTEGER NOT NULL,
  "checklist" JSONB,
  "termsAcceptedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "reviewedByAdminId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FoundingSellerApplication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FoundingSellerApplication_sellerId_key" ON "FoundingSellerApplication"("sellerId");
CREATE INDEX IF NOT EXISTS "FoundingSellerApplication_status_createdAt_idx" ON "FoundingSellerApplication"("status", "createdAt");

CREATE TABLE IF NOT EXISTS "FoundingHubItem" (
  "id" TEXT NOT NULL,
  "type" "FoundingHubItemType" NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "linkUrl" TEXT,
  "attachmentUrl" TEXT,
  "code" TEXT,
  "terms" TEXT,
  "startsAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "audience" TEXT NOT NULL DEFAULT 'ALL',
  "selectedSellerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "published" BOOLEAN NOT NULL DEFAULT true,
  "createdByAdminId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FoundingHubItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FoundingHubItem_type_published_createdAt_idx" ON "FoundingHubItem"("type", "published", "createdAt");

CREATE TABLE IF NOT EXISTS "FoundingHubRead" (
  "id" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FoundingHubRead_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FoundingHubRead_sellerId_itemId_key" ON "FoundingHubRead"("sellerId", "itemId");

CREATE TABLE IF NOT EXISTS "FoundingHubFeedback" (
  "id" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "adminNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FoundingHubFeedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FoundingHubFeedback_status_createdAt_idx" ON "FoundingHubFeedback"("status", "createdAt");

ALTER TABLE "FoundingSellerApplication" DROP CONSTRAINT IF EXISTS "FoundingSellerApplication_sellerId_fkey";
ALTER TABLE "FoundingSellerApplication" ADD CONSTRAINT "FoundingSellerApplication_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FoundingHubRead" DROP CONSTRAINT IF EXISTS "FoundingHubRead_sellerId_fkey";
ALTER TABLE "FoundingHubRead" ADD CONSTRAINT "FoundingHubRead_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FoundingHubRead" DROP CONSTRAINT IF EXISTS "FoundingHubRead_itemId_fkey";
ALTER TABLE "FoundingHubRead" ADD CONSTRAINT "FoundingHubRead_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "FoundingHubItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FoundingHubFeedback" DROP CONSTRAINT IF EXISTS "FoundingHubFeedback_sellerId_fkey";
ALTER TABLE "FoundingHubFeedback" ADD CONSTRAINT "FoundingHubFeedback_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;
