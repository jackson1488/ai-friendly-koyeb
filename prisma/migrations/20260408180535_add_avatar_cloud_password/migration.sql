-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "theme" TEXT DEFAULT 'dark',
    "avatar" TEXT,
    "termsAcceptedAt" DATETIME NOT NULL,
    "termsVersion" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "cloudPasswordHash" TEXT,
    "cloudPasswordSetAt" DATETIME,
    "cloudPasswordAttempts" INTEGER NOT NULL DEFAULT 0,
    "cloudPasswordLockedUntil" DATETIME
);
INSERT INTO "new_User" ("createdAt", "displayName", "id", "isBlocked", "passwordHash", "role", "termsAcceptedAt", "termsVersion", "theme", "updatedAt", "username") SELECT "createdAt", "displayName", "id", "isBlocked", "passwordHash", "role", "termsAcceptedAt", "termsVersion", "theme", "updatedAt", "username" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
