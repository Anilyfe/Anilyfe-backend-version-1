-- Buyer -> seller store conversations. A message is recorded as a support ticket
-- linked to the seller it was sent to, so no separate chat table is needed yet.
ALTER TABLE "SupportTicket" ADD COLUMN IF NOT EXISTS "sellerId" TEXT;

CREATE INDEX IF NOT EXISTS "SupportTicket_sellerId_createdAt_idx" ON "SupportTicket"("sellerId", "createdAt");

ALTER TABLE "SupportTicket" DROP CONSTRAINT IF EXISTS "SupportTicket_sellerId_fkey";
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE SET NULL ON UPDATE CASCADE;
