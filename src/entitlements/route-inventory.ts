import "reflect-metadata";
import { readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { PUBLIC_ROUTE } from "../common/public.decorator";

/**
 * Every HTTP route the app's controllers declare, read from Nest's own route
 * metadata (not regex). Used by the route ↔ feature-group contract test and the
 * generated feature map.
 */
export interface RouteInfo {
  method: string;
  path: string;
  controller: string;
  file: string;
  guards: string[];
  isPublic: boolean;
  /** For tests that drive the guard directly. */
  handler: (...a: unknown[]) => unknown;
  cls: new (...a: unknown[]) => unknown;
}


function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.controller\.ts$/.test(n) ? [p] : [];
  });
}

const join2 = (a: string, b: string) =>
  ("/" + [a, b].map((x) => String(x ?? "").replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")).replace(/\/+/g, "/");

const guardNames = (target: object | undefined): string[] =>
  ((target ? Reflect.getMetadata(GUARDS_METADATA, target) : null) ?? []).map(
    (g: { name?: string }) => g?.name ?? String(g),
  );

const isPublic = (target: object | undefined): boolean =>
  !!target && typeof Reflect.getMetadata(PUBLIC_ROUTE, target) === "string";

export function routeInventory(srcRoot = join(__dirname, "..")): RouteInfo[] {
  const out: RouteInfo[] = [];
  for (const f of files(srcRoot)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(f) as Record<string, unknown>;
    for (const exp of Object.values(mod)) {
      if (typeof exp !== "function") continue;
      const prefix = Reflect.getMetadata(PATH_METADATA, exp) as string | string[] | undefined;
      if (prefix === undefined) continue;
      const prefixes = Array.isArray(prefix) ? prefix : [prefix];
      const proto = (exp as { prototype: object }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === "constructor") continue;
        const d = Object.getOwnPropertyDescriptor(proto, name);
        const handler = d?.value as object | undefined; // never invoke getters
        if (typeof handler !== "function") continue;
        const m = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        const p = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
        if (m === undefined || p === undefined) continue;
        for (const pre of prefixes)
          for (const sub of Array.isArray(p) ? p : [p])
            out.push({
              method: RequestMethod[m],
              path: join2(pre, sub),
              controller: exp.name,
              file: relative(join(srcRoot, ".."), f),
              guards: [...guardNames(exp), ...guardNames(handler)],
              isPublic: isPublic(handler) || isPublic(exp),
              handler: handler as (...a: unknown[]) => unknown,
              cls: exp as new (...a: unknown[]) => unknown,
            });
      }
    }
  }
  return out.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
}
