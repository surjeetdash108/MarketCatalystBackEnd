import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { AdminGuard } from "../common/admin.guard";
import { CurrentAdmin } from "../common/current-admin.decorator";
import {
  AdminBillingService,
  toCsv,
  type SubscriberFilter,
} from "./admin-billing.service";
import {
  CreatePromoDto,
  PriceChangeNoticeDto,
  TestClockAdvanceDto,
  TestClockListDto,
} from "./billing.dto";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  BILLING_PROVIDER,
  type BillingProvider,
} from "./provider/billing-provider";
import { PromoService } from "./promo/promo.service";
import { BillingReconcileJob } from "./reconcile.job";

/** Admin billing console API. Every write is recorded in admin_audit (AdminAuditInterceptor). */
@Controller("api/admin/billing")
@UseGuards(AdminGuard)
export class AdminBillingController {
  constructor(
    private readonly admin: AdminBillingService,
    private readonly promos: PromoService,
    private readonly reconcile: BillingReconcileJob,
    private readonly firebase: FirebaseAdminService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider | null,
  ) {}

  // ── test clocks (Stripe test mode only) ───────────────────────────────

  /** Emails whose NEW Stripe customer is put on a test clock (config/test_clocks). */
  @Get("test-clocks")
  async testClockList() {
    const d = (
      await this.firebase.firestore.doc("config/test_clocks").get()
    ).data();
    return {
      emails: Array.isArray(d?.emails) ? d.emails : [],
      livemode: this.provider?.livemode ?? null,
    };
  }

  @Post("test-clocks")
  @HttpCode(200)
  async setTestClockList(@Body() body: TestClockListDto) {
    const emails = [
      ...new Set(
        body.emails.map((e) => e.trim().toLowerCase()).filter(Boolean),
      ),
    ];
    await this.firebase.firestore.doc("config/test_clocks").set({ emails });
    return { emails };
  }

  private async customerOf(uid: string): Promise<string> {
    const c = (
      await this.firebase.firestore.collection("customers").doc(uid).get()
    ).data();
    if (!c?.customerId)
      throw new NotFoundException("This user has no billing account yet.");
    return String(c.customerId);
  }

  /** Where this user's test clock is. */
  @Get("test-clock/:uid")
  async testClock(@Param("uid") uid: string) {
    if (!this.provider?.testClockFor)
      throw new NotFoundException("Test clocks need Stripe in test mode.");
    return {
      clock: await this.provider.testClockFor(await this.customerOf(uid)),
    };
  }

  /** Moves this user's test clock forward (by `days`, or to `to`): renewals, trial ends and retries run. */
  @Post("test-clock/advance")
  @HttpCode(200)
  async advanceTestClock(@Body() body: TestClockAdvanceDto) {
    if (
      !this.provider?.advanceTestClock ||
      !this.provider.testClockFor ||
      this.provider.livemode
    )
      throw new NotFoundException("Test clocks need Stripe in test mode.");
    const customerId = await this.customerOf(body.uid);
    const clock = await this.provider.testClockFor(customerId);
    if (!clock)
      throw new NotFoundException(
        "This user isn't on a test clock (add their email to the list before their first checkout).",
      );
    const from = Date.parse(clock.frozenTime);
    const to = body.to
      ? Date.parse(body.to)
      : from + (body.days ?? 1) * 86_400_000;
    return this.provider.advanceTestClock(customerId, to);
  }

  @Get("subscribers")
  async subscribers(
    @Query() q: SubscriberFilter & { format?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const rows = await this.admin.subscribers(q);
    if (q.format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="subscribers.csv"',
      );
      return toCsv(rows);
    }
    return {
      subscribers: rows,
      totalMrrMinor: rows.reduce((a, r) => a + r.mrrMinor, 0),
      // Paying customers only: staff are never counted.
      subscriberCount: rows.filter((r) => !r.staff && !r.test && r.mrrMinor > 0)
        .length,
      staffCount: rows.filter((r) => r.staff).length,
      testCount: rows.filter((r) => r.test).length,
    };
  }

  @Get("subscribers/:uid")
  subscriber(@Param("uid") uid: string) {
    return this.admin.subscriber(uid);
  }

  @Get("abandoned")
  async abandonedCheckouts() {
    return {
      leads: await this.admin.abandonedCheckouts(),
      ...(await this.admin.signupFunnel()),
    };
  }

  @Get("promos")
  async listPromos() {
    return { promos: await this.promos.list() };
  }

  @Post("promos")
  @HttpCode(201)
  createPromo(@Body() body: CreatePromoDto, @CurrentAdmin() admin: string) {
    return this.promos.create(body, admin);
  }

  @Post("promos/:id/deactivate")
  @HttpCode(200)
  deactivatePromo(@Param("id") id: string) {
    return this.promos.deactivate(id);
  }

  @Get("promos/:id/redemptions")
  async redemptions(@Param("id") id: string) {
    return { redemptions: await this.promos.redemptions(id) };
  }

  @Get("audit")
  async audit(@Query("limit") limit?: string) {
    return { audit: await this.admin.audit(Number(limit) || 200) };
  }

  @Post("price-change-notice")
  @HttpCode(200)
  priceChange(@Body() body: PriceChangeNoticeDto) {
    return this.admin.priceChangeNotice(body);
  }

  @Post("reconcile")
  @HttpCode(200)
  runReconcile() {
    return this.reconcile.run();
  }
}
