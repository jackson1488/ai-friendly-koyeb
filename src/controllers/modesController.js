const { prisma } = require('../config/prisma');

/**
 * modesController.js — отдаёт справочники для клиента.
 *
 * Controller — это функция, которая уже получила проверенный запрос от route.
 * Здесь нет сложной логики: просто читаем активные записи из базы и отдаём JSON.
 */

async function getModes(_req, res) {
  // Режимы общения Alma: например разные стили/сценарии ответа.
  // sortOrder нужен, чтобы клиент показывал их в правильном порядке.
  const modes = await prisma.aiMode.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' }
  });

  res.json({ modes });
}

async function getLevels(_req, res) {
  // Уровни — второй справочник рядом с режимами.
  // Неактивные записи не отдаём, чтобы клиент не показывал отключённые варианты.
  const levels = await prisma.aiLevel.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' }
  });

  res.json({ levels });
}

module.exports = { getModes, getLevels };
