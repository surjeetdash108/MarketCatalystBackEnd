import { createParamDecorator, ExecutionContext } from "@nestjs/common";

/** What FirebaseAuthGuard learned from the verified ID token (never the token itself). */
export interface AuthTokenInfo {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  /** Custom claims on the token (plan, staff, admin…). */
  claims: Record<string, unknown>;
  /** e.g. "password", "google.com". */
  signInProvider: string | null;
}

const RESERVED = new Set([
  "iss",
  "aud",
  "auth_time",
  "user_id",
  "sub",
  "iat",
  "exp",
  "email",
  "email_verified",
  "firebase",
  "uid",
  "name",
  "picture",
  "phone_number",
]);

export function authTokenInfo(
  decoded: Record<string, unknown> & { uid: string },
): AuthTokenInfo {
  const claims = Object.fromEntries(
    Object.entries(decoded).filter(([k]) => !RESERVED.has(k)),
  );
  const fb = decoded.firebase as { sign_in_provider?: string } | undefined;
  return {
    uid: decoded.uid,
    email: typeof decoded.email === "string" ? decoded.email : null,
    emailVerified: decoded.email_verified === true,
    claims,
    signInProvider: fb?.sign_in_provider ?? null,
  };
}

/** The verified token info attached by FirebaseAuthGuard (`req.authToken`). */
export const AuthToken = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthTokenInfo | undefined =>
    ctx.switchToHttp().getRequest().authToken,
);
