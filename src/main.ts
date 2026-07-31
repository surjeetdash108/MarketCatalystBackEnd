import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as Sentry from '@sentry/node';
import { AppModule } from './app.module';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? 'development',
  enabled: !!process.env.SENTRY_DSN,
  tracesSampleRate: 0,
});

const procLogger = new Logger('Process');
process.on('unhandledRejection', (reason) => {
  Sentry.captureException(reason);
  procLogger.error(`Unhandled promise rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});
process.on('uncaughtException', (err) => {
  Sentry.captureException(err);
  procLogger.error(`Uncaught exception: ${err.stack ?? err.message}`);
});

/**
 * Browser origins allowed to call this service.
 *
 * This was `enableCors()` with no argument, i.e. `*` — harmless while the
 * service was --no-allow-unauthenticated and unreachable from a browser at all.
 * The live role is deliberately public so the ticker-tape SSE stream can be
 * opened from marketcatalyst.web.app, so an allowlist is what keeps that from
 * also meaning "any page on the internet may read this API in a visitor's
 * browser".
 *
 * Unset -> reflect any origin, so local dev and curl are unaffected.
 */
function corsOptions() {
  const raw = (process.env.CORS_ORIGINS ?? '').trim();
  if (!raw) return true;
  const origin = raw.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
  // EventSource cannot send credentials cross-origin anyway and nothing here is
  // cookie-authenticated; leaving this off avoids the `*`-with-credentials
  // combination browsers reject outright.
  return { origin, credentials: false };
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  app.enableCors(corsOptions());
  app.enableShutdownHooks();
  const port = process.env.PORT ?? 4400;
  await app.listen(port);
  const role = (process.env.APP_ROLE ?? 'worker').trim().toLowerCase();
  logger.log(`market-catalyst-backend listening on port ${port} (APP_ROLE=${role})`);
}
bootstrap().catch((err) => {
  new Logger('Bootstrap').error(`Failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
