import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { AdminGuard } from "./admin.guard";
import { AllowEditor } from "./editor-access.decorator";

/**
 * GET /api/admin/whoami: which console the signed-in account gets. The admin
 * console page asks this before it opens, so an editor's console shows only
 * Blogs and Content pipeline, and an account the backend does not admit is
 * sent away instead of seeing an empty console.
 */
@UseGuards(AdminGuard)
@Controller("api/admin")
export class AdminWhoamiController {
  @Get("whoami")
  @AllowEditor()
  whoami(
    @Req()
    req: {
      adminEmail?: string;
      adminRole?: string;
      adminActor?: string;
    },
  ) {
    return {
      email: req.adminEmail ?? null,
      role: req.adminRole ?? (req.adminActor === "iam" ? "admin" : null),
    };
  }
}
