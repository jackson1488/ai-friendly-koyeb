const express = require('express');
const { requireAuth } = require('../middlewares/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const { createTicket, getMyTickets } = require('../controllers/ticketController');

/**
 * ticketRoutes.js — обращения пользователя в поддержку.
 *
 * Пользователь создаёт ticket и видит только свои обращения.
 */
const router = express.Router();

router.use(requireAuth);

router.post('/tickets', asyncHandler(createTicket));
router.get('/tickets/me', asyncHandler(getMyTickets));

module.exports = { ticketRoutes: router };
