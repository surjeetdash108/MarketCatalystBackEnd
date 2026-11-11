import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  UseGuards,
} from "@nestjs/common";
import { CachedCollectionsService } from "../live/cached-collections.service";
import { MarketDataService } from "./market-data.service";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import {
  AI_INFRASTRUCTURE_THEMES,
  classifyAiInfrastructure,
} from "../common/ai-infrastructure-themes";
import { capBucket } from "../adapters/types";

/** `companies.description` is a full paragraph; the tile/detail views need a
 *  single "what they do" line, so take the first sentence. */
function firstSentence(description: unknown): string | null {
  if (typeof description !== "string" || !description) return null;
  const match = description.match(/^.*?[.!?](?=\s|$)/);
  const sentence = (match ? match[0] : description).trim();
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}

/**
 * GET /market-data/ai-infrastructure(/:theme) — the AI-infrastructure theme
 * tiles (GPU & AI Compute, Semiconductor Equipment, …) and their per-company
 * detail. Membership is computed dynamically every request by classifying
 * the existing `companies` collection against the rules in
 * `ai-infrastructure-themes.ts` (industry allowlist + keyword match) — no
 * hardcoded ticker list, no new vendor calls or sync job. `companies` is
 * already kept warm by the premarket sync and cached in-memory by
 * CachedCollectionsService, so classifying it per-request is cheap.
 */
@Controller("market-data")
@UseGuards(FirebaseAuthGuard)
export class AiInfrastructureController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
  ) {}

  @Get("ai-infrastructure")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async themes() {
    const byTheme = await this.classify();
    return AI_INFRASTRUCTURE_THEMES.map((theme) => {
      const matches = byTheme.get(theme.key) ?? [];
      const sampleTickers = matches
        .slice()
        .sort((a, b) => (Number(b.marketCap) || 0) - (Number(a.marketCap) || 0))
        .slice(0, 5)
        .map((c) => c.ticker as string);
      return {
        key: theme.key,
        title: theme.title,
        icon: theme.icon,
        blurb: theme.blurb,
        companyCount: matches.length,
        sampleTickers,
      };
    });
  }

  @Get("ai-infrastructure/:theme")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async theme(@Param("theme") key: string) {
    const theme = AI_INFRASTRUCTURE_THEMES.find((t) => t.key === key);
    if (!theme) {
      throw new NotFoundException(`Unknown AI-infrastructure theme "${key}"`);
    }

    const byTheme = await this.classify();
    const companies = (byTheme.get(theme.key) ?? [])
      .map((c) => {
        const marketCap = (c.marketCap as number | null) ?? null;
        return {
          ticker: c.ticker as string,
          name: (c.name as string | null) ?? null,
          blurb: firstSentence(c.description),
          marketCap,
          capBucket: capBucket(marketCap),
          price: (c.price as number | null) ?? null,
          pctChange: (c.pctChange as number | null) ?? null,
        };
      })
      .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));

    return {
      key: theme.key,
      title: theme.title,
      icon: theme.icon,
      blurb: theme.blurb,
      companies,
    };
  }

  private async classify(): Promise<
    Map<string, Array<Record<string, unknown>>>
  > {
    await this.marketData.ensureFresh("companies");
    const { companies } = await this.cached.get(["companies"]);
    return classifyAiInfrastructure(
      companies as Array<Record<string, unknown>>,
    );
  }
}
