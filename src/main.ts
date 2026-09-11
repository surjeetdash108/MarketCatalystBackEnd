import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import * as Sentry from "@sentry/node";
import { json, urlencoded } from "express";
import { AppModule } from "./app.module";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? "development",
  enabled: !!process.env.SENTRY_DSN,
  tracesSampleRate: 0,
});

const procLogger = new Logger("Process");
process.on("unhandledRejection", (reason) => {
  Sentry.captureException(reason);
  procLogger.error(
    `Unhandled promise rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  );
});
process.on("uncaughtException", (err) => {
  Sentry.captureException(err);
  procLogger.error(`Uncaught exception: ${err.stack ?? err.message}`);
});

/**
 * Conservative same-app default allowlist, used when CORS_ORIGINS is unset.
 *
 * These are the app's own known browser origins (the ticker-tape SSE stream is
 * opened from marketcatalyst.web.app; .firebaseapp.com is the Hosting mirror).
 * Deploys that forget CORS_ORIGINS keep the legitimate SSE stream working
 * WITHOUT the service reflecting arbitrary origins.
 */
const DEFAULT_ALLOWED_ORIGINS = [
  "https://marketcatalyst.web.app",
  "https://marketcatalyst.firebaseapp.com",
];

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
 * FAIL-CLOSED: an unset CORS_ORIGINS previously `return true` — reflecting ANY
 * origin, so any page on the internet could read this API in a visitor's
 * browser. It now falls back to DEFAULT_ALLOWED_ORIGINS (the app's own origins)
 * instead of reflecting arbitrary origins. When CORS_ORIGINS IS set, its
 * comma-separated allowlist is used verbatim (unchanged behaviour).
 *
 * Note: CORS is browser-enforced only — curl and server-to-server callers send
 * no Origin header and are unaffected. Browser-based LOCAL DEV against this
 * service should set CORS_ORIGINS (e.g. to include its http://localhost:PORT
 * origin), since localhost is intentionally NOT in the default allowlist.
 */
function corsOptions() {
  const raw = (process.env.CORS_ORIGINS ?? "").trim();
  const origin = (raw ? raw.split(",") : DEFAULT_ALLOWED_ORIGINS)
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
  // EventSource cannot send credentials cross-origin anyway and nothing here is
  // cookie-authenticated; leaving this off avoids the `*`-with-credentials
  // combination browsers reject outright.
  return { origin, credentials: false };
}

async function bootstrap() {
  const logger = new Logger("Bootstrap");
  // Disable Nest's default body parser (100kb limit) and register Express's
  // with a larger cap — blog content converted from multi-page Word/PDF uploads
  // exceeds 100kb and was 413'ing on POST/PATCH /admin/blogs.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({ limit: "32mb" }));
  app.use(urlencoded({ limit: "32mb", extended: true }));
  app.enableCors(corsOptions());
  app.enableShutdownHooks();
  const port = process.env.PORT ?? 4400;
  await app.listen(port);
  const role = (process.env.APP_ROLE ?? "worker").trim().toLowerCase();
  logger.log(
    `market-catalyst-backend listening on port ${port} (APP_ROLE=${role})`,
  );
}
bootstrap().catch((err) => {
  new Logger("Bootstrap").error(
    `Failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});
