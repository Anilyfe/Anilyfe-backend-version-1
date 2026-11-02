-- Payment integrity: one active payment per order/checkout session, webhook in-flight
-- claim, and per-order stock reservations so abandoned checkouts can release stock.

ALTER TABLE "Payment" ADD COLUMN "pendingKey" TEXT;
CREATE UNIQUE INDEX "Payment_pendingKey_key" ON "Payment"("pendingKey");

ALTER TABLE "PaymentEvent" ADD COLUMN "processingStartedAt" TIMESTAMP(3);

CREATE TABLE "StockReservation" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockReservation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StockReservation_status_expiresAt_idx" ON "StockReservation"("status","expiresAt");
CREATE INDEX "StockReservation_orderId_idx" ON "StockReservation"("orderId");
CREATE INDEX "StockReservation_variantId_status_idx" ON "StockReservation"("variantId","status");
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill reservations for orders that are still awaiting payment so existing
-- pending checkouts keep their stock hold and become releasable when they expire.
INSERT INTO "StockReservation" ("id", "orderId", "variantId", "quantity", "status", "expiresAt", "createdAt")
SELECT md5(random()::text || clock_timestamp()::text || oi."id"), oi."orderId", oi."variantId", oi."quantity", 'HELD',
       NOW() + INTERVAL '30 minutes', NOW()
FROM "OrderItem" oi
JOIN "Order" o ON o."id" = oi."orderId"
WHERE o."paymentStatus" = 'PENDING'
  AND o."orderStatus" = 'PENDING_PAYMENT'
  AND oi."variantId" IS NOT NULL;
