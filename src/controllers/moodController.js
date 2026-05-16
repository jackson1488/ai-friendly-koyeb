const { z } = require('zod');
const { prisma } = require('../config/prisma');

/**
 * moodController.js — дневник настроения пользователя.
 *
 * Это простая история оценок 1..5. Потом эти данные можно использовать в памяти,
 * графиках или контексте Alma.
 */

const createMoodSchema = z.object({
  score: z.number().int().min(1).max(5),
  note: z.string().max(500).optional().nullable()
});

function resolveDateRange(range) {
  // Клиент может попросить all/week/month.
  // Возвращаем дату "с какого момента искать". null значит без ограничения.
  const now = new Date();
  if (range === 'week') {
    const from = new Date(now);
    from.setDate(from.getDate() - 7);
    return from;
  }
  if (range === 'month') {
    const from = new Date(now);
    from.setDate(from.getDate() - 30);
    return from;
  }
  return null;
}

async function createMood(req, res) {
  // Валидируем body прямо здесь, потому что схема маленькая и используется один раз.
  const data = createMoodSchema.parse(req.body);
  const mood = await prisma.moodEntry.create({
    data: {
      userId: req.user.id,
      score: data.score,
      note: data.note || null
    }
  });

  res.status(201).json({ mood });
}

async function listMood(req, res) {
  const range = (req.query.range || 'all').toString();
  const fromDate = resolveDateRange(range);

  const moods = await prisma.moodEntry.findMany({
    where: {
      userId: req.user.id,
      ...(fromDate ? { createdAt: { gte: fromDate } } : {})
    },
    // asc удобно для графика: слева старые точки, справа новые.
    orderBy: { createdAt: 'asc' }
  });

  res.json({ moods });
}

module.exports = { createMood, listMood };
