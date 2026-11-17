import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import {
  AdminTickerSearchController,
  rankMatches,
} from "./admin-ticker-search.controller";

const co = (ticker: string, name: string, marketCap: number) => ({
  ticker,
  name,
  price: 10,
  pctChange: 1,
  marketCap,
});

describe("admin ticker search (console Pulse picker)", () => {
  const companies = [
    co("AAPL", "Apple Inc.", 4e12),
    co("NVDA", "NVIDIA Corp", 5e12),
    co("APLE", "Apple Hospitality REIT", 3e9),
  ];
  it("empty query: largest companies first", () => {
    expect(rankMatches("", [], companies).map((m) => m.sym)).toEqual([
      "NVDA",
      "AAPL",
      "APLE",
    ]);
  });
  it("ranks exact → ticker prefix → name prefix → substring, like MC's search", () => {
    const hits = [
      { ticker: "NVDL", name: "GraniteShares 2x NVDA" },
      { ticker: "NVDA", name: "NVIDIA Corp" },
    ];
    expect(rankMatches("nvda", hits, companies).map((m) => m.sym)).toEqual([
      "NVDA",
      "NVDL",
    ]);
    expect(rankMatches("apple", [], companies).map((m) => m.sym)).toEqual([
      "AAPL",
      "APLE",
    ]);
  });
  it("is admin-only (AdminGuard), so the plan-less admin account can use it", () => {
    const guards = (Reflect.getMetadata(
      GUARDS_METADATA,
      AdminTickerSearchController,
    ) ?? []) as Array<{ name: string }>;
    expect(guards.map((g) => g.name)).toContain("AdminGuard");
  });
});
