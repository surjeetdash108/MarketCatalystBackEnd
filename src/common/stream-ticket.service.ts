import { createHmac, timingSafeEqual } from "crypto";
import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * Short-lived signed tickets that let a browser EventSource authenticate.
 *
 * EventSource cannot send an Authorization header, so the SSE routes used to
 * be open. A signed-in client now POSTs /api/stream-ticket (normal Firebase
 * auth + session check) and opens the stream with `?ticket=`. The ticket names
 * the uid and session, expires after TTL_MS, and is an HMAC over those fields —
 * never the Firebase ID token itself, which would land in request logs with an
 * hour of validity for every API.
 *
 * STREAM_TICKET_SECRET (≥ 32 chars, Secret Manager) must be identical on every
 * instance of the live service. Unset → tickets are not issued and every
 * ticket is rejected (fail-closed); clients fall back to their REST polls.
 */
export interface StreamTicketClaims {
  uid: string;
  sid?: string;
  exp: number;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

@Injectable()
export class StreamTicketService {
  static readonly TTL_MS = 10 * 60_000;

  constructor(private readonly config: ConfigService) {}

  private key(): Buffer | null {
    const s = String(this.config.get("STREAM_TICKET_SECRET", "") ?? "").trim();
    return s.length >= 32 ? Buffer.from(s, "utf8") : null;
  }

  private sign(key: Buffer, payload: string): string {
    return b64url(createHmac("sha256", key).update(payload).digest());
  }

  issue(
    uid: string,
    sid: string | undefined,
    now = Date.now(),
  ): { ticket: string; expiresAt: string } {
    const key = this.key();
    if (!key) {
      throw new ServiceUnavailableException("Live streams are not configured.");
    }
    const claims: StreamTicketClaims = {
      uid,
      ...(sid ? { sid } : {}),
      exp: now + StreamTicketService.TTL_MS,
    };
    const payload = b64url(JSON.stringify(claims));
    return {
      ticket: `${payload}.${this.sign(key, payload)}`,
      expiresAt: new Date(claims.exp).toISOString(),
    };
  }

  /** The claims of a valid, unexpired ticket; null for anything else. */
  verify(ticket: unknown, now = Date.now()): StreamTicketClaims | null {
    const key = this.key();
    if (!key || typeof ticket !== "string" || ticket.length > 2048) return null;
    const [payload, sig, extra] = ticket.split(".");
    if (!payload || !sig || extra !== undefined) return null;
    const expected = Buffer.from(this.sign(key, payload));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return null;
    }
    let claims: StreamTicketClaims;
    try {
      claims = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as StreamTicketClaims;
    } catch {
      return null;
    }
    if (typeof claims?.uid !== "string" || !claims.uid) return null;
    if (typeof claims.exp !== "number" || claims.exp <= now) return null;
    return claims;
  }
}
