import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { Firestore } from "firebase-admin/firestore";
import {
  CATALOG_VERSION,
  ENTITLEMENT_KEYS,
  PLAN_DEFINITIONS,
  RETIRED_PLAN_IDS,
} from "./plans.registry";

/**
 * Applying the plan catalog to the `plans` collection — an explicit, one-off
 * operator step (scripts/apply-catalog.ts), never done on boot.
 *
 * Rules (unchanged from the old boot seed):
 *  - a plan doc that is missing or stored under an older CATALOG_VERSION is
 *    rewritten whole from the registry;
 *  - within the current version, commercial fields always follow the registry,
 *    an operator's per-plan entitlement toggles are kept, new keys back-filled
 *    and unknown keys pruned;
 *  - retired plan ids (RETIRED_PLAN_IDS) are set active:false.
 *
 * Idempotent: a doc whose target equals what is stored (ignoring timestamps)
 * is not written, so a second run changes nothing.
 */

export type StoredPlans = Record<string, Record<string, unknown>>;

export interface FieldChange {
  path: string;
  before: unknown;
  after: unknown;
}
export interface PlanChange {
  id: string;
  op: "create" | "rewrite" | "update" | "retire" | "unchanged";
  reason: string;
  fields: FieldChange[];
}
export interface CatalogPlan {
  changes: PlanChange[];
  writes: Array<{
    id: string;
    kind: "set" | "update";
    data: Record<string, unknown>;
  }>;
}

const TIMESTAMPS = new Set(["createdAt", "updatedAt", "retiredAt"]);

function flatten(
  value: unknown,
  prefix = "",
  out: Record<string, unknown> = {},
): Record<string, unknown> {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  ) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out[prefix] = value;
  }
  return out;
}

export function diffFields(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
): FieldChange[] {
  const a = flatten(before ?? {});
  const b = flatten(after);
  const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((p) => !TIMESTAMPS.has(p.split(".")[0]))
    .sort();
  return paths
    .filter((p) => JSON.stringify(a[p]) !== JSON.stringify(b[p]))
    .map((p) => ({ path: p, before: a[p], after: b[p] }));
}

/** Pure: what applying the catalog to `stored` would do. */
export function planCatalog(stored: StoredPlans, nowIso: string): CatalogPlan {
  const changes: PlanChange[] = [];
  const writes: CatalogPlan["writes"] = [];

  for (const def of PLAN_DEFINITIONS) {
    const existing = stored[def.id];
    let target: Record<string, unknown>;
    let op: PlanChange["op"];
    let reason: string;
    if (!existing) {
      op = "create";
      reason = "missing";
      target = { ...def, catalogVersion: CATALOG_VERSION };
    } else if (existing.catalogVersion !== CATALOG_VERSION) {
      op = "rewrite";
      reason = `stored catalogVersion ${JSON.stringify(existing.catalogVersion ?? null)} → ${CATALOG_VERSION}`;
      target = { ...def, catalogVersion: CATALOG_VERSION };
    } else {
      op = "update";
      reason =
        "same version: registry commercial fields, operator entitlement edits kept";
      const kept = (existing.featureFlags ?? {}) as Record<string, unknown>;
      const featureFlags: Record<string, boolean> = {};
      // Built from ENTITLEMENT_KEYS, so unknown stored keys are pruned.
      for (const key of ENTITLEMENT_KEYS) {
        featureFlags[key] =
          typeof kept[key] === "boolean"
            ? kept[key]
            : def.featureFlags[key] === true;
      }
      target = { ...def, featureFlags, catalogVersion: CATALOG_VERSION };
    }
    // Firestore stores no `undefined`; compare and write what would be stored.
    target = JSON.parse(JSON.stringify(target)) as Record<string, unknown>;
    const fields = diffFields(existing, target);
    if (fields.length === 0) {
      changes.push({
        id: def.id,
        op: "unchanged",
        reason: "already current",
        fields,
      });
      continue;
    }
    changes.push({ id: def.id, op, reason, fields });
    writes.push({
      id: def.id,
      kind: "set",
      data: {
        ...target,
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nowIso,
      },
    });
  }

  for (const id of RETIRED_PLAN_IDS) {
    const existing = stored[id];
    if (!existing || existing.active === false) continue;
    changes.push({
      id,
      op: "retire",
      reason: "retired plan id",
      fields: [
        { path: "active", before: existing.active ?? null, after: false },
      ],
    });
    writes.push({
      id,
      kind: "update",
      data: { active: false, retiredAt: nowIso, updatedAt: nowIso },
    });
  }

  for (const id of Object.keys(stored).sort()) {
    if (
      !PLAN_DEFINITIONS.some((d) => d.id === id) &&
      !RETIRED_PLAN_IDS.includes(id)
    ) {
      changes.push({
        id,
        op: "unchanged",
        reason: "not in the catalog; left as is",
        fields: [],
      });
    }
  }
  return { changes, writes };
}

/** True when the stored docs are exactly the current catalog version for every catalog plan. */
export function isCatalogApplied(stored: StoredPlans): boolean {
  return PLAN_DEFINITIONS.every(
    (d) => stored[d.id]?.catalogVersion === CATALOG_VERSION,
  );
}

export async function readPlans(db: Firestore): Promise<StoredPlans> {
  const snap = await db.collection("plans").get();
  return Object.fromEntries(
    snap.docs.map((d) => [d.id, d.data() as Record<string, unknown>]),
  );
}

export interface ApplyResult extends CatalogPlan {
  dryRun: boolean;
  backupFile: string | null;
}

/**
 * Reads the collection, computes the changes and — unless dryRun — writes a
 * timestamped JSON backup of the whole current collection to `backupDir`
 * BEFORE committing all writes in one batch.
 */
export async function applyCatalog(
  db: Firestore,
  opts: { dryRun: boolean; backupDir?: string; now?: Date },
): Promise<ApplyResult> {
  const now = opts.now ?? new Date();
  const stored = await readPlans(db);
  const plan = planCatalog(stored, now.toISOString());
  if (opts.dryRun || plan.writes.length === 0)
    return { ...plan, dryRun: opts.dryRun, backupFile: null };
  if (!opts.backupDir)
    throw new Error("applyCatalog: backupDir is required to write");
  mkdirSync(opts.backupDir, { recursive: true });
  const backupFile = join(
    opts.backupDir,
    `plans-backup-${now.toISOString().replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(
    backupFile,
    JSON.stringify(
      { takenAt: now.toISOString(), collection: "plans", docs: stored },
      null,
      2,
    ),
  );
  const batch = db.batch();
  for (const w of plan.writes) {
    const ref = db.collection("plans").doc(w.id);
    if (w.kind === "set") batch.set(ref, w.data);
    else batch.update(ref, w.data);
  }
  await batch.commit();
  return { ...plan, dryRun: false, backupFile };
}

/** Human-readable diff for the script and the admin preview. */
export function formatChanges(changes: PlanChange[]): string {
  const lines: string[] = [];
  for (const c of changes) {
    lines.push(`${c.op.toUpperCase().padEnd(9)} plans/${c.id}  (${c.reason})`);
    for (const f of c.fields)
      lines.push(
        `    ${f.path}: ${JSON.stringify(f.before)} → ${JSON.stringify(f.after)}`,
      );
  }
  return lines.join("\n");
}
