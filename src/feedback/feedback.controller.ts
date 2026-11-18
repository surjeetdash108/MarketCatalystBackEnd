import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AdminGuard } from "../common/admin.guard";
import type { AuthTokenInfo } from "../common/auth-token";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { FeedbackService } from "./feedback.service";

/** POST /api/feedback — any signed-in account; who sent it comes from the token. */
@Controller("api")
@UseGuards(FirebaseAuthGuard)
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Post("feedback")
  async submit(
    @Req() req: Request & { authToken?: AuthTokenInfo; uid?: string },
    @Body() body: { text?: unknown },
  ) {
    const uid = req.authToken?.uid ?? req.uid ?? "";
    return this.feedback.submit(
      { uid, email: req.authToken?.email ?? null },
      body ?? {},
    );
  }
}

/** GET /api/admin/feedback — the console's Feedback list (AdminGuard). */
@UseGuards(AdminGuard)
@Controller("api/admin")
export class FeedbackAdminController {
  constructor(private readonly feedback: FeedbackService) {}

  @Get("feedback")
  async list() {
    return { feedback: await this.feedback.list() };
  }
}
