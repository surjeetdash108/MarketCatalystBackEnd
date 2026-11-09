import type { Request } from "express";

/** First hop of X-Forwarded-For (Cloud Run / Hosting), else the socket address. */
export function clientIp(req: Request): string | null {
  const fwd = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")[0]
    .trim();
  return fwd || req.ip || null;
}
