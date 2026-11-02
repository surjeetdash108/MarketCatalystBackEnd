import { BOARD_TTL_MS } from "./money-flow.service";

describe("MoneyFlowService refresh cadence", () => {
  it("uses a refresh cadence of 15 seconds or less to avoid board ranking lag", () => {
    expect(BOARD_TTL_MS).toBeLessThanOrEqual(15_000);
  });
});

