const fs = require('fs');
const path = require('path');
const { prisma } = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { getIo } = require('../socket/io');
const {
  ROLE_COLORS,
  DEFAULT_PRIVACY_MARKDOWN,
  DEFAULT_TERMS_MARKDOWN,
  DEFAULT_SUPPORT_INFO,
  DEFAULT_APP_INFO: DEFAULT_APP_INFO_TEMPLATE,
  looksLikePlaceholderMarkdown
} = require('../constants/aboutDefaults');

/**
 * aboutController.js — backend-источник правды для раздела "О приложении".
 *
 * Здесь лежит всё, что клиент показывает в About:
 * - команда разработчиков;
 * - политика конфиденциальности;
 * - пользовательское соглашение;
 * - FAQ;
 * - контакты поддержки;
 * - название/версия/описание приложения.
 *
 * Клиент не должен хранить эти тексты как истину. Он тянет их отсюда и обновляется
 * через socket events, когда админ меняет данные.
 */

const LEGAL_DEFAULTS = {
  PRIVACY_POLICY: DEFAULT_PRIVACY_MARKDOWN,
  TERMS_OF_SERVICE: DEFAULT_TERMS_MARKDOWN
};

const DEFAULT_SUPPORT = {
  ...DEFAULT_SUPPORT_INFO
};

const DEFAULT_APP_INFO = {
  ...DEFAULT_APP_INFO_TEMPLATE
};

const ROLES = new Set(Object.keys(ROLE_COLORS));

function emitAboutEvent(eventName, payload = {}) {
  // Realtime-обновление не критично для HTTP-запроса.
  // Если socket временно недоступен, данные всё равно сохранены в базе.
  try {
    const io = getIo();
    if (io) {
      io.emit(eventName, payload);
    }
  } catch (_error) {
    // Не блокируем админское сохранение из-за socket.
  }
}

function normalizeLegalType(value) {
  // Клиент может прислать privacy, privacy_policy или privacy-policy.
  // В базе храним строгий enum-like формат.
  const text = `${value || ''}`.trim().toLowerCase();
  if (text === 'privacy' || text === 'privacy_policy' || text === 'privacy-policy') {
    return 'PRIVACY_POLICY';
  }
  if (text === 'terms' || text === 'terms_of_service' || text === 'terms-of-service') {
    return 'TERMS_OF_SERVICE';
  }
  throw new AppError(400, 'Некорректный тип документа');
}

function legalTypeToPublic(value) {
  // Наружу отдаём frontend-friendly значение.
  return value === 'PRIVACY_POLICY' ? 'privacy_policy' : 'terms_of_service';
}

