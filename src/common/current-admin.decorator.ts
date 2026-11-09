import { createParamDecorator, ExecutionContext } from "@nestjs/common";

/** The acting admin set by AdminGuard ("<email>" or "iam" for Cloud Scheduler / proxy calls). */
export const CurrentAdmin = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): string | null => {
    const req = ctx.switchToHttp().getRequest<{ adminActor?: string }>();
    return req.adminActor ?? null;
  },
);
