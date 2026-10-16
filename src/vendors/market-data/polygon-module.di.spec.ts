import { Test } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { PolygonModule } from "../polygon/polygon.module";
import { PolygonService } from "../polygon/polygon.service";
import { MarketDataService } from "./market-data.service";

async function resolve(env: Record<string, string>) {
  const mod = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), PolygonModule],
  }).compile();
  return mod.get(PolygonService);
}

describe("PolygonModule market-data routing", () => {
  it("injects the FMP-first router by default", async () => {
    expect(await resolve({})).toBeInstanceOf(MarketDataService);
  });
  it("injects plain Polygon when MARKET_DATA_PRIMARY=polygon", async () => {
    const svc = await resolve({ MARKET_DATA_PRIMARY: "polygon" });
    expect(svc).toBeInstanceOf(PolygonService);
    expect(svc).not.toBeInstanceOf(MarketDataService);
  });
});
