import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Request } from "express";
import { DelistedTickersService } from "./delisted-tickers.service";

/**
 * 404s any request whose `?ticker=` is a delisted symbol, the way Yahoo,
 * Google Finance and Finviz treat one.
 *
 * Applied to the per-ticker controllers. Without it, opening a delisted
 * symbol's page rebuilt its company, financials and bars docs from the vendor's
 * last-known data, putting it straight back into every list.
 */
@Injectable()
export class DelistedTickerGuard implements CanActivate {
  constructor(private readonly delisted: DelistedTickersService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const raw = req.query?.ticker;
    const sym = typeof raw === "string" ? raw.toUpperCase().trim() : "";
    if (sym && (await this.delisted.isDelisted(sym))) {
      throw new NotFoundException(`${sym} is delisted`);
    }
    return true;
  }
}
