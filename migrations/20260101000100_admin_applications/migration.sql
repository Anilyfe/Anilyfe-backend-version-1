-- Extend the existing baseline with controlled administrator applications.
ALTER TYPE "Role" ADD VALUE 'SUPER_ADMIN';

CREATE TYPE "AdminApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "AdminApplication" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "AdminApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "assignedRole" "Role",
    "reviewedByUserId" TEXT,
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminApplication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminApplication_userId_key" ON "AdminApplication"("userId");
CREATE INDEX "AdminApplication_status_createdAt_idx" ON "AdminApplication"("status", "createdAt");

ALTER TABLE "AdminApplication" ADD CONSTRAINT "AdminApplication_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AdminApplication" ADD CONSTRAINT "AdminApplication_reviewedByUserId_fkey"
    FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
