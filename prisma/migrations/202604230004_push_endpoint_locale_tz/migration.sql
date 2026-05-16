-- Add per-user locale/timezone to push endpoints for localized campaigns and quiet-hours delivery.
ALTER TABLE "UserPushEndpoint" ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'ru';
ALTER TABLE "UserPushEndpoint" ADD COLUMN "timeZone" TEXT NOT NULL DEFAULT 'Asia/Bishkek';