function parseContribution(value) {
  // contribution можно прислать массивом, JSON-строкой или текстом через запятую/строки.
  // На выходе всегда массив коротких тегов.
  if (Array.isArray(value)) {
    return value
      .map((item) => `${item || ''}`.trim())
      .filter(Boolean)
      .slice(0, 20);
  }

  const raw = `${value || ''}`.trim();
  if (!raw) return [];

  if ((raw.startsWith('[') && raw.endsWith(']')) || (raw.startsWith('{') && raw.endsWith('}'))) {
    try {
      const parsed = JSON.parse(raw);
      return parseContribution(parsed);
    } catch (_error) {
      // Если JSON битый, ниже попробуем разобрать как обычный текст.
    }
  }

  return raw
    .split(/[\n,;]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function parseSocials(value) {
  // socials могут прийти объектом из API или JSON-строкой из формы админки.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  const raw = `${value || ''}`.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_error) {
    // Битый JSON игнорируем, чтобы не сломать весь ответ.
  }
  return {};
}

function maybeNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeDeveloper(row) {
  // Prisma row приводим к публичному виду, который ждёт frontend.
  const contributionRaw = `${row?.contribution || '[]'}`.trim();
  let contribution = [];
  try {
    const parsed = JSON.parse(contributionRaw);
    contribution = parseContribution(parsed);
  } catch (_error) {
    contribution = parseContribution(contributionRaw);
  }

  return {
    id: row.id,
    name: row.name,
    role: row.role,
    roleColor: ROLE_COLORS[row.role] || '#667eea',
    bio: row.bio,
    photo: row.photo || null,
    github: row.github || null,
    linkedin: row.linkedin || null,
    contribution,
    order: row.order,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function normalizeFaq(row) {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    category: row.category,
    color: row.color,
    order: row.order,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function normalizeSupport(row) {
  return {
    id: row.id,
    email: row.email,
    telegram: row.telegram || '',
    instagram: row.instagram || '',
    status: `${row.status || 'offline'}`.toLowerCase() === 'online' ? 'online' : 'offline',
    avgResponseTime: row.avgResponseTime || ''
  };
}

function normalizeAppInfo(row) {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    logo: row.logo || '',
    socials: parseSocials(row.socialsJson)
  };
}

function resolveDeveloperPhotoUrl(_req, fileName) {
  // Фото разработчиков лежат в backend/uploads/developers.
  // Наружу отдаём URL, а не путь на диске.
  if (!fileName) return null;
  return `/uploads/developers/${encodeURIComponent(fileName)}`;
}

function resolveUploadPathFromUrl(value) {
  // Нужна для удаления старого фото разработчика.
  // Принимает /uploads/... или полный URL и безопасно переводит в путь на диске.
  const text = `${value || ''}`.trim();
  if (!text) return '';
  const baseUploadDir = path.resolve(__dirname, '../../uploads');

  const normalizeRelative = (candidatePath) => {
    const normalized = `${candidatePath || ''}`.trim();
    if (!normalized) return '';
    const relative = decodeURIComponent(
      normalized.replace(/^\/uploads\//i, '').replace(/^uploads\//i, '')
    );
    if (!relative) return '';
    const targetPath = path.resolve(baseUploadDir, relative);
    const delta = path.relative(baseUploadDir, targetPath);
    if (!delta || delta.startsWith('..') || path.isAbsolute(delta)) return '';
    return targetPath;
  };

  if (text.startsWith('/uploads/') || text.startsWith('uploads/')) {
    return normalizeRelative(text);
  }

  try {
    const parsed = new URL(text);
    const pathname = `${parsed.pathname || ''}`.trim();
    if (!pathname.startsWith('/uploads/')) return '';
    return normalizeRelative(pathname);
  } catch (_error) {
    return '';
  }
}

function deleteDeveloperPhotoIfExists(photoUrl) {
  // Очистка файла best-effort: если удалить не получилось, API не падает.
  const filePath = resolveUploadPathFromUrl(photoUrl);
  if (!filePath) return;
  if (!fs.existsSync(filePath)) return;
  try {
    fs.unlinkSync(filePath);
  } catch (_error) {
    // Старый файл может остаться, но данные в базе уже корректны.
  }
}

async function ensureSupportInfo() {
  // Если support row ещё нет, создаём дефолтную запись.
  return prisma.supportInfo.upsert({
    where: { id: 1 },
    create: { ...DEFAULT_SUPPORT },
    update: {}
  });
}

async function ensureAppInfo() {
  // Аналогично для app info: одна запись с id=1.
  return prisma.appInfo.upsert({
    where: { id: 1 },
    create: { ...DEFAULT_APP_INFO },
    update: {}
  });
}

async function ensureLegalDocument(type) {
  // Если документ отсутствует или ещё placeholder, подставляем нормальный дефолт.
  const existing = await prisma.legalDocument.findUnique({ where: { type } });
  if (!existing) {
    return prisma.legalDocument.create({
      data: {
        type,
        content: LEGAL_DEFAULTS[type] || ''
      }
    });
  }

  if (looksLikePlaceholderMarkdown(existing.content)) {
    return prisma.legalDocument.update({
      where: { id: existing.id },
      data: {
        content: LEGAL_DEFAULTS[type] || existing.content
      }
    });
  }

  return existing;
}

async function listDevelopers(_req, res) {
  const developers = await prisma.developer.findMany({
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }]
  });
  res.json({ items: developers.map(normalizeDeveloper), roleColors: ROLE_COLORS });
}

async function createDeveloper(req, res) {
  const name = `${req.body?.name || ''}`.trim();
  const role = `${req.body?.role || ''}`.trim();
  const bio = `${req.body?.bio || ''}`.trim();
  const github = `${req.body?.github || ''}`.trim();
  const linkedin = `${req.body?.linkedin || ''}`.trim();
  const contribution = parseContribution(req.body?.contribution);

  if (!name) throw new AppError(400, 'Имя разработчика обязательно');
  if (!role || !ROLES.has(role)) throw new AppError(400, 'Некорректная роль разработчика');
  if (!bio) throw new AppError(400, 'Bio обязательно');

  const explicitOrder = maybeNumber(req.body?.order);
  let nextOrder = explicitOrder;
  if (!Number.isFinite(nextOrder)) {
    const max = await prisma.developer.aggregate({ _max: { order: true } });
    nextOrder = (max?._max?.order ?? -1) + 1;
  }

  const photo = req.file?.filename ? resolveDeveloperPhotoUrl(req, req.file.filename) : null;

  const created = await prisma.developer.create({
    data: {
      name,
      role,
      bio,
      photo,
      github: github || null,
      linkedin: linkedin || null,
      contribution: JSON.stringify(contribution),
      order: Math.max(0, Math.floor(nextOrder))
    }
  });

  const payload = normalizeDeveloper(created);
  emitAboutEvent('developer:added', { developer: payload });
  res.status(201).json({ developer: payload });
}

async function updateDeveloper(req, res) {
  const id = `${req.params?.id || ''}`.trim();
  if (!id) throw new AppError(400, 'Developer id is required');

  const existing = await prisma.developer.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'Разработчик не найден');

  const data = {};

  if (req.body?.name !== undefined) {
    const name = `${req.body.name || ''}`.trim();
    if (!name) throw new AppError(400, 'Имя разработчика обязательно');
    data.name = name;
  }

  if (req.body?.role !== undefined) {
    const role = `${req.body.role || ''}`.trim();
    if (!role || !ROLES.has(role)) throw new AppError(400, 'Некорректная роль разработчика');
    data.role = role;
  }

  if (req.body?.bio !== undefined) {
    const bio = `${req.body.bio || ''}`.trim();
    if (!bio) throw new AppError(400, 'Bio обязательно');
    data.bio = bio;
  }

  if (req.body?.github !== undefined) {
    const github = `${req.body.github || ''}`.trim();
    data.github = github || null;
  }

  if (req.body?.linkedin !== undefined) {
    const linkedin = `${req.body.linkedin || ''}`.trim();
    data.linkedin = linkedin || null;
  }

  if (req.body?.contribution !== undefined) {
    data.contribution = JSON.stringify(parseContribution(req.body.contribution));
  }

  if (req.body?.order !== undefined) {
    const order = maybeNumber(req.body.order);
    if (!Number.isFinite(order)) throw new AppError(400, 'Некорректный order');
    data.order = Math.max(0, Math.floor(order));
  }

  if (req.file?.filename) {
    data.photo = resolveDeveloperPhotoUrl(req, req.file.filename);
  }

  const updated = await prisma.developer.update({
    where: { id },
    data
  });

  if (data.photo && existing.photo && existing.photo !== data.photo) {
    deleteDeveloperPhotoIfExists(existing.photo);
  }

  const payload = normalizeDeveloper(updated);
  emitAboutEvent('developer:updated', { developer: payload });
  res.json({ developer: payload });
}

async function deleteDeveloper(req, res) {
  const id = `${req.params?.id || ''}`.trim();
  if (!id) throw new AppError(400, 'Developer id is required');

  const existing = await prisma.developer.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'Разработчик не найден');

  await prisma.developer.delete({ where: { id } });
  deleteDeveloperPhotoIfExists(existing.photo);

  emitAboutEvent('developer:deleted', { id });
  res.json({ ok: true });
}

