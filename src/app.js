const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const cookieParser = require('cookie-parser');
const { env } = require('./config/env');
const { corsOrigin } = require('./config/cors');
const { authRoutes } = require('./routes/authRoutes');
const { chatRoutes } = require('./routes/chatRoutes');
const { moodRoutes } = require('./routes/moodRoutes');
const { adminApiRoutes } = require('./routes/adminRoutes');
const { modesRoutes } = require('./routes/modesRoutes');
const { memoryRoutes } = require('./routes/memoryRoutes');
const { inboxRoutes } = require('./routes/inboxRoutes');
const { pushRoutes } = require('./routes/pushRoutes');
const { proRoutes } = require('./routes/proRoutes');
const { anonRoutes } = require('./routes/anonRoutes');
const { banRoutes } = require('./routes/banRoutes');
const { ticketRoutes } = require('./routes/ticketRoutes');
const { cloudPasswordRoutes } = require('./routes/cloudPasswordRoutes');
const { aboutRoutes } = require('./routes/aboutRoutes');
const { apiRateLimit } = require('./middlewares/rateLimit');
const { notFoundHandler, errorHandler } = require('./middlewares/errorHandler');
const { adminPanelRoutes } = require('./admin/routes');

/**
 * createApp собирает только Express-приложение.
 *
 * Важно: здесь НЕ запускается HTTP server и НЕ создаётся Socket.IO.
 * Это делает `server.js`. Такое разделение удобно:
 * - app.js отвечает за middleware, REST routes, admin panel и error handling;
 * - server.js отвечает за порт, socket.io, cron и graceful shutdown.
 */
function createApp() {
  const app = express();

  /**
   * Базовые настройки Express.
   *
   * etag выключен, потому что API и админка должны отдавать свежие данные, а не
   * спорить с браузерным кешем. `trust proxy` нужен, когда сервер стоит за
   * Cloudflare tunnel/Nginx/hosting proxy: тогда Express правильно читает IP/https.
   */
  app.set('etag', false);
  app.set('trust proxy', env.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, 'admin', 'views'));

  /**
   * Общие middleware применяются до роутов.
   *
   * helmet даёт базовые security headers. CSP выключен осознанно: админка и
   * media/static могут использовать inline/style/assets, а жёсткий CSP без отдельной
   * настройки быстро ломает EJS UI. Если включать CSP позже, делать это отдельной
   * задачей и проверять всю админку.
   */
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  // 25mb нужно для JSON payload с base64 media/изображениями/voice metadata.
  // Для больших файлов лучше multipart через upload middleware, а не JSON.
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(morgan('dev'));

  /**
   * Админка монтируется до `/api`, потому что это server-rendered EJS интерфейс,
   * а не JSON API. У неё свои cookies, views и static assets.
   */
  app.use('/admin/static', express.static(path.resolve(__dirname, 'admin', 'public')));
  app.use('/admin', adminPanelRoutes);

  // Публичные media/uploads: аватары, изображения inbox/тестов, developer photos.
  // CORS здесь нужен, чтобы web-клиент мог показывать картинки с backend-домена.
  app.use('/uploads', cors({ origin: corsOrigin, credentials: true }), express.static(path.resolve(__dirname, '../uploads')));

  // Минимальная проверка, что процесс жив. Удобно для браузера, curl и uptime checks.
  app.get('/', (_req, res) => {
    res.json({
      service: 'ai-mental-backend',
      status: 'ok',
      health: '/health',
      admin: '/admin/login'
    });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'ai-mental-backend' });
  });

  /**
   * Все `/api` ответы запрещаем кешировать.
   *
   * Почему:
   * - access/pro права могут поменяться через админку в реальном времени;
   * - inbox/feed и memory должны возвращать актуальное состояние;
   * - браузерный кеш API часто даёт "призрачные" баги после logout/login.
   */
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });

  /**
   * Порядок `/api` middleware важен:
   * 1. CORS должен стоять до route handlers, иначе browser preflight не пройдёт.
   * 2. Rate limit должен стоять до дорогой бизнес-логики.
   * 3. Routes идут группами по доменам.
   */
  app.use('/api', cors({ origin: corsOrigin, credentials: true }));
  app.use('/api', apiRateLimit);
  app.use('/api', authRoutes);
  app.use('/api', chatRoutes);
  app.use('/api', moodRoutes);
  app.use('/api', modesRoutes);
  app.use('/api', memoryRoutes);
  app.use('/api', inboxRoutes);
  app.use('/api', pushRoutes);
  app.use('/api', proRoutes);
  app.use('/api', anonRoutes);
  app.use('/api', banRoutes);
  app.use('/api', ticketRoutes);
  app.use('/api', cloudPasswordRoutes);
  app.use('/api', aboutRoutes);
  app.use('/api', adminApiRoutes);

  // Эти обработчики должны быть последними: всё, что не поймали routes выше,
  // превращается в 404 или централизованный JSON error.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
