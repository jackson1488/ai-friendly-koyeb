-- About module: developers, legal documents, FAQ, support and app info.

CREATE TABLE "Developer" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "bio" TEXT NOT NULL,
  "photo" TEXT,
  "github" TEXT,
  "linkedin" TEXT,
  "contribution" TEXT NOT NULL DEFAULT '[]',
  "order" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "Developer_order_createdAt_idx" ON "Developer"("order", "createdAt");

CREATE TABLE "LegalDocument" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "type" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "LegalDocument_type_key" ON "LegalDocument"("type");

CREATE TABLE "FaqItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "question" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "color" TEXT NOT NULL DEFAULT '#667eea',
  "order" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "FaqItem_order_createdAt_idx" ON "FaqItem"("order", "createdAt");

CREATE TABLE "SupportInfo" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "email" TEXT NOT NULL,
  "telegram" TEXT,
  "instagram" TEXT,
  "status" TEXT NOT NULL DEFAULT 'online',
  "avgResponseTime" TEXT NOT NULL DEFAULT '15 минут',
  "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "AppInfo" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "logo" TEXT,
  "socialsJson" TEXT NOT NULL DEFAULT '{}',
  "updatedAt" DATETIME NOT NULL
);
