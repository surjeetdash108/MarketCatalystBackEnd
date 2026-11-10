import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Query,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { AdminGuard } from "../common/admin.guard";
import { AppClock } from "../common/app-clock";
import { CurrentUser } from "../common/current-user.decorator";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { BillingAccessService } from "./billing-access.service";
import { assertFake } from "./billing.controller";
import { FakeAdvanceDto, FakeApproveDto, FakeCardDto } from "./billing.dto";
import { FakeBillingProvider } from "./provider/fake/fake-billing.provider";
import {
  EMAIL_SENDER,
  type EmailSender,
  type EmailMessage,
} from "./email/email-sender";

/**
 * The fake provider's "hosted pages" (checkout, 3-D Secure, portal) and test
 * tools (clock, refunds). Every route 404s unless BILLING_PROVIDER=fake, which
 * cannot be set in the production project.
 */
@Controller("api/billing/fake")
export class FakeBillingController {
  constructor(
    private readonly access: BillingAccessService,
    private readonly firebase: FirebaseAdminService,
    private readonly clock: AppClock,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
  ) {}

  private get fake(): FakeBillingProvider {
    assertFake(this.access);
    return this.access.configuredProvider as FakeBillingProvider;
  }

  private async ownSession(uid: string, id: string) {
    const s = await this.fake.getCheckout(id);
    if (!s) throw new NotFoundException();
    if (s.uid !== uid) throw new ForbiddenException();
    return s;
  }

  private async ownCustomerId(uid: string): Promise<string> {
    const c = (
      await this.firebase.firestore.collection("customers").doc(uid).get()
    ).data();
    if (!c?.customerId) throw new ForbiddenException();
    return String(c.customerId);
  }

  @UseGuards(FirebaseAuthGuard)
  @Get("checkout/:id")
  async checkout(@CurrentUser() uid: string, @Param("id") id: string) {
    const s = await this.ownSession(uid, id);
    return {
      ...s,
      testCards: {
        success: "4242 4242 4242 4242",
        decline: "4000 0000 0000 0002",
        insufficient_funds: "4000 0000 0000 9995",
        requires_3ds: "4000 0025 0000 3155",
        renewal_failure: "4000 0000 0000 0341",
      },
    };
  }

  @UseGuards(FirebaseAuthGuard)
  @Post("checkout/:id/complete")
  @HttpCode(200)
  async complete(
    @CurrentUser() uid: string,
    @Param("id") id: string,
    @Body() body: FakeCardDto,
  ) {
    await this.ownSession(uid, id);
    return this.fake.completeCheckout(id, body.card);
  }

  @UseGuards(FirebaseAuthGuard)
  @Post("actions/:id")
  @HttpCode(200)
  confirm(@Param("id") id: string, @Body() body: FakeApproveDto) {
    return this.fake.confirmAction(id, body.approve);
  }

  @UseGuards(FirebaseAuthGuard)
  @Get("portal/:id")
  async portal(@CurrentUser() uid: string, @Param("id") id: string) {
    const p = await this.fake.getPortalSession(id);
    if (!p) throw new NotFoundException();
    if (p.customerId !== (await this.ownCustomerId(uid)))
      throw new ForbiddenException();
    const c = await this.fake.getCustomer(p.customerId);
    return { id: p.id, returnUrl: p.returnUrl, card: c?.card ?? null };
  }

  @UseGuards(FirebaseAuthGuard)
  @Post("portal/:id/card")
  @HttpCode(200)
  async card(
    @CurrentUser() uid: string,
    @Param("id") id: string,
    @Body() body: FakeCardDto,
  ) {
    const p = await this.fake.getPortalSession(id);
    if (!p) throw new NotFoundException();
    if (p.customerId !== (await this.ownCustomerId(uid)))
      throw new ForbiddenException();
    return this.fake.updateCard(p.customerId, body.card);
  }

  // ── test tools (admin) ────────────────────────────────────────────────

  @UseGuards(AdminGuard)
  @Get("clock")
  clockNow() {
    assertFake(this.access);
    return { now: this.clock.nowIso() };
  }

  @UseGuards(AdminGuard)
  @Post("clock/advance")
  @HttpCode(200)
  async advance(@Body() body: FakeAdvanceDto) {
    const target = body.to
      ? Date.parse(body.to)
      : this.clock.now() + (body.days ?? 0) * 86_400_000;
    const r = await this.fake.advanceTo(target);
    return { now: this.clock.nowIso(), processed: r.processed };
  }

  /** Dev only (fake provider): what the console email sender would have sent to `to`. */
  @UseGuards(AdminGuard)
  @Get("outbox")
  outbox(@Query("to") to: string) {
    assertFake(this.access);
    const box = (this.sender as { outbox?: EmailMessage[] }).outbox ?? [];
    return {
      messages: box
        .filter((m) => !to || m.to.toLowerCase() === String(to).toLowerCase())
        .slice(-20),
    };
  }

  @UseGuards(AdminGuard)
  @Get("events")
  async events() {
    return { events: await this.fake.listEvents() };
  }

  @UseGuards(AdminGuard)
  @Post("invoices/:id/refund")
  @HttpCode(200)
  async refund(@Param("id") id: string) {
    await this.fake.refundInvoice(id);
    return { refunded: true };
  }
}
