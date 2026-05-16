-- CreateTable
CREATE TABLE "AvailableModel" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "modelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isFree" BOOLEAN NOT NULL DEFAULT false,
    "isWorking" BOOLEAN NOT NULL DEFAULT false,
    "responseMs" INTEGER,
    "lastTested" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "AvailableModel_modelId_key" ON "AvailableModel"("modelId");

-- CreateIndex
CREATE INDEX "AvailableModel_isWorking_idx" ON "AvailableModel"("isWorking");

-- CreateIndex
CREATE INDEX "AvailableModel_modelId_idx" ON "AvailableModel"("modelId");
