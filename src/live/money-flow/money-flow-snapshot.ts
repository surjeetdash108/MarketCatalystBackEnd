/**
 * The saved Money Flow board.
 *
 * The worker builds the board on a schedule (money-flow-snapshot job, every
 * minute 09:00–16:59 ET on weekdays) and saves it to Firestore
 * `money_flow/latest`. The live API serves the saved board instead of building
 * one while a user waits (a cold build took 42–185 s), and the browser reads the
 * same document directly — firestore.rules lets Pro plans and staff read it.
 *
 * Stored as gzipped JSON in base64 (`gz`): the board is a few hundred KB of
 * JSON, gzip brings it to roughly a tenth, comfortably inside Firestore's 1 MiB
 * document limit. The browser unzips it with DecompressionStream.
 */
import { gunzipSync, gzipSync } from "zlib";
import type { MoneyFlowBoard } from "./money-flow.calc";

export const SNAPSHOT_COLLECTION = "money_flow";
export const SNAPSHOT_DOC = "latest";
export const SNAPSHOT_SCHEMA = 1;

/** While the session runs, a saved board older than this is not served (the worker has stalled). */
export const SNAPSHOT_MAX_AGE_MS = 10 * 60_000;
/** Outside the session the last board stands — but not past a long weekend (Fri close → Tue open). */
export const SNAPSHOT_OFFHOURS_MAX_AGE_MS = 4 * 24 * 60 * 60_000;
/** Firestore's document limit is 1 MiB; refuse to write anything near it. */
export const SNAPSHOT_MAX_GZ_BYTES = 900_000;

export interface SnapshotDoc {
  schema: number;
  /** base64 of gzip(JSON.stringify(board)). */
  gz: string;
  /** Epoch ms of the board's asOf. */
  builtAt: number;
  sessionDate: string;
  jsonBytes: number;
  gzBytes: number;
}

export function encodeSnapshot(board: MoneyFlowBoard): SnapshotDoc {
  const json = JSON.stringify(board);
  const gz = gzipSync(Buffer.from(json, "utf8"));
  const builtAt = Date.parse(board.asOf);
  return {
    schema: SNAPSHOT_SCHEMA,
    gz: gz.toString("base64"),
    builtAt: Number.isFinite(builtAt) ? builtAt : Date.now(),
    sessionDate: board.sessionDate,
    jsonBytes: Buffer.byteLength(json),
    gzBytes: gz.length,
  };
}

export function decodeSnapshot(doc: Pick<SnapshotDoc, "gz">): MoneyFlowBoard {
  return JSON.parse(
    gunzipSync(Buffer.from(doc.gz, "base64")).toString("utf8"),
  ) as MoneyFlowBoard;
}

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Weekday 09:30–16:30 ET: the board is changing, so the saved copy must be recent. */
export function sessionRunning(nowMs: number): boolean {
  const p = Object.fromEntries(
    ET_PARTS.formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]),
  );
  if (p.weekday === "Sat" || p.weekday === "Sun") return false;
  const minutes = (Number(p.hour) % 24) * 60 + Number(p.minute);
  return minutes >= 9 * 60 + 30 && minutes <= 16 * 60 + 30;
}

/**
 * Whether a saved board may be served. Outside the session the last build
 * stands until the next open (up to SNAPSHOT_OFFHOURS_MAX_AGE_MS); within the
 * session only if it is at most SNAPSHOT_MAX_AGE_MS old, so a stalled worker
 * falls back to a live build instead of showing a frozen board.
 */
export function snapshotUsable(builtAtMs: number, nowMs: number): boolean {
  if (!Number.isFinite(builtAtMs)) return false;
  const age = nowMs - builtAtMs;
  if (age <= SNAPSHOT_MAX_AGE_MS) return true;
  return !sessionRunning(nowMs) && age <= SNAPSHOT_OFFHOURS_MAX_AGE_MS;
}
