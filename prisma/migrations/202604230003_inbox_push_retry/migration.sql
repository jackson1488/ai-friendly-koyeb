-- AlterTable
ALTER TABLE "UserInboxDelivery" ADD COLUMN "pushState" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "UserInboxDelivery" ADD COLUMN "pushAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "UserInboxDelivery" ADD COLUMN "nextPushRetryAt" DATETIME;
ALTER TABLE "UserInboxDelivery" ADD COLUMN "pushedAt" DATETIME;
ALTER TABLE "UserInboxDelivery" ADD COLUMN "lastPushError" TEXT;

-- CreateIndex
CREATE INDEX "UserInboxDelivery_pushState_nextPushRetryAt_updatedAt_idx" ON "UserInboxDelivery"("pushState", "nextPushRetryAt", "updatedAt");
