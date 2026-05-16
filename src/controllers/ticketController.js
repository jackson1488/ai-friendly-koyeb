const { z } = require('zod');
const { prisma } = require('../config/prisma');
const { AppError } = require('../utils/errors');

/**
 * ticketController.js — обращения пользователя в поддержку.
 *
 * Controller делает три вещи:
 * - проверяет входящий type/message;
 * - переводит type из клиентского формата в Prisma enum;
 * - отдаёт наружу только безопасные поля ticket.
 */

const ticketSchema = z.object({
  type: z.enum(['technical', 'ban_appeal', 'problem_report', 'other']),
  message: z.string().min(10).max(3000)
});

function toPrismaType(type) {
  // Клиенту удобны lower_case строки, Prisma хранит enum в UPPER_CASE.
  if (type === 'technical') return 'TECHNICAL';
  if (type === 'ban_appeal') return 'BAN_APPEAL';
  if (type === 'problem_report') return 'PROBLEM_REPORT';
  return 'OTHER';
}

function fromPrismaTicket(ticket) {
  // Не отдаём весь объект Prisma как есть.
  // Явно выбираем поля, которые клиенту реально нужны.
  return {
    id: ticket.id,
    type: ticket.type,
    message: ticket.message,
    status: ticket.status,
    adminNote: ticket.adminNote,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt
  };
}

async function createTicket(req, res) {
  const parsed = ticketSchema.safeParse(req.body || {});
  if (!parsed.success) {
    throw new AppError(400, 'Некорректные данные обращения', parsed.error.flatten());
  }

  const created = await prisma.supportTicket.create({
    data: {
      userId: req.user.id,
      type: toPrismaType(parsed.data.type),
      message: parsed.data.message.trim()
    }
  });

  res.status(201).json({
    ok: true,
    ticket: fromPrismaTicket(created)
  });
}

async function getMyTickets(req, res) {
  // Пользователь видит только свои обращения. Это дополнительно гарантирует where userId.
  const tickets = await prisma.supportTicket.findMany({
    where: { userId: req.user.id },
    orderBy: [{ createdAt: 'desc' }]
  });

  res.json({
    tickets: tickets.map(fromPrismaTicket)
  });
}

module.exports = {
  createTicket,
  getMyTickets
};
