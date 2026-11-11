/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock("marked", () => ({ marked: { parse: (s: string) => s } }));

async function build(role: "live" | "worker") {
  process.env.APP_ROLE = role;
  jest.resetModules();
  const { Test } = require("@nestjs/testing");
  const classes: any = {
    AppModule: require("./app.module").AppModule,
    NewsController: require("./market-data/news.controller").NewsController,
    NewsRefreshService: require("./live/news-refresh.service")
      .NewsRefreshService,
    OnDemandService: require("./live/ondemand.service").OnDemandService,
    CacheStatusService: require("./common/cache-status.service")
      .CacheStatusService,
    NewsJob: require("./sync/news.job").NewsJob,
  };
  const moduleRef = await Test.createTestingModule({
    imports: [classes.AppModule],
  }).compile();
  return { moduleRef, classes };
}

describe("news wiring", () => {
  const original = process.env.APP_ROLE;
  afterAll(() => {
    if (original === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = original;
  });

  it("live role (the public service): news controller, refresh service and cache_status all resolve", async () => {
    const { moduleRef, classes } = await build("live");
    const get = (c: any) => moduleRef.get(c, { strict: false });

    const controller = get(classes.NewsController);
    expect(controller).toBeDefined();
    expect(get(classes.NewsRefreshService)).toBeDefined();
    expect(get(classes.CacheStatusService)).toBeDefined();
    expect((get(classes.OnDemandService) as any).cacheStatus).toBeDefined();
    await moduleRef.close();
  }, 60_000);

  it("worker role: the cron job gets the same shared refresh service", async () => {
    const { moduleRef, classes } = await build("worker");
    const get = (c: any) => moduleRef.get(c, { strict: false });

    expect(get(classes.NewsJob)).toBeDefined();
    expect((get(classes.NewsJob) as any).refresher).toBe(
      get(classes.NewsRefreshService),
    );
    expect(get(classes.NewsController)).toBeDefined();
    await moduleRef.close();
  }, 60_000);

  it("the live role does not load the cron job, only the shared service", async () => {
    const { moduleRef, classes } = await build("live");
    expect(() => moduleRef.get(classes.NewsJob, { strict: false })).toThrow();
    await moduleRef.close();
  }, 60_000);
});
