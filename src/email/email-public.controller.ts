import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { clientIp } from "../common/client-ip";
import { Public } from "../common/public.decorator";
import { escapeHtml } from "./email-template";
import { EmailLifecycleService } from "./email-lifecycle.service";

/** A small branded page for the one-click links (no login). */
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="margin:0;background:#f4f6f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#07080a"><div style="max-width:460px;margin:12vh auto;padding:32px;background:#fff;border:1px solid #e4e9e6;border-radius:18px;text-align:center"><h1 style="margin:0 0 10px;font-size:22px">${escapeHtml(title)}</h1><p style="margin:0 0 22px;color:#3a4148;line-height:1.5">${escapeHtml(body)}</p><a href="https://app.marketcatalyst.ai" style="display:inline-block;padding:12px 24px;border-radius:99px;background:#4ade80;color:#07080a;font-weight:600;text-decoration:none">Open MarketCatalyst</a></div></body></html>`;
}

/** One-click email links and the password reset request (no sign-in by nature). */
@Controller()
export class EmailPublicController {
  constructor(private readonly lifecycle: EmailLifecycleService) {}

  @Get("api/email/unsubscribe")
  @Public("one-click unsubscribe link from an email (signed token)")
  async unsubscribe(@Query("t") t: string, @Res() res: Response) {
    const ok = await this.lifecycle
      .unsubscribe(String(t ?? ""))
      .catch(() => false);
    res
      .status(ok ? 200 : 400)
      .type("html")
      .send(
        ok
          ? page(
              "You're unsubscribed",
              "You won't get tips and offers from MarketCatalyst any more. Account, billing and security emails still reach you.",
            )
          : page(
              "This link didn't work",
              "It may have expired. You can turn promotional emails off in Settings.",
            ),
      );
  }

  @Get("api/account/secure")
  @Public("'Secure my account' link from a new sign-in alert (signed token)")
  async secure(@Query("t") t: string, @Res() res: Response) {
    const ok = await this.lifecycle.secure(String(t ?? "")).catch(() => false);
    res
      .status(ok ? 200 : 400)
      .type("html")
      .send(
        ok
          ? page(
              "Your account is secured",
              "We signed you out everywhere and emailed you a link to choose a new password.",
            )
          : page(
              "This link didn't work",
              "It may have expired. Reset your password from the sign-in page.",
            ),
      );
  }

  @Post("api/account/password-reset")
  @HttpCode(200)
  @Public("forgot-password request; never reveals whether an account exists")
  async passwordReset(@Body() body: { email?: unknown }, @Req() req: Request) {
    await this.lifecycle
      .sendPasswordReset(
        typeof body?.email === "string" ? body.email : "",
        clientIp(req),
      )
      .catch(() => undefined);
    return { ok: true };
  }
}
