import { BadRequestException } from "@nestjs/common";
import { cleanSubmission, cleanTickers, parseFeedBody, pulseText } from "./content-pipeline.rules";

describe("content pipeline rules", () => {
  it("needs at least one destination", () => {
    expect(() => cleanSubmission({})).toThrow(BadRequestException);
  });

  it("cleans a blog + feed submission", () => {
    const s = cleanSubmission({
      blog: { section: "News", tickers: "LCID, $uber", notes: "  facts  ", links: "https://example.com/a" },
      feed: { header: "Lucid robotaxi", body: "Summary\n* Progress: driverless", tickers: ["lcid"] },
    });
    expect(s.blog).toEqual({ section: "News", headline: null, tickers: ["LCID", "UBER"], notes: "facts", links: ["https://example.com/a"] });
    expect(s.feed?.tickers).toEqual(["LCID"]);
    expect(s.pulse).toBeNull();
  });

  it("only accepts the blog's existing sections", () => {
    expect(() => cleanSubmission({ blog: { section: "Analysis", notes: "x" } })).toThrow(/Section must be one of/);
  });

  it("requires notes, header and body", () => {
    expect(() => cleanSubmission({ blog: { section: "News", notes: " " } })).toThrow(/Notes/);
    expect(() => cleanSubmission({ feed: { header: "h" } })).toThrow(/Live Feed body/);
  });

  it("keeps a Pulse post within the 500-character limit", () => {
    expect(() => cleanSubmission({ pulse: { header: "h".repeat(200), body: "b".repeat(400) } })).toThrow(/together/);
    const ok = cleanSubmission({ pulse: { header: "NVDA up", body: "After hours.", ticker: "$nvda" } });
    expect(ok.pulse).toEqual({ header: "NVDA up", body: "After hours.", ticker: "NVDA" });
    expect(pulseText("NVDA up", "After hours.")).toBe("NVDA up\n\nAfter hours.");
  });

  it("rejects bad tickers and links", () => {
    expect(() => cleanTickers("NVDA, 12bad")).toThrow(/isn't a valid ticker/);
    expect(() => cleanSubmission({ blog: { section: "News", notes: "x", links: "javascript:alert(1)" } })).toThrow();
  });

  it("splits a Live Feed body into summary and labelled bullets", () => {
    const body = [
      "*Lucid ($LCID) is advancing its robotaxi partnership with Uber.*",
      "",
      "* *Robotaxi Progress:* Safety drivers removed.",
      "* Bearish Analyst Call: Seaport Sell, $1 target.",
      "- No label here",
    ].join("\n");
    expect(parseFeedBody(body)).toEqual({
      summary: "Lucid ($LCID) is advancing its robotaxi partnership with Uber.",
      bullets: [
        { label: "Robotaxi Progress:", text: "Safety drivers removed." },
        { label: "Bearish Analyst Call:", text: "Seaport Sell, $1 target." },
        { label: "", text: "No label here" },
      ],
    });
  });
});
