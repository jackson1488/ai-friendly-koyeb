-- AlterTable
ALTER TABLE "User" ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "deletedReason" TEXT;

-- AlterTable
ALTER TABLE "Chat" ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Chat" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "Chat" ADD COLUMN "deletedReason" TEXT;

-- AlterTable
ALTER TABLE "UserMemoryProfile" ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UserMemoryProfile" ADD COLUMN "deletedAt" DATETIME;

-- AlterTable
ALTER TABLE "SessionSummary" ADD COLUMN "deletedAt" DATETIME;

-- AlterTable
ALTER TABLE "UserFact" ADD COLUMN "deletedAt" DATETIME;

-- CreateIndex
CREATE INDEX "User_isDeleted_createdAt_idx" ON "User"("isDeleted", "createdAt");

-- CreateIndex
CREATE INDEX "Chat_userId_isDeleted_updatedAt_idx" ON "Chat"("userId", "isDeleted", "updatedAt");

-- CreateIndex
CREATE INDEX "SessionSummary_userId_deletedAt_createdAt_idx" ON "SessionSummary"("userId", "deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "UserFact_userId_deletedAt_archived_idx" ON "UserFact"("userId", "deletedAt", "archived");
