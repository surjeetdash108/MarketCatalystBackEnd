import { SetMetadata } from "@nestjs/common";

export const PUBLIC_ROUTE = "publicRoute";

/**
 * Marks a route (or controller) as deliberately reachable without
 * authentication. The reason is required and is read by route-guards.spec.ts,
 * which fails on any route that has neither an auth guard nor this marker —
 * so "public" is always a decision, never an omission.
 */
export const Public = (reason: string) => SetMetadata(PUBLIC_ROUTE, reason);
