import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { CurrentUser } from "../common/current-user.decorator";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { LAB_INTRADAY, StrategyLabService } from "./strategy-lab.service";
import { LabResultsService } from "./strategy-lab/lab-results.service";

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
/** Per-request cap for raw bars (single-stock backtests, charts and the Backtest step's stock list). */
const MAX_SYMBOLS = 60;
const MAX_YEARS = 11;
const MAX_DAYS = 730;
/** Daily bars by calendar days (test window + indicator warm-up). */
const MAX_DAILY_DAYS = Math.round(MAX_YEARS * 366);
const MAX_SAVED = 200;
const SAVED_ID_RE = /^[a-z0-9]{4,24}$/;
/** labCfg keys a saved strategy may carry (exit plan, costs, period). */
const SAVED_CFG_KEY_RE =
  /^(stopM|stop|stopA|tpM|tp|tpR|trA|trD|be|maxB|cost|yrs|idays_[0-9a-z]{2,3})$/;
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
    private readonly firebase: FirebaseAdminService,
  ) {}

  /** GET /live/strategy-lab/universe — the stocks a strategy is tested on. */
  @Get("universe")
  @Header("Cache-Control", "private, max-age=3600")
  async universe() {
    try {
      return await this.lab.universe();
    } catch (err) {
      throw new ServiceUnavailableException(
        `Strategy Lab universe unavailable: ${(err as Error)?.message ?? err}`,
      );
    }
  }

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
    if (frame === "d" && days != null) {
      const d = Math.round(Number(days));
      if (!Number.isFinite(d) || d < 30 || d > MAX_DAILY_DAYS)
        throw new BadRequestException(
          `days must be 30-${MAX_DAILY_DAYS} for daily bars`,
        );
      return this.lab.bars(syms, "d", { days: d });
    }
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

  // ── Saved strategies (per user) ──────────────────────────────────────────

  private savedCol(uid: string) {
    return this.firebase.firestore.collection(`users/${uid}/lab_strategies`);
  }

  /** GET /live/strategy-lab/saved → { strategies } (newest first). */
  @Get("saved")
  async listSaved(@CurrentUser() uid: string) {
    const snap = await this.savedCol(uid).get();
    const strategies = snap.docs
      .map((d) => ({
        id: d.id,
        ...(d.data() as Partial<SavedStrategyDoc> & { updatedAt?: string }),
      }))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return { strategies };
  }

  /** POST /live/strategy-lab/saved/:id — create or update (upsert) one saved strategy. */
  @Post("saved/:id")
  async putSaved(
    @CurrentUser() uid: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    if (!SAVED_ID_RE.test(id ?? ""))
      throw new BadRequestException("id: 4-24 chars a-z0-9");
    const doc = validateSaved(body);
    const col = this.savedCol(uid);
    const existing = await col.doc(id).get();
    if (!existing.exists) {
      const count = (await col.count().get()).data().count;
      if (count >= MAX_SAVED)
        throw new BadRequestException(`at most ${MAX_SAVED} saved strategies`);
    }
    const now = new Date().toISOString();
    const data = {
      ...doc,
      savedAt: existing.exists
        ? ((existing.get("savedAt") as string | undefined) ?? now)
        : now,
      updatedAt: now,
    };
    await col.doc(id).set(data);
    return { id, ...data };
  }

  /** DELETE /live/strategy-lab/saved/:id — also removes any automation config stored with it. */
  @Delete("saved/:id")
  async deleteSaved(@CurrentUser() uid: string, @Param("id") id: string) {
    if (!SAVED_ID_RE.test(id ?? ""))
      throw new BadRequestException("id: 4-24 chars a-z0-9");
    await this.savedCol(uid).doc(id).delete();
    return { id, deleted: true };
  }
}

/** A saved strategy as stored: name, rules, candle, exit plan + costs + period, source query, why. */
export interface SavedStrategyDoc {
  name: string;
  tf: string;
  cond: { entry: unknown[]; exit: unknown[] };
  cfg: Record<string, string>;
  hold: string;
  q: string;
  why: string;
}

export function validateSaved(raw: unknown): SavedStrategyDoc {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const str = (v: unknown, max: number, field: string, required = false) => {
    if (v == null || v === "") {
      if (required) throw new BadRequestException(`${field} is required`);
      return "";
    }
    if (typeof v !== "string" || v.length > max)
      throw new BadRequestException(`${field}: up to ${max} characters`);
    return v;
  };
  const cond = (body.cond ?? null) as {
    entry?: unknown;
    exit?: unknown;
  } | null;
  const entry =
    cond && Array.isArray(cond.entry) ? (cond.entry as unknown[]) : null;
  const exit =
    cond && Array.isArray(cond.exit) ? (cond.exit as unknown[]) : null;
  if (!entry || !exit || !entry.length)
    throw new BadRequestException(
      "cond needs entry (at least one) and exit arrays",
    );
  if (
    entry.length > MAX_CONDITIONS ||
    exit.length > MAX_CONDITIONS ||
    JSON.stringify({ entry, exit }).length > MAX_SPEC_BYTES
  )
    throw new BadRequestException("cond is too large");
  const tf = typeof body.tf === "string" ? body.tf : "";
  if (!LAB_TFS.has(tf))
    throw new BadRequestException(
      "tf must be one of " + [...LAB_TFS].join(", "),
    );
  const cfgIn = body.cfg ?? {};
  if (typeof cfgIn !== "object" || Array.isArray(cfgIn))
    throw new BadRequestException("cfg must be an object");
  const cfg: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfgIn as Record<string, unknown>)) {
    if (!SAVED_CFG_KEY_RE.test(k))
      throw new BadRequestException(`cfg.${k} is not a saved setting`);
    if (typeof v !== "string" || v.length > 12)
      throw new BadRequestException(`cfg.${k} must be a short string`);
    cfg[k] = v;
  }
  return {
    name: str(body.name, 80, "name", true),
    tf,
    cond: { entry, exit },
    cfg,
    hold: str(body.hold, 30, "hold"),
    q: str(body.q, MAX_PROMPT, "q"),
    why: str(body.why, 600, "why"),
  };
}
