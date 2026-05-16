-- AlterTable
ALTER TABLE "User" ADD COLUMN "publicId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_publicId_key" ON "User"("publicId");

