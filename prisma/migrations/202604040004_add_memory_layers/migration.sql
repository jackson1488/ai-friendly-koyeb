-- CreateTable
CREATE TABLE "UserMemoryProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "profileJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserMemoryProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SessionSummary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "chatId" TEXT,
    "summary" TEXT NOT NULL,
    "mood" INTEGER,
    "topics" TEXT NOT NULL,
    "homework" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SessionSummary_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionSummary_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserFact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "emotionalWeight" TEXT NOT NULL,
    "shouldFollowup" BOOLEAN NOT NULL DEFAULT false,
    "followupDate" DATETIME,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserFact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "UserMemoryProfile_userId_key" ON "UserMemoryProfile"("userId");

-- CreateIndex
CREATE INDEX "UserMemoryProfile_userId_idx" ON "UserMemoryProfile"("userId");

-- CreateIndex
CREATE INDEX "SessionSummary_userId_createdAt_idx" ON "SessionSummary"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SessionSummary_chatId_idx" ON "SessionSummary"("chatId");

-- CreateIndex
CREATE INDEX "UserFact_userId_archived_shouldFollowup_idx" ON "UserFact"("userId", "archived", "shouldFollowup");

-- CreateIndex
CREATE UNIQUE INDEX "UserFact_userId_detail_key" ON "UserFact"("userId", "detail");
