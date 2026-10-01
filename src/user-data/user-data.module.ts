import { Module } from "@nestjs/common";
import { LiveModule } from "../live/live.module";
import { AiUserController } from "./ai-user.controller";
import { FeatureRequestsController } from "./feature-requests.controller";
import { NotificationsController } from "./notifications.controller";
import { PortfolioController } from "./portfolio.controller";
import { ProfileController } from "./profile.controller";
import { SettingsController } from "./settings.controller";
import { StockNotesController } from "./stock-notes.controller";
import { WatchlistController } from "./watchlist.controller";
import { PlansModule } from "../plans/plans.module";
import { WhoamiUserController } from "./whoami-user.controller";

/**
 * Auth-guarded, per-user endpoints — everything scoped by the caller's own
 * Firebase uid (never a client-supplied one).
 */
@Module({
  // LiveModule exports AiAnalysisService, which the aggregate routes use.
  // PlansModule supplies SubscriptionsService for the free-tier watchlist cap.
  imports: [LiveModule, PlansModule],
  controllers: [
    AiUserController,
    WhoamiUserController,
    StockNotesController,
    WatchlistController,
    PortfolioController,
    SettingsController,
    ProfileController,
    NotificationsController,
    FeatureRequestsController,
  ],
})
export class UserDataModule {}
