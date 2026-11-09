import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { SyncRegistry } from "../common/sync-registry.service";
import {
  BillingEventsService,
  mapStatus,
  type MirrorDoc,
} from "./billing-events.service";
import {
  BILLING_PROVIDER,
  type BillingProvider,
} from "./provider/billing-provider";
import type { ProviderSubscription } from "./provider/types";

export const RECONCILE_JOB = "billing-reconcile";

/** Fields whose disagreement with the provider counts as drift. */
export function drifted(
  m: MirrorDoc | undefined,
  s: ProviderSubscription,
): string[] {
  if (!m) return ["missing"];
  const out: string[] = [];
  if (m.subscriptionId !== s.id) out.push("subscriptionId");
  if (m.planId !== s.planId) out.push("planId");
  if (m.interval !== s.interval) out.push("interval");
  if (m.status !== mapStatus(s.status)) out.push("status");
  if (m.currentPeriodEnd !== s.currentPeriodEnd) out.push("currentPeriodEnd");
  if (Boolean(m.cancelAtPeriodEnd) !== s.cancelAtPeriodEnd)
    out.push("cancelAtPeriodEnd");
  if (
    JSON.stringify(m.scheduledChange ?? null) !==
    JSON.stringify(s.scheduledChange ?? null)
  )
    out.push("scheduledChange");
  return out;
}

/**
 * Nightly reconcile: compares every provider subscription (and every live
 * mirror) with the provider and repairs drift through the event handler's
 * own write path — e.g. after a missed or failed webhook.
 */
@Injectable()
export class BillingReconcileJob implements OnModuleInit {
  private readonly logger = new Logger(BillingReconcileJob.name);

  constructor(
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider | null,
    private readonly events: BillingEventsService,
    private readonly firebase: FirebaseAdminService,
    private readonly registry: SyncRegistry,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.register(RECONCILE_JOB, () => this.run(), {
      collections: ["subscriptions", "users"],
      cronExpression: "30 3 * * *",
      timeZone: "America/New_York",
    });
  }

  @Cron("30 3 * * *", { timeZone: "America/New_York" })
  async scheduled(): Promise<void> {
    if (
      String(
        this.config.get("ENABLE_SCHEDULED_JOBS", "false"),
      ).toLowerCase() !== "true"
    )
      return;
    await this.run();
  }

  async run(): Promise<{
    skipped?: string;
    checked: number;
    repaired: Array<{ uid: string; fields: string[] }>;
  }> {
    if (!this.provider)
      return {
        skipped: "no billing provider configured",
        checked: 0,
        repaired: [],
      };
    const mirrors = new Map<string, MirrorDoc>();
    for (const d of (
      await this.firebase.firestore.collection("subscriptions").get()
    ).docs)
      mirrors.set(d.id, d.data() as MirrorDoc);
    const ids = new Set<string>(
      (await this.provider.listSubscriptions()).map((s) => s.id),
    );
    for (const m of mirrors.values()) {
      if (
        m.subscriptionId &&
        m.source !== "launch_trial" &&
        ["ACTIVE", "TRIALING", "PAST_DUE"].includes(m.status)
      )
        ids.add(m.subscriptionId);
    }
    const repaired: Array<{ uid: string; fields: string[] }> = [];
    for (const id of ids) {
      const s = await this.provider.getSubscription(id);
      if (!s?.uid) continue;
      const fields = drifted(mirrors.get(s.uid), s);
      if (!fields.length) continue;
      if ((await this.events.applySubscription(s, null)) === "processed")
        repaired.push({ uid: s.uid, fields });
    }
    if (repaired.length)
      this.logger.warn(`reconcile repaired ${repaired.length} mirror(s)`);
    return { checked: ids.size, repaired };
  }
}
