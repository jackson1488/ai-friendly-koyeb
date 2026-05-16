-- CreateTable
CREATE TABLE "InboxItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL DEFAULT 'SYSTEM',
    "scope" TEXT NOT NULL DEFAULT 'GLOBAL',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "templateKey" TEXT,
    "segmentKey" TEXT,
    "scheduledAt" DATETIME,
    "publishedAt" DATETIME,
    "expiresAt" DATETIME,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InboxItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InboxItemUserTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InboxItemUserTarget_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InboxItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "InboxItemUserTarget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserInboxDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'UNREAD',
    "progressJson" TEXT NOT NULL DEFAULT '{}',
    "deliveredAt" DATETIME,
    "seenAt" DATETIME,
    "skippedAt" DATETIME,
    "completedAt" DATETIME,
    "dismissedAt" DATETIME,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserInboxDelivery_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InboxItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserInboxDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserPushEndpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'expo',
    "platform" TEXT NOT NULL DEFAULT 'unknown',
    "pushToken" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserPushEndpoint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "InboxItem_status_scheduledAt_idx" ON "InboxItem"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "InboxItem_publishedAt_idx" ON "InboxItem"("publishedAt");

-- CreateIndex
CREATE INDEX "InboxItem_scope_status_idx" ON "InboxItem"("scope", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InboxItemUserTarget_itemId_userId_key" ON "InboxItemUserTarget"("itemId", "userId");

-- CreateIndex
CREATE INDEX "InboxItemUserTarget_userId_createdAt_idx" ON "InboxItemUserTarget"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserInboxDelivery_itemId_userId_key" ON "UserInboxDelivery"("itemId", "userId");

-- CreateIndex
CREATE INDEX "UserInboxDelivery_userId_state_updatedAt_idx" ON "UserInboxDelivery"("userId", "state", "updatedAt");

-- CreateIndex
CREATE INDEX "UserInboxDelivery_userId_updatedAt_idx" ON "UserInboxDelivery"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserPushEndpoint_provider_pushToken_key" ON "UserPushEndpoint"("provider", "pushToken");

-- CreateIndex
CREATE INDEX "UserPushEndpoint_userId_isActive_idx" ON "UserPushEndpoint"("userId", "isActive");
