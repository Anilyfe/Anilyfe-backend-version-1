-- Seller identity verification (NIN + face match) and buyer <-> seller chat.
-- Written to be re-runnable, matching the style of the store_messaging migration.

-- 1. KYC result columns on the existing seller verification record. The selfie image
--    itself is never persisted; only the provider verdict is.
ALTER TABLE "SellerVerification" ADD COLUMN IF NOT EXISTS "selfieCapturedAt" TIMESTAMP(3);
ALTER TABLE "SellerVerification" ADD COLUMN IF NOT EXISTS "kycProvider" TEXT;
ALTER TABLE "SellerVerification" ADD COLUMN IF NOT EXISTS "kycStatus" TEXT;
ALTER TABLE "SellerVerification" ADD COLUMN IF NOT EXISTS "kycMatchScore" DECIMAL(5,2);
ALTER TABLE "SellerVerification" ADD COLUMN IF NOT EXISTS "kycAudit" JSONB;
ALTER TABLE "SellerVerification" ADD COLUMN IF NOT EXISTS "faceMatchVerifiedAt" TIMESTAMP(3);

-- 2. Dedicated chat threads: exactly one conversation per buyer x seller pair.
CREATE TABLE IF NOT EXISTS "Conversation" (
    "id" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "sellerUserId" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "buyerUnread" INTEGER NOT NULL DEFAULT 0,
    "sellerUnread" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ChatMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "senderType" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "attachmentUrl" TEXT,
    "attachmentMime" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Conversation_buyerId_sellerId_key" ON "Conversation"("buyerId", "sellerId");

CREATE INDEX IF NOT EXISTS "Conversation_sellerUserId_lastMessageAt_idx" ON "Conversation"("sellerUserId", "lastMessageAt");

CREATE INDEX IF NOT EXISTS "Conversation_buyerId_lastMessageAt_idx" ON "Conversation"("buyerId", "lastMessageAt");

CREATE INDEX IF NOT EXISTS "ChatMessage_conversationId_createdAt_idx" ON "ChatMessage"("conversationId", "createdAt");

ALTER TABLE "Conversation" DROP CONSTRAINT IF EXISTS "Conversation_buyerId_fkey";
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_buyerId_fkey"
  FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Conversation" DROP CONSTRAINT IF EXISTS "Conversation_sellerId_fkey";
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatMessage" DROP CONSTRAINT IF EXISTS "ChatMessage_conversationId_fkey";
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatMessage" DROP CONSTRAINT IF EXISTS "ChatMessage_senderUserId_fkey";
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_senderUserId_fkey"
  FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. The "Art" category is now labelled "Wall Arts"; retitle rows already stored under
--    the old name so the renamed dropdowns keep matching them.
UPDATE "Product" SET "categoryName" = 'Wall Arts' WHERE "categoryName" = 'Art';
UPDATE "Seller" SET "category" = 'Wall Arts' WHERE "category" = 'Art';
