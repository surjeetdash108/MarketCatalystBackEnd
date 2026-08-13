import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { ServeStaticModule } from "@nestjs/serve-static";
import { join } from "path";
import { CommonModule } from "./common/common.module";
import { UserDataModule } from "./user-data/user-data.module";
import { HealthController } from "./health/health.controller";
import { FeatureFlagsModule } from "./feature-flags/feature-flags.module";
import { PlansModule } from "./plans/plans.module";
import { RetentionModule } from "./retention/retention.module";
import { AutoPurgeModule } from "./auto-purge/auto-purge.module";
import { LiveModule } from "./live/live.module";
import { MarketDataModule } from "./market-data/market-data.module";
import { PurgeModule } from "./purge/purge.module";
import { ApiHealthModule } from "./api-health/api-health.module";

/**
 * TWO DEPLOYMENTS, ONE IMAGE.
 *
 * `APP_ROLE=live` mounts ONLY the public read paths (LiveModule + /health).
 * Everything privileged — job triggers, purge, feature-flag writes, retention —
 * is left unrouted, so the live service returns 404 for them rather than relying
 * on a guard to say no.
 *
 * That distinction is not cosmetic. AdminGuard treats a request with NO
 * Authorization header as authorised whenever ADMIN_GUARD_TRUST_IAM is on (the
 * default), because the worker runs --no-allow-unauthenticated and Cloud Run IAM
 * has already vetted the caller before the process sees it. The live service
 * must be --allow-unauthenticated for browsers to hold the ticker-tape SSE
 * stream open, which would turn that same assumption into anonymous access to
 * /purge/*. Not registering the modules removes the surface entirely instead of
 * adding one more thing that has to stay configured correctly forever.
 *
 * Secondary benefit: a 35-minute options-chains run no longer shares CPU, memory
 * or the autoscaler signal with instances holding long-lived SSE connections.
 * The two want opposite Cloud Run settings — see deploy/DEPLOY.md §3b.
 */
const isLiveRole =
  (process.env.APP_ROLE ?? "worker").trim().toLowerCase() === "live";

/** Batch surface — worker role only. */
const workerModules = isLiveRole
  ? []
  : [
      PurgeModule,
      FeatureFlagsModule,
      RetentionModule,
      AutoPurgeModule,
      // The ops monitor (public/index.html) drives the admin endpoints above, so
      // it belongs on the private service with them. Serving it from the public
      // live service would publish the internal ops surface to anyone who loads
      // the root path, and every button on it would 404 there anyway.
      // `exclude` keeps the API routes from being shadowed by the static handler.
      ServeStaticModule.forRoot({
        rootPath: join(__dirname, "..", "public"),
        exclude: [
          "/health",
          "/sync/{*splat}",
          "/purge/{*splat}",
          "/live/{*splat}",
          "/market-data/{*splat}",
          "/feature-flags/{*splat}",
          "/retention/{*splat}",
        ],
      }),
    ];

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ".env" }),
    ScheduleModule.forRoot(),
    CommonModule,
    LiveModule,
    MarketDataModule,
    UserDataModule,
    // Mounted in BOTH roles: the public `live` service must serve the admin
    // console's backend (/admin/* read-models, /plans, PATCH /admin/plans/:id).
    // Safe to expose publicly ONLY because the live service runs
    // ADMIN_GUARD_TRUST_IAM=false, so every /admin/* and /feature-flags/* call
    // requires a verified Firebase admin token — a header-less request is
    // refused there, not trusted. (PlansModule brings FeatureFlagsModule.)
    PlansModule,
    // GET /admin/api-health (AdminGuard): route inventory + self-probe for the
    // console's Monitor tab. Both roles so the live service serves it too.
    ApiHealthModule,
    ...workerModules,
  ],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
