import { SecEdgarService } from "./sec-edgar.service";
import { getTickerToCik } from "../../common/sec-cik-map.util";
import { SecForm4Job } from "../../sync/sec-form4.job";

/**
 * SEC's fair-access policy requires a User-Agent naming the operator and a
 * contact. With SEC_USER_AGENT unset nothing may be sent to sec.gov — no
 * generic or made-up agent — and the miss is logged as an error.
 */
describe("SEC User-Agent", () => {
  const origEnv = process.env;
  const config = { get: jest.fn((_k: string, def?: string) => def) } as any;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.SEC_USER_AGENT;
    delete process.env.SEC_EDGAR_USER_AGENT;
    fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("{}", { headers: { "content-type": "application/json" } }));
  });
  afterEach(() => fetchSpy.mockRestore());
  afterAll(() => {
    process.env = origEnv;
  });

  it("sends SEC_USER_AGENT when it is set", async () => {
    process.env.SEC_USER_AGENT = "Example Operator ops@example.com";
    const svc = new SecEdgarService(config);
    expect(svc.getUserAgent()).toBe("Example Operator ops@example.com");
    await svc.getSubmissions("320193").catch(() => undefined);
    expect(fetchSpy).toHaveBeenCalled();
    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("Example Operator ops@example.com");
  });

  it("accepts SEC_EDGAR_USER_AGENT, the name the deployed services set", async () => {
    process.env.SEC_EDGAR_USER_AGENT = "Example Operator ops@example.com";
    const svc = new SecEdgarService(config);
    expect(svc.getUserAgent()).toBe("Example Operator ops@example.com");
    await svc.getSubmissions("320193").catch(() => undefined);
    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("Example Operator ops@example.com");
  });

  it("unset: no agent, the request is refused and sec.gov is never called", async () => {
    const svc = new SecEdgarService(config);
    expect(svc.getUserAgent()).toBeNull();
    await expect(svc.getSubmissions("320193")).rejects.toThrow(/SEC_USER_AGENT/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("unset: the CIK map is not refreshed from sec.gov", async () => {
    const stale = { exists: true, data: () => ({ updatedAt: "2020-01-01T00:00:00Z", count: 1, map: { AAPL: "320193" } }) };
    const db = { doc: () => ({ get: async () => stale, set: jest.fn() }) } as any;
    const map = await getTickerToCik(db);
    expect(map.get("AAPL")).toBe("320193"); // the stored copy
    expect(fetchSpy).not.toHaveBeenCalled();

    const empty = { doc: () => ({ get: async () => ({ exists: false }), set: jest.fn() }) } as any;
    await expect(getTickerToCik(empty)).rejects.toThrow(/SEC_USER_AGENT/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("unset: sec-form4 records the skip as a failure without calling SEC", async () => {

    const meta = { record: jest.fn(), getCursor: jest.fn().mockResolvedValue(0), setCursor: jest.fn() };
    const firestore = { doc: () => ({ get: async () => ({ exists: false }) }), collection: () => ({}) };
    const job = new SecForm4Job(new SecEdgarService(config), { firestore } as any, meta as any, { register: jest.fn() } as any);
    await expect(job.run()).rejects.toThrow(/SEC_USER_AGENT/);
    expect(meta.record).toHaveBeenCalledWith("sec-form4", expect.objectContaining({ ok: false, error: expect.stringMatching(/SEC_USER_AGENT/) }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
