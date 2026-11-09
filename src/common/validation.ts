import { ValidationPipe } from "@nestjs/common";

/**
 * The app-wide request validation pipe.
 *
 * - `whitelist` strips any property a class DTO does not declare, so a client
 *   cannot smuggle server-owned fields (plan, billing, identity) through a
 *   profile or settings body.
 * - Unknown properties are stripped rather than rejected: older app builds
 *   still send fields such as `tier: "free"` at signup, and rejecting those
 *   would break signup during a rollout.
 * - Only class-typed bodies are validated. Routes whose `@Body()` is a plain
 *   interface are passed through unchanged, so installing this globally does
 *   not alter any existing endpoint that has not opted in with a DTO class.
 */
export function createGlobalValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: false,
    transform: false,
    stopAtFirstError: false,
  });
}