async function reorderDevelopers(req, res) {
  const items = Array.isArray(req.body) ? req.body : Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items || !items.length) throw new AppError(400, 'Пустой список reorder');

  const normalized = items
    .map((item) => ({
      id: `${item?.id || ''}`.trim(),
      order: maybeNumber(item?.order)
    }))
    .filter((item) => item.id && Number.isFinite(item.order));

  if (!normalized.length) throw new AppError(400, 'Некорректный payload reorder');

  await prisma.$transaction(
    normalized.map((item) =>
      prisma.developer.update({
        where: { id: item.id },
        data: { order: Math.max(0, Math.floor(item.order)) }
      })
    )
  );

  const developers = await prisma.developer.findMany({
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }]
  });

  emitAboutEvent('developer:reordered', {
    items: developers.map((item) => ({ id: item.id, order: item.order }))
  });

  res.json({ items: developers.map(normalizeDeveloper) });
}

async function getLegalDocument(req, res) {
  const type = normalizeLegalType(req.params?.type);
  const doc = await ensureLegalDocument(type);
  res.json({
    document: {
      id: doc.id,
      type: legalTypeToPublic(doc.type),
      content: doc.content,
      updatedAt: doc.updatedAt
    }
  });
}

async function updateLegalDocument(req, res) {
  const type = normalizeLegalType(req.params?.type);
  const content = `${req.body?.content || ''}`.trim();
  if (!content) throw new AppError(400, 'Содержимое документа не может быть пустым');

  const updated = await prisma.legalDocument.upsert({
    where: { type },
    create: { type, content },
    update: { content }
  });

  const payload = {
    id: updated.id,
    type: legalTypeToPublic(updated.type),
    content: updated.content,
    updatedAt: updated.updatedAt
  };
  emitAboutEvent('legal:updated', { document: payload });
  res.json({ document: payload });
}

