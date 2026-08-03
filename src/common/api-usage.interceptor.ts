import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { ApiUsageService } from './api-usage.service';

/**
 * Meters one API call per AUTHENTICATED request, globally.
 *
 * The uid is read from the Firebase ID token's payload WITHOUT verifying it:
 *   - metering is not a security decision (a spoofed uid only mis-attributes a
 *     usage counter), and
 *   - the app's data routes (/market-data, /live) are unguarded, so relying on
 *     the guard-set `req.uid` would miss exactly the busiest calls; and
 *   - verifying here would add a Firebase round-trip to every request.
 *
 * Guard-verified `req.uid` is preferred when present (user-data routes). Requests
 * with no bearer token are skipped. Recording is a synchronous in-memory bump,
 * so this adds no latency and never fails the request.
 */
@Injectable()
export class ApiUsageInterceptor implements NestInterceptor {
  constructor(private readonly apiUsage: ApiUsageService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    try {
      const req = context.switchToHttp().getRequest<{
        uid?: string;
        headers?: Record<string, unknown>;
      }>();
      const uid = this.uidFrom(req);
      if (uid) this.apiUsage.record(uid);
    } catch {
      // Metering must never break a request.
    }
    return next.handle();
  }

  private uidFrom(req: {
    uid?: string;
    headers?: Record<string, unknown>;
  }): string | null {
    if (typeof req.uid === 'string' && req.uid) return req.uid;

    const header = String(req.headers?.authorization ?? '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return null;

    try {
      const payload = token.split('.')[1];
      if (!payload) return null;
      const json = Buffer.from(payload, 'base64').toString('utf8');
      const data = JSON.parse(json) as { user_id?: string; sub?: string };
      return data.user_id ?? data.sub ?? null;
    } catch {
      return null;
    }
  }
}
