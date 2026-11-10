import type { Firestore } from "firebase-admin/firestore";
import { STAFF_DOC, normaliseStaffEmail } from "./staff-access.service";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface StaffSeedResult {
  dryRun: boolean;
  before: string[];
  after: string[];
  added: string[];
}

/** Adds `emails` to config/staff_access (lowercased, deduped). Idempotent; dry run writes nothing. */
export async function seedStaff(
  db: Firestore,
  emails: string[],
  opts: { dryRun: boolean },
): Promise<StaffSeedResult> {
  const wanted = [...new Set(emails.map(normaliseStaffEmail).filter(Boolean))];
  const bad = wanted.filter((e) => !EMAIL.test(e));
  if (bad.length) throw new Error(`not email addresses: ${bad.join(", ")}`);
  const ref = db.doc(STAFF_DOC);
  const raw = (await ref.get()).data()?.emails;
  const before = (
    Array.isArray(raw)
      ? raw.map((e: string) => normaliseStaffEmail(String(e)))
      : []
  ).sort();
  const added = wanted.filter((e) => !before.includes(e)).sort();
  const after = [...new Set([...before, ...added])].sort();
  if (!opts.dryRun && added.length)
    await ref.set({ emails: after, updatedAt: new Date().toISOString() });
  return { dryRun: opts.dryRun, before, after, added };
}
