-- AlterTable
ALTER TABLE "Ban" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'ANON';

-- RedefineIndex
DROP INDEX IF EXISTS "Ban_userId_isActive_expiresAt_idx";
CREATE INDEX "Ban_userId_scope_isActive_expiresAt_idx" ON "Ban"("userId", "scope", "isActive", "expiresAt");
