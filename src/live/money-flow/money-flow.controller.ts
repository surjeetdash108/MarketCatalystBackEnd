import { Controller, Get, Header, UseGuards } from "@nestjs/common";
import { FirebaseAuthGuard } from "../../common/firebase-auth.guard";
import { MoneyFlowService } from "./money-flow.service";
import type { MoneyFlowBoard } from "./money-flow.calc";

@Controller("live")
export class MoneyFlowController {
  constructor(private readonly moneyFlow: MoneyFlowService) {}

  /** GET /live/money-flow — the Money Flow board (see money-flow.calc.ts for every basis). */
  @UseGuards(FirebaseAuthGuard)
  @Get("money-flow")
  @Header("Cache-Control", "private, max-age=30")
  async get(): Promise<MoneyFlowBoard> {
    return this.moneyFlow.get();
  }
}
