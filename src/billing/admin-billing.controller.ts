import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { CreatePromoDto, PriceChangeNoticeDto } from "./billing.dto";
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
  ) {}

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
      subscriberCount: rows.filter((r) => !r.staff && r.mrrMinor > 0).length,
      staffCount: rows.filter((r) => r.staff).length,
    };
  }

  @Get("subscribers/:uid")
  subscriber(@Param("uid") uid: string) {
    return this.admin.subscriber(uid);
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
