CREATE TABLE "CheckoutSession" (
    "id" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "total" DECIMAL(15,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
    "deliverySnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    CONSTRAINT "CheckoutSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CheckoutSession_reference_key" ON "CheckoutSession"("reference");
CREATE INDEX "CheckoutSession_buyerId_createdAt_idx" ON "CheckoutSession"("buyerId","createdAt");
CREATE INDEX "CheckoutSession_status_createdAt_idx" ON "CheckoutSession"("status","createdAt");
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_buyerId_fkey"
  FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Order"
  ADD COLUMN "deliveryConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "payoutEligibleAt" TIMESTAMP(3),
  ADD COLUMN "payoutReleasedAt" TIMESTAMP(3),
  ADD COLUMN "payoutHoldReason" TEXT,
  ADD COLUMN "adminPayoutHoldReason" TEXT,
  ADD COLUMN "checkoutSessionId" TEXT;
ALTER TABLE "Order" ADD CONSTRAINT "Order_checkoutSessionId_fkey"
  FOREIGN KEY ("checkoutSessionId") REFERENCES "CheckoutSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Order_checkoutSessionId_idx" ON "Order"("checkoutSessionId");

ALTER TABLE "Payment" ALTER COLUMN "orderId" DROP NOT NULL;
ALTER TABLE "Payment" ADD COLUMN "checkoutSessionId" TEXT;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_checkoutSessionId_fkey"
  FOREIGN KEY ("checkoutSessionId") REFERENCES "CheckoutSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Payment_checkoutSessionId_idx" ON "Payment"("checkoutSessionId");

ALTER TABLE "Seller"
  ADD COLUMN "foundingPayoutBenefit" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "foundingCommissionStartsAt" TIMESTAMP(3),
  ADD COLUMN "foundingCommissionExpiresAt" TIMESTAMP(3);
UPDATE "Seller" SET "foundingPayoutBenefit" = true WHERE "foundingSellerActive" = true;

ALTER TABLE "Payout"
  ADD COLUMN "feeAmount" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN "netAmount" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN "transferReference" TEXT,
  ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Payout_transferReference_key" ON "Payout"("transferReference");
CREATE UNIQUE INDEX "Payout_idempotencyKey_key" ON "Payout"("idempotencyKey");

CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "openedByUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "reason" TEXT NOT NULL,
    "evidence" JSONB,
    "resolution" TEXT,
    "resolvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Dispute_orderId_status_idx" ON "Dispute"("orderId","status");
CREATE INDEX "Dispute_status_createdAt_idx" ON "Dispute"("status","createdAt");
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_openedByUserId_fkey"
  FOREIGN KEY ("openedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_resolvedByUserId_fkey"
  FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "WithdrawalRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sellerId" TEXT,
    "accountType" TEXT NOT NULL,
    "requestedAmount" DECIMAL(15,2) NOT NULL,
    "feeAmount" DECIMAL(15,2) NOT NULL,
    "netAmount" DECIMAL(15,2) NOT NULL,
    "transferFeeAmount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "provider" TEXT,
    "transferReference" TEXT,
    "providerRecipientCode" TEXT,
    "providerResponse" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "bankSnapshot" JSONB NOT NULL,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "WithdrawalRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WithdrawalRequest_transferReference_key" ON "WithdrawalRequest"("transferReference");
CREATE UNIQUE INDEX "WithdrawalRequest_idempotencyKey_key" ON "WithdrawalRequest"("idempotencyKey");
CREATE INDEX "WithdrawalRequest_userId_createdAt_idx" ON "WithdrawalRequest"("userId","createdAt");
CREATE INDEX "WithdrawalRequest_status_createdAt_idx" ON "WithdrawalRequest"("status","createdAt");
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "FinancialLedgerEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "sellerId" TEXT,
    "orderId" TEXT,
    "withdrawalId" TEXT,
    "entryType" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "reference" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FinancialLedgerEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FinancialLedgerEntry_idempotencyKey_key" ON "FinancialLedgerEntry"("idempotencyKey");
CREATE INDEX "FinancialLedgerEntry_userId_account_createdAt_idx" ON "FinancialLedgerEntry"("userId","account","createdAt");
CREATE INDEX "FinancialLedgerEntry_sellerId_account_createdAt_idx" ON "FinancialLedgerEntry"("sellerId","account","createdAt");
CREATE INDEX "FinancialLedgerEntry_orderId_createdAt_idx" ON "FinancialLedgerEntry"("orderId","createdAt");
CREATE INDEX "FinancialLedgerEntry_entryType_createdAt_idx" ON "FinancialLedgerEntry"("entryType","createdAt");
ALTER TABLE "FinancialLedgerEntry" ADD CONSTRAINT "FinancialLedgerEntry_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancialLedgerEntry" ADD CONSTRAINT "FinancialLedgerEntry_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancialLedgerEntry" ADD CONSTRAINT "FinancialLedgerEntry_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancialLedgerEntry" ADD CONSTRAINT "FinancialLedgerEntry_withdrawalId_fkey"
  FOREIGN KEY ("withdrawalId") REFERENCES "WithdrawalRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "reference" TEXT,
    "payload" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "processingError" TEXT,
    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentEvent_providerEventId_key" ON "PaymentEvent"("providerEventId");
CREATE INDEX "PaymentEvent_reference_receivedAt_idx" ON "PaymentEvent"("reference","receivedAt");
