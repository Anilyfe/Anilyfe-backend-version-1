ALTER TABLE "User"
  ADD COLUMN "emailVerificationCodeHash" TEXT,
  ADD COLUMN "emailVerificationExpiresAt" TIMESTAMP(3),
  ADD COLUMN "favoriteAnime" TEXT,
  ADD COLUMN "favoriteCharacter" TEXT;
ALTER TABLE "User" ADD COLUMN "adminNotes" TEXT;

-- Existing accounts predate mandatory email OTP and remain verified.
UPDATE "User" SET "emailVerifiedAt" = COALESCE("emailVerifiedAt", "createdAt")
WHERE "emailVerifiedAt" IS NULL;
