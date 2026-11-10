/**
 * Deletes Stripe TEST-mode billing records (livemode:false) left by the staff
 * checkout preview. Live records are never touched.
 *
 *   # dry run (default): lists what would be deleted, writes nothing
 *   npx ts-node --transpile-only scripts/purge-test-billing.ts --project=<id> [--database=<db>]
 *   # delete
 *   ... --apply                                  # emulator / staging
 *   ... --apply --confirm-production             # production
 *
 * Credentials: --auth=adc (default) or --auth=gcloud (signed-in gcloud account,
 * token in memory only); FIRESTORE_EMULATOR_HOST for the emulator.
 * Test-mode objects in Stripe itself are cleared from the Stripe Dashboard
 * (Developers → "Delete all test data").
 */
import { scriptAuthFrom, scriptFirestore } from "./lib/script-firestore";
import { DEFAULT_PRODUCTION_PROJECT_IDS } from "../src/common/environment";
import { purgeTestModeBilling } from "../src/billing/test-mode-purge";

const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n: string) => process.argv.includes(`--${n}`);

async function main() {
  const project = arg("project");
  const database = arg("database") ?? "(default)";
  if (!project) throw new Error("--project is required");
  const apply = flag("apply") && !flag("dry-run");
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
  const db = scriptFirestore(project, database, scriptAuthFrom(process.argv));
  const r = await purgeTestModeBilling(db, { dryRun: !apply });
  console.log(
    `${r.dryRun ? "DRY RUN" : "DELETED"} — ${project}/${database} — test-mode billing records`,
  );
  for (const [col, ids] of Object.entries(r.deleted))
    console.log(`  ${col.padEnd(20)} ${ids.length}`);
  console.log(`  users reset to Free  ${r.usersReset.length}`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
