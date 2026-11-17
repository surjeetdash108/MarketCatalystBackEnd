import { Module } from "@nestjs/common";
import { PulseAdminController, PulseController } from "./pulse.controller";
import { PulseService } from "./pulse.service";

/** Market Catalyst Pulse posts. FirebaseAdminService and the guards come from the @Global CommonModule. */
@Module({
  controllers: [PulseController, PulseAdminController],
  providers: [PulseService],
})
export class PulseModule {}