async function listFaq(_req, res) {
  const items = await prisma.faqItem.findMany({
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }]
  });
  res.json({ items: items.map(normalizeFaq) });
}

async function createFaq(req, res) {
  const question = `${req.body?.question || ''}`.trim();
  const answer = `${req.body?.answer || ''}`.trim();
  const category = `${req.body?.category || ''}`.trim();
  const color = `${req.body?.color || '#667eea'}`.trim() || '#667eea';

  if (!question) throw new AppError(400, 'Вопрос обязателен');
  if (!answer) throw new AppError(400, 'Ответ обязателен');
  if (!category) throw new AppError(400, 'Категория обязательна');

  const explicitOrder = maybeNumber(req.body?.order);
  let nextOrder = explicitOrder;
  if (!Number.isFinite(nextOrder)) {
    const max = await prisma.faqItem.aggregate({ _max: { order: true } });
    nextOrder = (max?._max?.order ?? -1) + 1;
  }

  const created = await prisma.faqItem.create({
    data: {
      question,
      answer,
      category,
      color,
      order: Math.max(0, Math.floor(nextOrder))
    }
  });

  const payload = normalizeFaq(created);
  emitAboutEvent('faq:added', { faq: payload });
  res.status(201).json({ faq: payload });
}

async function updateFaq(req, res) {
  const id = `${req.params?.id || ''}`.trim();
  if (!id) throw new AppError(400, 'FAQ id is required');

  const existing = await prisma.faqItem.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'FAQ не найден');

  const data = {};
  if (req.body?.question !== undefined) {
    const question = `${req.body.question || ''}`.trim();
    if (!question) throw new AppError(400, 'Вопрос обязателен');
    data.question = question;
  }
  if (req.body?.answer !== undefined) {
    const answer = `${req.body.answer || ''}`.trim();
    if (!answer) throw new AppError(400, 'Ответ обязателен');
    data.answer = answer;
  }
  if (req.body?.category !== undefined) {
    const category = `${req.body.category || ''}`.trim();
    if (!category) throw new AppError(400, 'Категория обязательна');
    data.category = category;
  }
  if (req.body?.color !== undefined) {
    const color = `${req.body.color || ''}`.trim();
    data.color = color || '#667eea';
  }
  if (req.body?.order !== undefined) {
    const order = maybeNumber(req.body.order);
    if (!Number.isFinite(order)) throw new AppError(400, 'Некорректный order');
    data.order = Math.max(0, Math.floor(order));
  }

  const updated = await prisma.faqItem.update({ where: { id }, data });
  const payload = normalizeFaq(updated);
  emitAboutEvent('faq:updated', { faq: payload });
  res.json({ faq: payload });
}

async function deleteFaq(req, res) {
  const id = `${req.params?.id || ''}`.trim();
  if (!id) throw new AppError(400, 'FAQ id is required');

  const existing = await prisma.faqItem.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'FAQ не найден');

  await prisma.faqItem.delete({ where: { id } });
  emitAboutEvent('faq:deleted', { id });
  res.json({ ok: true });
}

