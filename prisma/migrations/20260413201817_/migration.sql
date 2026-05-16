-- AlterTable
ALTER TABLE "User" ADD COLUMN "age" INTEGER;
ALTER TABLE "User" ADD COLUMN "goals" TEXT DEFAULT '[]';

-- CreateTable
CREATE TABLE "ProChat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "clientChatId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "modelTier" TEXT NOT NULL DEFAULT 'standard',
    "toolMode" TEXT NOT NULL DEFAULT 'chat',
    "messagesJson" TEXT NOT NULL DEFAULT '[]',
    "lastMessage" TEXT NOT NULL DEFAULT '',
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" DATETIME,
    "deletedReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProChat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_IdSequence" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" BIGINT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_IdSequence" ("key", "updatedAt", "value") SELECT "key", "updatedAt", "value" FROM "IdSequence";
DROP TABLE "IdSequence";
ALTER TABLE "new_IdSequence" RENAME TO "IdSequence";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ProChat_userId_isDeleted_updatedAt_idx" ON "ProChat"("userId", "isDeleted", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProChat_userId_clientChatId_key" ON "ProChat"("userId", "clientChatId");
