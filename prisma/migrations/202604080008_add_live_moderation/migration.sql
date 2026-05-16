-- CreateTable
CREATE TABLE "ChatSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userAId" TEXT NOT NULL,
    "userBId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "room" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "endedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChatSession_userAId_fkey" FOREIGN KEY ("userAId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChatSession_userBId_fkey" FOREIGN KEY ("userBId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChatSessionMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "senderId" TEXT,
    "senderType" TEXT NOT NULL,
    "alias" TEXT,
    "text" TEXT NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedBy" TEXT,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "flagReason" TEXT,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metaJson" TEXT,
    CONSTRAINT "ChatSessionMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChatSessionMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "adminId" TEXT NOT NULL,
    "targetUserId" TEXT,
    "sessionId" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModAction_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ModAction_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ModAction_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT,
    "triggerWord" TEXT,
    "openaiCategory" TEXT,
    "autoAction" TEXT,
    "detailsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ModLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ChatSession_status_startedAt_idx" ON "ChatSession"("status", "startedAt");

-- CreateIndex
CREATE INDEX "ChatSession_userAId_startedAt_idx" ON "ChatSession"("userAId", "startedAt");

-- CreateIndex
CREATE INDEX "ChatSession_userBId_startedAt_idx" ON "ChatSession"("userBId", "startedAt");

-- CreateIndex
CREATE INDEX "ChatSessionMessage_sessionId_sentAt_idx" ON "ChatSessionMessage"("sessionId", "sentAt");

-- CreateIndex
CREATE INDEX "ChatSessionMessage_senderId_sentAt_idx" ON "ChatSessionMessage"("senderId", "sentAt");

-- CreateIndex
CREATE INDEX "ChatSessionMessage_flagged_sentAt_idx" ON "ChatSessionMessage"("flagged", "sentAt");

-- CreateIndex
CREATE INDEX "ModAction_adminId_createdAt_idx" ON "ModAction"("adminId", "createdAt");

-- CreateIndex
CREATE INDEX "ModAction_targetUserId_createdAt_idx" ON "ModAction"("targetUserId", "createdAt");

-- CreateIndex
CREATE INDEX "ModAction_sessionId_createdAt_idx" ON "ModAction"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "ModLog_type_createdAt_idx" ON "ModLog"("type", "createdAt");

-- CreateIndex
CREATE INDEX "ModLog_userId_createdAt_idx" ON "ModLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ModLog_sessionId_createdAt_idx" ON "ModLog"("sessionId", "createdAt");

