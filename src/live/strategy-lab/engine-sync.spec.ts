import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * engine.ts is generated from MarketCatalystUI/app/iq/sl/engine.js by
 * scripts/strategy-lab/sync-engine.sh, which also records the source's sha256.
 * Fails when this copy is edited by hand or is out of step with that hash.
 */
const HEADER_LINES = 4;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("Strategy Lab engine copy", () => {
  const body = fs
    .readFileSync(path.join(__dirname, "engine.ts"), "utf8")
    .split("\n")
    .slice(HEADER_LINES)
    .join("\n");

  it("matches the hash sync-engine.sh recorded", () => {
    const rec = fs
      .readFileSync(path.join(__dirname, "engine.sha256"), "utf8")
      .trim();
    expect(sha(body)).toBe(rec);
  });

  it("equals the UI engine when the UI repo sits next to this one", () => {
    const ui = path.join(
      __dirname,
      "../../../../MarketCatalystUI/app/iq/sl/engine.js",
    );
    if (!fs.existsSync(ui)) return;
    expect(sha(body)).toBe(sha(fs.readFileSync(ui, "utf8")));
  });
});
