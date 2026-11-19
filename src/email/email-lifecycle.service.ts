import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import type { UserRecord } from "firebase-admin/auth";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { freeWindowEnd } from "../common/et-calendar";
import { EmailService } from "../billing/email/email.service";
import { SubscriptionsService } from "../plans/subscriptions.service";
import { INTRO_DAYS } from "../plans/plans.registry";
import { signLinkToken, verifyLinkToken } from "./email-links";
import { deviceLabel } from "./device-label";

const JOB_NAME = "email-lifecycle";
const DAY = 86_400_000;
/** Users created before this get no lifecycle mail (no blast of existing accounts at launch). */
const LIFECYCLE_FROM_DEFAULT = "2026-11-20T00:00:00.000Z";
const UNSUBSCRIBE_MAX_AGE = 365 * DAY;
const SECURE_MAX_AGE = 2 * DAY;
const RESET_MAX_PER_HOUR = 3;
const KNOWN_DEVICES_MAX = 20;

/**
 * The account and lifecycle emails (designs in src/email/templates):
 *  - on email verification: Welcome, then Trial started (the free week);
 *  - hourly sweep (Cloud Scheduler → /sync/email-lifecycle/run): Getting
 *    started on day 2, First activation on day 2 if they never came back,
 *    Trial ending 3 days before the free week ends, Trial ended on the day;
 *  - new sign-in alert (from the sign-in claim sync), "Secure my account",
 *    one-click unsubscribe, and the password reset email.
 * Each is sent at most once per person (email_log/{uid}); promotional mail
 * honours users/{uid}.emailPrefs.marketing === false and carries an
 * unsubscribe link.
 */
