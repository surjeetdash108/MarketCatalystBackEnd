import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import { Observable, catchError, tap, throwError } from "rxjs";
import { FirebaseAdminService } from "./firebase-admin.provider";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SECRET_KEY = /pass|secret|token|key|authorization|card/i;

/** Drops secret-looking keys and caps size, so the audit log never stores credentials. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null) return value ?? null;
  if (Array.isArray(value))
    return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) ? "[REDACTED]" : redact(v, depth + 1),
      ]),
    );
  }
  return typeof value === "string" && value.length > 500
    ? `${value.slice(0, 500)}…`
    : value;
}

/**
 * Records every admin write (any POST/PUT/PATCH/DELETE that passed AdminGuard)
 * in admin_audit: who, what route, redacted body, outcome, when.
 */
@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AdminAuditInterceptor.name);

  constructor(private readonly firebase: FirebaseAdminService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== "http") return next.handle();
    const req = ctx.switchToHttp().getRequest<{
      method: string;
      originalUrl?: string;
      url: string;
      params?: unknown;
      body?: unknown;
      adminActor?: string;
    }>();
    if (!req.adminActor || !WRITE_METHODS.has(req.method)) return next.handle();
    const base = {
      actor: req.adminActor,
      method: req.method,
      path: (req.originalUrl ?? req.url).split("?")[0],
      params: redact(req.params ?? {}),
      body: redact(req.body ?? {}),
    };
    const write = (outcome: "ok" | "error", error?: string) =>
      this.firebase.firestore
        .collection("admin_audit")
        .doc()
        .set({
          ...base,
          outcome,
          error: error ?? null,
          at: new Date().toISOString(),
        })
        .catch((e: Error) =>
          this.logger.error(`audit write failed: ${e.message}`),
        );
    return next.handle().pipe(
      tap(() => void write("ok")),
      catchError((err: Error) => {
        void write("error", err.message);
        return throwError(() => err);
      }),
    );
  }
}
