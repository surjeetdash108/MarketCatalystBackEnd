import * as fs from "fs";
import * as path from "path";
import { invisibleOnWhite } from "./logo-visibility";

const fx = (f: string) => fs.readFileSync(path.join(__dirname, "fixtures/logos", f));

describe("a logo the white tile would hide", () => {
  it("ALNY from FMP — white shapes on a transparent background — is invisible on white", () => {
    expect(invisibleOnWhite(fx("alny-fmp-white.png"))).toBe(true);
  });
  it("normal logos are kept: AAPL (opaque), ALNY from Parqet (white on a black square)", () => {
    expect(invisibleOnWhite(fx("aapl.png"))).toBe(false);
    expect(invisibleOnWhite(fx("alny-parqet.png"))).toBe(false);
  });
  it("anything it can't read (SVG, JPEG, junk) is kept, never rejected", () => {
    expect(invisibleOnWhite(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBe(false);
    expect(invisibleOnWhite(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    expect(invisibleOnWhite(Buffer.alloc(0))).toBe(false);
  });
});
