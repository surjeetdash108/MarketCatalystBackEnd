import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { LAB_INTRADAY, StrategyLabService } from "./strategy-lab.service";
import { LabResultsService } from "./strategy-lab/lab-results.service";

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
/** Per-request cap for raw bars (single-stock backtests, charts and the Backtest step's stock list). */
const MAX_SYMBOLS = 60;
const MAX_YEARS = 11;
const MAX_DAYS = 730;
const MAX_PROMPT = 600;
const MAX_SPEC_BYTES = 8_000;
const MAX_CONDITIONS = 12;
const LAB_TFS = new Set(["d", "1w", ...Object.keys(LAB_INTRADAY)]);

/**
 * Strategy Lab endpoints. Universe-wide backtests run here across every
 * tracked stock (POST validate, served from cached / precomputed results);
 * single-stock backtests run in the browser on bars from GET bars (FMP, so the
 * key never reaches the client); POST ai-rules turns plain English into rules.
 */
@Controller("live/strategy-lab")
@UseGuards(FirebaseAuthGuard)
export class StrategyLabController {
  constructor(
    private readonly lab: StrategyLabService,
    private readonly results: LabResultsService,
  ) {}

  /** GET /live/strategy-lab/bars?symbols=AAPL,MSFT&tf=d&years=6 | &tf=5m&days=21 */
  @Get("bars")
  @Header("Cache-Control", "private, max-age=300")
  bars(
    @Query("symbols") symbols: string | undefined,
    @Query("tf") tf: string | undefined,
    @Query("years") years: string | undefined,
    @Query("days") days: string | undefined,
  ) {
    const syms = [
      ...new Set(
        (symbols ?? "")
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      ),
    ];
    if (
      !syms.length ||
      syms.length > MAX_SYMBOLS ||
      !syms.every((s) => TICKER_RE.test(s))
    )
      throw new BadRequestException(
        `symbols: 1-${MAX_SYMBOLS} tickers, A-Z0-9.-`,
      );
    const frame = (tf ?? "d").trim();
    if (frame !== "d" && !LAB_INTRADAY[frame])
      throw new BadRequestException(
        "tf must be d or one of " + Object.keys(LAB_INTRADAY).join(", "),
      );
    if (frame === "d") {
      const y = Number(years ?? 6);
      if (!Number.isFinite(y) || y < 1 || y > MAX_YEARS)
        throw new BadRequestException(`years must be 1-${MAX_YEARS}`);
      return this.lab.bars(syms, "d", { years: y });
    }
    const d = Math.round(Number(days ?? 21));
    if (!Number.isFinite(d) || d < 1 || d > MAX_DAYS)
      throw new BadRequestException(`days must be 1-${MAX_DAYS}`);
    return this.lab.bars(syms, frame, { days: d });
  }

  /**
   * POST /live/strategy-lab/validate { spec: {entry, exit}, tf, cfg }
   * → every tracked stock backtested with these rules; returns the stocks
   * whose entry rules are met now (or nearly), with per-window stats.
   * Library strategies come straight from the jobs' precomputed results.
   */
  @Post("validate")
  async validate(@Body() body: { spec?: any; tf?: unknown; cfg?: any }) {
    const spec = body?.spec;
    const tf = typeof body?.tf === "string" ? body.tf : "d";
    if (!LAB_TFS.has(tf))
      throw new BadRequestException(
        "tf must be one of " + [...LAB_TFS].join(", "),
      );
    if (!spec || !Array.isArray(spec.entry) || !Array.isArray(spec.exit))
      throw new BadRequestException("spec needs entry and exit arrays");
    if (
      spec.entry.length > MAX_CONDITIONS ||
      spec.exit.length > MAX_CONDITIONS ||
      JSON.stringify(spec).length > MAX_SPEC_BYTES
    )
      throw new BadRequestException("spec is too large");
    return this.results.validate(
      { entry: spec.entry, exit: spec.exit },
      tf,
      body?.cfg ?? {},
    );
  }

  /** POST /live/strategy-lab/ai-rules { q } → { raw } (null when no model is available). */
  @Post("ai-rules")
  async aiRules(@Body() body: { q?: unknown }) {
    const q = typeof body?.q === "string" ? body.q.trim() : "";
    if (!q || q.length > MAX_PROMPT)
      throw new BadRequestException(`q: 1-${MAX_PROMPT} characters`);
    return { raw: await this.lab.aiRules(q) };
  }
}
