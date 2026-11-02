import { BadRequestException } from "@nestjs/common";
import { validateSaved } from "./strategy-lab.controller";

// Universe tests moved to strategy-lab/lab-universe.spec.ts (shared Strategy Lab universe).

describe("saved strategy validation", () => {
  const ok = {
    name: "RSI(2) pullback",
    tf: "15m",
    cond: {
      entry: [{ a: { ind: "rsi", n: 2 }, op: "<", b: { ind: "num", v: 10 } }],
      exit: [],
    },
    cfg: {
      stopM: "atr",
      stopA: "2",
      tpM: "r",
      tpR: "2",
      trA: "never",
      be: "off",
      maxB: "none",
      cost: "10",
      idays_15m: "60",
    },
    q: "buy when rsi(2) below 10",
    why: "Mean reversion",
  };

  it("keeps rules, candle, full exit plan, costs, period, query and why", () => {
    expect(validateSaved(ok)).toEqual({ ...ok, hold: "" });
  });

  it("rejects unknown settings and missing rules", () => {
    expect(() =>
      validateSaved({ ...ok, cfg: { ...ok.cfg, dir: "short" } }),
    ).toThrow(BadRequestException);
    expect(() =>
      validateSaved({ ...ok, cond: { entry: [], exit: [] } }),
    ).toThrow(BadRequestException);
    expect(() => validateSaved({ ...ok, tf: "2d" })).toThrow(
      BadRequestException,
    );
  });
});
