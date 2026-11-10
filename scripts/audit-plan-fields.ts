/**
 * READ-ONLY audit: lists users/{uid} documents that carry plan, subscription,
 * Stripe or feature-flag fields (non-default values). Before the M0 hardening,
 * any signed-in user could write these themselves, so each hit must be reviewed
 * before billing launches.
 *
 * It performs reads only — no set/update/delete, no claims — and is guarded so
 * it cannot be run by accident:
 *
 *   npx ts-node scripts/audit-plan-fields.ts \
 *     --project=<firebase-project-id> --database=<firestore-db-id> \
 *     --out=<path/to/report.json> --confirm-read-only
 *
 * Credentials: Application Default Credentials (`gcloud auth
 * application-default login`) for an account with Firestore read access.
 * stdout gets counts only; uids, emails and field values go to --out.
 */
import { writeFileSync } from "fs";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { auditUserDoc, type PlanFieldFinding } from "../src/plans/plan-field-audit";

function arg(name: string): string | undefined {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const project = arg("project");
  const database = arg("database");
  const out = arg("out");
  if (!project || !database || !out || !process.argv.includes("--confirm-read-only")) {
    console.error(
      "Usage: --project=<id> --database=<id> --out=<file.json> --confirm-read-only (all required)",
    );
    process.exit(2);
  }
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    console.error(`Note: FIRESTORE_EMULATOR_HOST is set; reading the emulator, not ${project}.`);
  }

  const app = initializeApp({ credential: applicationDefault(), projectId: project });
  const db = database === "(default)" ? getFirestore(app) : getFirestore(app, database);

  const findings: PlanFieldFinding[] = [];
  let scanned = 0;
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  const PAGE = 500;
  for (;;) {
    let q = db.collection("users").orderBy("__name__").limit(PAGE);
    if (last) q = q.startAfter(last);
    const page = await q.get();
    for (const doc of page.docs) {
      scanned++;
      const f = auditUserDoc(doc.id, doc.data());
      if (f) findings.push(f);
    }
    if (page.size < PAGE) break;
    last = page.docs[page.docs.length - 1];
  }

  const byField: Record<string, number> = {};
  for (const f of findings) for (const k of Object.keys(f.fields)) byField[k] = (byField[k] ?? 0) + 1;

  writeFileSync(
    out,
    JSON.stringify({ project, database, scannedAt: new Date().toISOString(), scanned, findings }, null, 2),
  );
  console.log(`Scanned ${scanned} users/{uid} docs in ${project}/${database}.`);
  console.log(`${findings.length} carry non-default plan/billing fields. By field:`, byField);
  console.log(`Per-user details written to ${out}. No data was changed.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
