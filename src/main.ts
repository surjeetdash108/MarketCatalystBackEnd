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

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.enableShutdownHooks();
  const port = process.env.PORT ?? 4100;
  await app.listen(port);
  logger.log(`market-catalyst-backend listening on port ${port}`);
}
bootstrap().catch((err) => {
  new Logger('Bootstrap').error(`Failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
