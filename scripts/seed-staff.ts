/**
 * Seeds the staff allowlist (Firestore config/staff_access). The list itself is
 * never in code: pass it on the command line.
 *
 *   # dry run (default): prints what would change, writes nothing
 *   npx ts-node --transpile-only scripts/seed-staff.ts --project=<id> [--database=<db>] \
 *     --emails=a@x.com,b@y.com
 *   # write (idempotent: only missing addresses are added)
 *   ... --apply                                  # emulator / staging
 *   ... --apply --confirm-production             # production (owner's OK only)
 *
 * Credentials: --auth=adc (default) or --auth=gcloud (signed-in gcloud account,
 * token in memory only); FIRESTORE_EMULATOR_HOST for the emulator.
 */
import { scriptAuthFrom, scriptFirestore } from "./lib/script-firestore";
import { DEFAULT_PRODUCTION_PROJECT_IDS } from "../src/common/environment";
import { seedStaff } from "../src/account/staff-seed";

const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n: string) => process.argv.includes(`--${n}`);

async function main() {
  const project = arg("project");
  const database = arg("database") ?? "(default)";
  const emails = (arg("emails") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!project) throw new Error("--project is required");
  if (!emails.length) throw new Error("--emails=a@x.com,b@y.com is required");
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
  const r = await seedStaff(db, emails, { dryRun: !apply });
  console.log(
    `${r.dryRun ? "DRY RUN" : "APPLIED"} — ${project}/${database} — config/staff_access`,
  );
  console.log(`  before: ${r.before.length} address(es)`);
  console.log(
    `  add:    ${r.added.length ? r.added.join(", ") : "(nothing — already present)"}`,
  );
  console.log(`  after:  ${r.after.length} address(es)`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