async function getSupport(_req, res) {
  const support = await ensureSupportInfo();
  res.json({ support: normalizeSupport(support) });
}

async function updateSupport(req, res) {
  const current = await ensureSupportInfo();
  const nextStatusRaw = `${req.body?.status || current.status}`.trim().toLowerCase();
  const nextStatus = nextStatusRaw === 'online' ? 'online' : 'offline';
  const nextEmail = `${req.body?.email ?? current.email}`.trim();
  const nextTelegram = `${req.body?.telegram ?? (current.telegram || '')}`.trim();
  const nextInstagram = `${req.body?.instagram ?? (current.instagram || '')}`.trim();
  const nextAvg = `${req.body?.avg_response_time ?? req.body?.avgResponseTime ?? current.avgResponseTime}`.trim();

  if (!nextEmail) throw new AppError(400, 'Email поддержки обязателен');
  if (!nextAvg) throw new AppError(400, 'Среднее время ответа обязательно');

  const updated = await prisma.supportInfo.update({
    where: { id: 1 },
    data: {
      email: nextEmail,
      telegram: nextTelegram || null,
      instagram: nextInstagram || null,
      avgResponseTime: nextAvg,
      status: nextStatus
    }
  });

  const payload = normalizeSupport(updated);
  emitAboutEvent('support:status_changed', { support: payload });
  res.json({ support: payload });
}

async function getAppInfo(_req, res) {
  const info = await ensureAppInfo();
  res.json({ appInfo: normalizeAppInfo(info) });
}

async function updateAppInfo(req, res) {
  const current = await ensureAppInfo();

  const name = `${req.body?.name ?? current.name}`.trim();
  const version = `${req.body?.version ?? current.version}`.trim();
  const description = `${req.body?.description ?? current.description}`.trim();
  const logo = `${req.body?.logo ?? (current.logo || '')}`.trim();
  const socials = parseSocials(req.body?.socials ?? req.body?.socialsJson ?? current.socialsJson);

  if (!name) throw new AppError(400, 'Название приложения обязательно');
  if (!version) throw new AppError(400, 'Версия приложения обязательна');
  if (!description) throw new AppError(400, 'Описание приложения обязательно');

  const updated = await prisma.appInfo.update({
    where: { id: 1 },
    data: {
      name,
      version,
      description,
      logo: logo || null,
      socialsJson: JSON.stringify(socials || {})
    }
  });

  const payload = normalizeAppInfo(updated);
  emitAboutEvent('appinfo:updated', { appInfo: payload });
  res.json({ appInfo: payload });
}

async function getAboutSummary(_req, res) {
  // Summary нужен для hub-карточек: количество разработчиков, FAQ, статус поддержки.
  const [developerCount, faqCount, support, legalDocs] = await Promise.all([
    prisma.developer.count(),
    prisma.faqItem.count(),
    ensureSupportInfo(),
    prisma.legalDocument.findMany({
      select: { type: true, updatedAt: true }
    })
  ]);

  const legalUpdatedAt = legalDocs.reduce((latest, item) => {
    const currentTs = new Date(item.updatedAt).getTime();
    if (!Number.isFinite(currentTs)) return latest;
    if (!latest) return item.updatedAt;
    return currentTs > new Date(latest).getTime() ? item.updatedAt : latest;
  }, null);

  res.json({
    summary: {
      developerCount,
      faqCount,
      supportStatus: `${support?.status || 'offline'}`.toLowerCase() === 'online' ? 'online' : 'offline',
      supportAvgResponseTime: `${support?.avgResponseTime || ''}`.trim(),
      legalUpdatedAt: legalUpdatedAt || null
    }
  });
}

module.exports = {
  ROLE_COLORS,
  listDevelopers,
  createDeveloper,
  updateDeveloper,
  deleteDeveloper,
  reorderDevelopers,
  getLegalDocument,
  updateLegalDocument,
  listFaq,
  createFaq,
  updateFaq,
  deleteFaq,
  getSupport,
  updateSupport,
  getAppInfo,
  updateAppInfo,
  getAboutSummary
};
