/**
 * Apply the plan catalog (plans.registry, CATALOG_VERSION) to the `plans`
 * collection. One-off operator step; the app never does this on boot.
 *
 *   # 1. see exactly what would change (default; never writes)
 *   npx ts-node --transpile-only scripts/apply-catalog.ts --project=<id> [--database=<db>] --dry-run
 *
 *   # 2. apply: backs up the whole current collection to
 *   #    <backup-dir>/plans-backup-<timestamp>.json, THEN writes in one batch
 *   npx ts-node --transpile-only scripts/apply-catalog.ts --project=<id> [--database=<db>] \
 *     --apply [--backup-dir=./catalog-backups] [--confirm-production]
 *
 *   # offline: diff a JSON snapshot of the collection ({ "<id>": {fields} })
 *   npx ts-node --transpile-only scripts/apply-catalog.ts --from-json=plans.json
 *
 * Idempotent: a second --apply finds nothing to change, writes nothing and
 * takes no backup. Refuses the production project without --confirm-production.
 * Uses Application Default Credentials.
 */
import { readFileSync } from "fs";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { DEFAULT_PRODUCTION_PROJECT_IDS } from "../src/common/environment";
import { CATALOG_VERSION } from "../src/plans/plans.registry";
import {
  applyCatalog,
  formatChanges,
  planCatalog,
  type StoredPlans,
} from "../src/plans/catalog-apply";

const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n: string) => process.argv.includes(`--${n}`);

async function main() {
  const apply = flag("apply") && !flag("dry-run");
  const fromJson = arg("from-json");
  if (fromJson) {
    if (apply) throw new Error("--from-json is a dry run only");
    const stored = JSON.parse(readFileSync(fromJson, "utf8")) as StoredPlans;
    const plan = planCatalog(stored, new Date().toISOString());
    console.log(`DRY RUN (snapshot ${fromJson}) — catalog v${CATALOG_VERSION}`);
    console.log(formatChanges(plan.changes));
    console.log(`${plan.writes.length} document write(s) would be made.`);
    return;
  }

  const project = arg("project");
  const database = arg("database") ?? "(default)";
  if (!project) throw new Error("--project is required");
  const prodIds = (
    process.env.PRODUCTION_PROJECT_IDS ?? DEFAULT_PRODUCTION_PROJECT_IDS
  )
    .split(",")
    .map((s) => s.trim());
  if (apply && prodIds.includes(project) && !flag("confirm-production")) {
    throw new Error(
      `${project} is production: add --confirm-production to apply.`,
    );
  }
  const app = initializeApp({
    credential: applicationDefault(),
    projectId: project,
  });
  const db =
    database === "(default)" ? getFirestore(app) : getFirestore(app, database);
  const r = await applyCatalog(db, {
    dryRun: !apply,
    backupDir: arg("backup-dir") ?? "./catalog-backups",
  });
  console.log(
    `${r.dryRun ? "DRY RUN" : "APPLIED"} — ${project}/${database} — catalog v${CATALOG_VERSION}`,
  );
  console.log(formatChanges(r.changes));
  if (r.backupFile)
    console.log(`Backup written before any change: ${r.backupFile}`);
  console.log(
    `${r.writes.length} document write(s) ${r.dryRun ? "would be made" : "made"}.`,
  );
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
