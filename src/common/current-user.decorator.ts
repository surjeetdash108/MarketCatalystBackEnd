import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Reads the uid attached by FirebaseAuthGuard. Only meaningful on a route
 * that also carries `@UseGuards(FirebaseAuthGuard)` — used without it, this
 * always returns undefined.
 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest();
  return req.uid;
});
