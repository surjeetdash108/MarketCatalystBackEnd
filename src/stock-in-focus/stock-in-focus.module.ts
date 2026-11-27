import { Module } from "@nestjs/common";
import {
  StockInFocusAdminController,
  StockInFocusController,
} from "./stock-in-focus.controller";
import { StockInFocusService } from "./stock-in-focus.service";

/** Stock in Focus entries. FirebaseAdminService and the guards come from the @Global CommonModule. */
@Module({
  controllers: [StockInFocusController, StockInFocusAdminController],
  providers: [StockInFocusService],
  exports: [StockInFocusService],
})
export class StockInFocusModule {}
