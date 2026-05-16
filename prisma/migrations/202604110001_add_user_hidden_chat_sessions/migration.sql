-- CreateTable
CREATE TABLE "UserHiddenChatSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "hiddenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserHiddenChatSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserHiddenChatSession_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "UserHiddenChatSession_userId_sessionId_key" ON "UserHiddenChatSession"("userId", "sessionId");

-- CreateIndex
CREATE INDEX "UserHiddenChatSession_userId_hiddenAt_idx" ON "UserHiddenChatSession"("userId", "hiddenAt");

-- CreateIndex
CREATE INDEX "UserHiddenChatSession_sessionId_idx" ON "UserHiddenChatSession"("sessionId");
