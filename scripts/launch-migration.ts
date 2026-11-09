/**
 * Launch-day migration — PREPARED, NOT RUN. See src/billing/launch/launch-migration.ts.
 *
 *   npx ts-node --transpile-only scripts/launch-migration.ts \
 *     --project=<id> --database=<db> [--apply] [--send-emails] [--confirm-production]
 *
 * Dry run unless --apply. Refuses the production project without
 * --confirm-production, and refuses while LAUNCH_PROMO_PREFIX /
 * LAUNCH_PROMO_PERCENT hold placeholders. Uses Application Default Credentials.
 */
import "dotenv/config";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { AppClock } from "../src/common/app-clock";
import { DEFAULT_PRODUCTION_PROJECT_IDS } from "../src/common/environment";
import type { FirebaseAdminService } from "../src/common/firebase-admin.provider";
import { PlansService } from "../src/plans/plans.service";
import { SubscriptionsService } from "../src/plans/subscriptions.service";
import { BillingEventsService } from "../src/billing/billing-events.service";
import { ConsoleEmailSender } from "../src/billing/email/email-sender";
import { EmailService } from "../src/billing/email/email.service";
import { PromoService } from "../src/billing/promo/promo.service";
import { assertNoPlaceholders, runLaunchMigration } from "../src/billing/launch/launch-migration";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n: string) => process.argv.includes(`--${n}`);

async function main() {
  const project = arg("project");
  const database = arg("database") ?? "(default)";
  if (!project) throw new Error("--project is required");
  const prodIds = (process.env.PRODUCTION_PROJECT_IDS ?? DEFAULT_PRODUCTION_PROJECT_IDS).split(",").map((s) => s.trim());
  if (prodIds.includes(project) && flag("apply") && !flag("confirm-production")) {
    throw new Error(`${project} is production: add --confirm-production to apply.`);
  }
  const prefix = process.env.LAUNCH_PROMO_PREFIX ?? "LAUNCH_PLACEHOLDER";
  const percentRaw = process.env.LAUNCH_PROMO_PERCENT ?? "__PLACEHOLDER__";
  if (flag("apply")) assertNoPlaceholders({ promoPrefix: prefix, promoPercentOffRaw: percentRaw });
  const app = initializeApp({ credential: applicationDefault(), projectId: project });
  const firestore = database === "(default)" ? getFirestore(app) : getFirestore(app, database);
  const firebase = { firestore, auth: getAuth(app) } as unknown as FirebaseAdminService;
  const clock = new AppClock();
  const config = { get: (k: string, d?: unknown) => process.env[k] ?? d } as never;
  const plans = new PlansService(firebase);
  const subscriptions = new SubscriptionsService(firebase, plans, clock);
  const emails = new EmailService(new ConsoleEmailSender(), config);
  const events = new BillingEventsService(firebase, null, subscriptions, emails, clock);
  const promos = new PromoService(firebase, null, clock);
  const result = await runLaunchMigration(
    { firebase, events, promos, emails, clock },
    {
      apply: flag("apply"),
      planId: "pro",
      trialDays: 30,
      promoPercentOff: Number(percentRaw),
      promoPrefix: prefix,
      excludeEmails: [process.env.ADMIN_EMAIL ?? "admin@example.com"],
      sendEmails: flag("send-emails"),
    },
  );
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
