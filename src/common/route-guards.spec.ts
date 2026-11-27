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
import { EDITOR_ACCESS } from "./editor-access.decorator";

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
  "POST /api/billing/webhook", // provider webhook, authenticated by its signature over the raw body
  "POST /api/billing/signup/promo", // signup page promo quote before sign-in; rate limited per IP
  "GET /api/email/unsubscribe", // one-click unsubscribe link in an email; signed token, no login
  "GET /api/account/secure", // "Secure my account" in a new sign-in alert; signed token, no login
  "POST /api/account/password-reset", // forgot password, signed out by nature; rate limited per address, never reveals an account
]);

interface Route {
  key: string;
  guards: string[];
  publicReason: string | undefined;
  editor: boolean;
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
      const classEditor = Reflect.getMetadata(EDITOR_ACCESS, C) === true;
      const proto = (C as { prototype: Record<string, unknown> }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        // Descriptor, not proto[name]: reading a getter would run it.
        const handler: unknown = Object.getOwnPropertyDescriptor(
          proto,
          name,
        )?.value;
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
          editor:
            classEditor || Reflect.getMetadata(EDITOR_ACCESS, handler) === true,
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

  // A content editor (ADMIN_EDITOR_EMAILS) runs the console's Blogs and
  // Content pipeline sections and nothing else. Any route added to this list
  // is a decision to show editors more of the admin console.
  it("editors reach exactly the Blogs and Content pipeline routes", () => {
    const editor = all.filter((r) => r.editor).map((r) => r.key);
    expect(new Set(editor)).toEqual(
      new Set([
        "GET /api/admin/whoami",
        "GET /api/admin/posts",
        "GET /api/admin/posts/theme",
        "POST /api/admin/posts",
        "PATCH /api/admin/posts/:id",
        "DELETE /api/admin/posts/:id",
        "GET /api/admin/media",
        "POST /api/admin/media",
        "DELETE /api/admin/media/:id",
        "GET /api/admin/pulse",
        "POST /api/admin/pulse",
        "PATCH /api/admin/pulse/:id",
        "DELETE /api/admin/pulse/:id",
        "GET /api/admin/stock-in-focus",
        "POST /api/admin/stock-in-focus",
        "PATCH /api/admin/stock-in-focus/:day",
        "DELETE /api/admin/stock-in-focus/:day",
        "GET /api/admin/ticker-search",
        "POST /api/admin/content",
        "GET /api/admin/content",
        "GET /api/admin/content/:id",
        "POST /api/admin/content/:id/approve",
        "POST /api/admin/content/:id/send-back",
        "PATCH /api/admin/content/:id",
        "DELETE /api/admin/content/:id",
        "POST /api/admin/content/:id/retry",
      ]),
    );
    expect(
      all.filter((r) => r.editor && !r.guards.includes("AdminGuard")),
    ).toEqual([]);
  });
});
