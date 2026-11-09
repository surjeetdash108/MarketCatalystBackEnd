// blogs-admin.service imports `marked`, an ESM-only package Jest cannot load;
// this spec reads route metadata only, so a stub is enough.
jest.mock("marked", () => ({ marked: { parse: (s: string) => s } }));

import { readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { RequestMethod } from "@nestjs/common";
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { PUBLIC_ROUTE } from "./public.decorator";

/**
 * Every HTTP route must authenticate its caller, or be explicitly marked
 * @Public() with a reason. A route added without either fails here — the
 * failure that left /market-data/etf-holdings, the live streams, POST
 * /live/copilot (paid AI calls) and the /sync status reads open to anyone.
 */

const SRC = join(__dirname, "..");

/** Guards that establish WHO is calling. DelistedTickerGuard does not. */
const AUTH_GUARDS = new Set([
  "FirebaseAuthGuard",
  "AdminGuard",
  "McpApiKeyGuard",
  "StreamTicketGuard",
]);

/** The complete set of deliberately public routes, with why. */
const EXPECTED_PUBLIC = new Set([
  "GET /plans", // pricing table; the marketing site reads it before sign-in
  "GET /health", // Cloud Run startup/liveness probes
  "GET /public/landing-tape", // marketing-site ticker tape, delayed index prices
  "GET /live/logo", // company logos loaded by <img src>, which cannot send a token
]);

interface Route {
  key: string;
  guards: string[];
  publicReason: string | undefined;
  file: string;
}

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return controllerFiles(p);
    return p.endsWith(".controller.ts") ? [p] : [];
  });
}

const joinPath = (...parts: string[]) =>
  "/" +
  parts
    .flatMap((p) => p.split("/"))
    .filter(Boolean)
    .join("/");

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-require-imports -- reads untyped Reflect metadata */
function routes(): Route[] {
  const out: Route[] = [];
  for (const file of controllerFiles(SRC)) {
    const mod: Record<string, unknown> = require(file);
    for (const C of Object.values(mod)) {
      if (typeof C !== "function") continue;
      const base = Reflect.getMetadata(PATH_METADATA, C);
      if (base === undefined) continue;
      const classGuards: string[] = (
        Reflect.getMetadata(GUARDS_METADATA, C) ?? []
      ).map((g: { name: string }) => g.name);
      const classPublic: string | undefined = Reflect.getMetadata(
        PUBLIC_ROUTE,
        C,
      );
      const proto = (C as { prototype: Record<string, unknown> }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (typeof handler !== "function") continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler);
        if (method === undefined) continue;
        const path = Reflect.getMetadata(PATH_METADATA, handler);
        out.push({
          key: `${RequestMethod[method as number]} ${joinPath(String([base].flat()[0] ?? ""), String([path].flat()[0] ?? ""))}`,
          guards: [
            ...classGuards,
            ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? []).map(
              (g: { name: string }) => g.name,
            ),
          ],
          publicReason:
            Reflect.getMetadata(PUBLIC_ROUTE, handler) ?? classPublic,
          file: relative(SRC, file),
        });
      }
    }
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-require-imports */

describe("route authentication", () => {
  const all = routes();

  it("finds the app's routes", () => {
    expect(all.length).toBeGreaterThan(140);
  });

  it("every route has an authentication guard or an explicit @Public reason", () => {
    const open = all
      .filter(
        (r) => !r.guards.some((g) => AUTH_GUARDS.has(g)) && !r.publicReason,
      )
      .map(
        (r) => `${r.key}  (${r.file}; guards: ${r.guards.join("+") || "none"})`,
      );
    expect(open).toEqual([]);
  });

  it("the public routes are exactly the expected set", () => {
    const pub = all.filter((r) => r.publicReason).map((r) => r.key);
    expect(new Set(pub)).toEqual(EXPECTED_PUBLIC);
  });

  it("a public route carries no auth guard (one or the other, never both)", () => {
    const both = all.filter(
      (r) => r.publicReason && r.guards.some((g) => AUTH_GUARDS.has(g)),
    );
    expect(both.map((r) => r.key)).toEqual([]);
  });

  it.each([
    ["GET /market-data/etf-holdings", "FirebaseAuthGuard"],
    ["GET /live/etf-market", "FirebaseAuthGuard"],
    ["GET /live/etfs/market-funds", "FirebaseAuthGuard"],
    ["POST /live/copilot", "FirebaseAuthGuard"],
    ["GET /live/tape/stats", "FirebaseAuthGuard"],
    ["GET /live/stream", "StreamTicketGuard"],
    ["GET /live/tape/stream", "StreamTicketGuard"],
    ["GET /sync/status", "AdminGuard"],
    ["GET /sync/jobs", "AdminGuard"],
    ["GET /sync/:job/status", "AdminGuard"],
  ])("%s is guarded by %s", (key, guard) => {
    const r = all.find((x) => x.key === key);
    expect(r).toBeDefined();
    expect(r.guards).toContain(guard);
  });
});