@Injectable()
export class EmailLifecycleService implements OnModuleInit {
  private readonly logger = new Logger(EmailLifecycleService.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly emails: EmailService,
    private readonly subscriptions: SubscriptionsService,
    private readonly config: ConfigService,
    private readonly registry: SyncRegistry,
    private readonly meta: SyncMetaService,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["email_log"],
      cronExpression: "15 * * * *",
      timeZone: "America/New_York",
    });
  }

  private get db() {
    return this.firebase.firestore;
  }
  private get appUrl(): string {
    return String(
      this.config.get("APP_URL", "https://app.marketcatalyst.ai"),
    ).replace(/\/$/, "");
  }
  private get secret(): string {
    return String(this.config.get("EMAIL_LINK_SECRET", "") ?? "");
  }
  private get lifecycleFrom(): number {
    const t = Date.parse(
      String(
        this.config.get("EMAIL_LIFECYCLE_FROM", "") || LIFECYCLE_FROM_DEFAULT,
      ),
    );
    return Number.isFinite(t) ? t : Date.parse(LIFECYCLE_FROM_DEFAULT);
  }

  /** True the first time `key` is claimed for `uid` (email_log/{uid}.{key}). */
  async once(uid: string, key: string): Promise<boolean> {
    const ref = this.db.collection("email_log").doc(uid);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (
        snap.exists &&
        (snap.data() as Record<string, unknown> | undefined)?.[key]
      )
        return false;
      tx.set(ref, { [key]: new Date().toISOString() }, { merge: true });
      return true;
    });
  }

  async marketingAllowed(uid: string): Promise<boolean> {
    const d = (await this.db.collection("users").doc(uid).get()).data();
    return (
      (d?.emailPrefs as { marketing?: boolean } | undefined)?.marketing !==
      false
    );
  }

  unsubscribeUrl(uid: string): string | null {
    return this.secret
      ? `${this.appUrl}/api/email/unsubscribe?t=${signLinkToken(this.secret, uid, "unsubscribe")}`
      : null;
  }

  secureUrl(uid: string): string {
    return this.secret
      ? `${this.appUrl}/api/account/secure?t=${signLinkToken(this.secret, uid, "secure")}`
      : `${this.appUrl}/auth/forgot-password`;
  }

  /** Welcome and Trial started, right after the email is verified (once each). */
  async onVerified(uid: string): Promise<void> {
    try {
      const u = await this.firebase.auth.getUser(uid);
      if (!u.email || !u.emailVerified) return;
      if (await this.once(uid, "welcome"))
        await this.emails.accountWelcome(u.email);
      const eff = await this.subscriptions.forUser(uid);
      if (
        eff.status === "INTRO" &&
        eff.expiryDate &&
        (await this.once(uid, "trialStarted"))
      )
        await this.emails.trialStarted(u.email, {
          trialEndsAt: eff.expiryDate,
        });
    } catch (err) {
      this.logger.warn(`onVerified ${uid}: ${(err as Error).message}`);
    }
  }

  /** The hourly sweep over recent accounts. */
  async run(now = Date.now()) {
    const counts = { checked: 0, sent: 0 };
    try {
      const since = Math.max(this.lifecycleFrom, now - 15 * DAY);
      const snap = await this.db
        .collection("users")
        .where("createdAt", ">=", new Date(since).toISOString())
        .get();
      for (const doc of snap.docs) {
        counts.checked++;
        try {
          counts.sent += await this.sweepOne(doc.id, now);
        } catch (err) {
          this.logger.warn(
            `email-lifecycle ${doc.id}: ${(err as Error).message}`,
          );
        }
      }
      await this.meta.record(JOB_NAME, { ok: true, count: counts.sent });
      return counts;
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  private async sweepOne(uid: string, now: number): Promise<number> {
    const u = (await this.firebase.auth
      .getUser(uid)
      .catch(() => null)) as UserRecord | null;
    if (!u?.email || !u.emailVerified) return 0;
    const created = Date.parse(u.metadata.creationTime);
    if (!Number.isFinite(created) || created < this.lifecycleFrom) return 0;
    let sent = 0;
    // Google sign-ups never pass the code step: catch Welcome / Trial started here.
    const log =
      (await this.db.collection("email_log").doc(uid).get()).data() ?? {};
    if (!log.welcome) await this.onVerified(uid);
    const age = now - created;
    const marketing = await this.marketingAllowed(uid);
    const unsub = this.unsubscribeUrl(uid);
    if (marketing && unsub && age >= 2 * DAY && age < 7 * DAY) {
      if (await this.once(uid, "gettingStarted")) {
        await this.emails.gettingStarted(u.email, { unsubscribeUrl: unsub });
        sent++;
      }
      const lastIn = Date.parse(u.metadata.lastSignInTime ?? "");
      const neverBack =
        !Number.isFinite(lastIn) || lastIn - created < 30 * 60_000;
      if (neverBack && (await this.once(uid, "firstActivation"))) {
        await this.emails.firstActivation(u.email, { unsubscribeUrl: unsub });
        sent++;
      }
    }
    const eff = await this.subscriptions.forUser(uid);
    if (eff.status === "INTRO" && eff.expiryDate) {
      const left = Date.parse(eff.expiryDate) - now;
      if (
        marketing &&
        unsub &&
        left > 0 &&
        left <= 3 * DAY &&
        (await this.once(uid, "trialEnding"))
      ) {
        await this.emails.trialEnding(u.email, {
          trialEndsAt: eff.expiryDate,
          unsubscribeUrl: unsub,
        });
        sent++;
      }
    } else if (
      eff.status !== "ACTIVE" &&
      eff.status !== "TRIALING" &&
      !eff.entitled
    ) {
      const start = await this.subscriptions.accountStartMs(uid);
      const end = start != null ? freeWindowEnd(start, INTRO_DAYS) : null;
      if (
        marketing &&
        unsub &&
        end != null &&
        now >= end &&
        now - end < 3 * DAY &&
        (await this.once(uid, "trialEnded"))
      ) {
        await this.emails.trialEnded(u.email, {
          trialEndsAt: new Date(end).toISOString(),
          unsubscribeUrl: unsub,
        });
        sent++;
      }
    }
    return sent;
  }

  /**
   * A sign-in (the UI's claim sync on sign-in / token refresh): alert when the
   * device is new for this account. The first device ever recorded doesn't
   * alert (that's the sign-up).
   */
  async recordSignIn(
    uid: string,
    ip: string | null,
    userAgent: string | null,
    now = Date.now(),
  ): Promise<void> {
    try {
      const device = deviceLabel(userAgent);
      const fp = createHash("sha256").update(device).digest("hex").slice(0, 16);
      const ref = this.db.collection("user_devices").doc(uid);
      const isNew = await this.db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const known = (
          (snap.data()?.known as Array<{ fp: string; at: string }>) ?? []
        ).filter((k) => k?.fp);
        if (known.some((k) => k.fp === fp)) return false;
        tx.set(
          ref,
          {
            known: [
              ...known,
              { fp, device, at: new Date(now).toISOString() },
            ].slice(-KNOWN_DEVICES_MAX),
          },
          { merge: true },
        );
        return known.length > 0;
      });
      if (!isNew) return;
      const u = await this.firebase.auth.getUser(uid);
      if (!u.email) return;
      const time =
        new Date(now)
          .toLocaleString("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            timeZone: "America/New_York",
          })
          .replace(",", " ·") + " ET";
      await this.emails.loginAlert(u.email, {
        time,
        device,
        location: "Not available",
        ip: ip ?? "Unknown",
        secureUrl: this.secureUrl(uid),
      });
    } catch (err) {
      this.logger.warn(`recordSignIn ${uid}: ${(err as Error).message}`);
    }
  }

  /** "Secure my account": sign out every session and email a password reset link. */
  async secure(token: string): Promise<boolean> {
    const uid = verifyLinkToken(this.secret, token, "secure", SECURE_MAX_AGE);
    if (!uid) return false;
    await this.firebase.auth.revokeRefreshTokens(uid);
    const u = await this.firebase.auth.getUser(uid);
    if (u.email) await this.sendPasswordReset(u.email, null, true);
    return true;
  }

  /** One-click unsubscribe from promotional mail. */
  async unsubscribe(token: string): Promise<boolean> {
    const uid = verifyLinkToken(
      this.secret,
      token,
      "unsubscribe",
      UNSUBSCRIBE_MAX_AGE,
    );
    if (!uid) return false;
    await this.db
      .collection("users")
      .doc(uid)
      .set({ emailPrefs: { marketing: false } }, { merge: true });
    return true;
  }

  async emailPrefs(uid: string): Promise<{ marketing: boolean }> {
    return { marketing: await this.marketingAllowed(uid) };
  }

  async setEmailPrefs(
    uid: string,
    marketing: boolean,
  ): Promise<{ marketing: boolean }> {
    await this.db
      .collection("users")
      .doc(uid)
      .set({ emailPrefs: { marketing } }, { merge: true });
    return { marketing };
  }

  /**
   * Our branded password-reset email: a Firebase reset code opened on our
   * /auth/action page. Never says whether the address has an account;
   * at most RESET_MAX_PER_HOUR per address.
   */
  async sendPasswordReset(
    email: string,
    _ip: string | null,
    skipLimit = false,
  ): Promise<void> {
    const addr = String(email ?? "")
      .trim()
      .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return;
    if (!skipLimit) {
      const ref = this.db
        .collection("password_reset_requests")
        .doc(createHash("sha256").update(addr).digest("hex"));
      const now = Date.now();
      const sends = (
        ((await ref.get()).data()?.sends as number[] | undefined) ?? []
      ).filter((t) => now - t < 3_600_000);
      if (sends.length >= RESET_MAX_PER_HOUR) return;
      await ref.set({ sends: [...sends, now] });
    }
    let link: string;
    try {
      link = await this.firebase.auth.generatePasswordResetLink(addr, {
        url: `${this.appUrl}/auth/login`,
      });
    } catch {
      return; // no such account: say nothing
    }
    const oob = new URL(link).searchParams.get("oobCode");
    if (!oob) return;
    await this.emails.passwordReset(addr, {
      resetUrl: `${this.appUrl}/auth/action?mode=resetPassword&oobCode=${encodeURIComponent(oob)}`,
    });
  }
}
