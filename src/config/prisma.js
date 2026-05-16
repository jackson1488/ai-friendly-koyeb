const { PrismaClient } = require('@prisma/client');

/**
 * Единый Prisma Client для всего backend.
 *
 * Почему не создавать `new PrismaClient()` в каждом сервисе:
 * - каждый экземпляр держит своё соединение/пул и увеличивает нагрузку;
 * - в SQLite лишние параллельные подключения быстрее приводят к database locked;
 * - один singleton проще закрыть при shutdown через `prisma.$disconnect()`.
 *
 * Все controllers/services/scripts должны импортировать именно этот `prisma`.
 */
const prisma = new PrismaClient();

module.exports = { prisma };

