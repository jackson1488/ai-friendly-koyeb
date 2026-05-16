-- CreateTable
CREATE TABLE "ProUsageDaily" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProUsageDaily_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ProUsageDaily_userId_feature_dayKey_key" ON "ProUsageDaily"("userId", "feature", "dayKey");

-- CreateIndex
CREATE INDEX "ProUsageDaily_userId_dayKey_idx" ON "ProUsageDaily"("userId", "dayKey");
