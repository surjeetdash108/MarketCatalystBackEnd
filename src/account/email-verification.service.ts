import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import { createHash, randomInt, timingSafeEqual } from "crypto";
import { AppClock } from "../common/app-clock";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { EmailService } from "../billing/email/email.service";

/**
 * 6-digit email verification for email/password accounts (Google accounts
 * arrive verified). Only a salted hash of the code is stored, in
 * email_verifications/{uid} (backend-only; Firestore rules deny clients).
 * On a correct code the Firebase Auth record is marked emailVerified.
 */
export const CODE_TTL_MS = 10 * 60_000;
export const RESEND_COOLDOWN_MS = 60_000;
export const MAX_SENDS_PER_HOUR = 5;
export const MAX_SENDS_PER_IP_PER_HOUR = 20;
export const MAX_ATTEMPTS = 5;
const HOUR = 3_600_000;

interface CodeDoc {
  codeHash: string;
  expiresAt: number;
  attempts: number;
  sends: number[];
}

const hash = (uid: string, code: string) =>
  createHash("sha256").update(`${uid}:${code}`).digest("hex");

function tooMany(
  code: string,
  message: string,
  retryAfterSeconds?: number,
): never {
  throw new HttpException(
    {
      statusCode: 429,
      code,
      message,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

@Injectable()
export class EmailVerificationService {
  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly emails: EmailService,
    private readonly clock: AppClock,
  ) {}

  private get db() {
    return this.firebase.firestore;
  }

  /** Source of truth is the Auth record, so a just-verified user passes before a token refresh. */
  async isVerified(uid: string): Promise<boolean> {
    const u = await this.firebase.auth.getUser(uid);
    return u.emailVerified === true;
  }

  async status(uid: string) {
    const u = await this.firebase.auth.getUser(uid);
    return { email: u.email ?? null, verified: u.emailVerified === true };
  }

  async send(uid: string, ip: string | null) {
    const u = await this.firebase.auth.getUser(uid);
    if (!u.email)
      throw new BadRequestException({
        statusCode: 400,
        code: "no_email",
        message: "This account has no email address.",
      });
    if (u.emailVerified) return { alreadyVerified: true };
    const now = this.clock.now();
    const ref = this.db.collection("email_verifications").doc(uid);
    const prev = (await ref.get()).data() as CodeDoc | undefined;
    const sends = (prev?.sends ?? []).filter((t) => now - t < HOUR);
    const last = sends[sends.length - 1];
    if (last && now - last < RESEND_COOLDOWN_MS) {
      tooMany(
        "resend_cooldown",
        "Please wait before asking for another code.",
        Math.ceil((RESEND_COOLDOWN_MS - (now - last)) / 1000),
      );
    }
    if (sends.length >= MAX_SENDS_PER_HOUR)
      tooMany(
        "too_many_codes",
        "Too many codes requested. Try again in an hour.",
      );
    if (ip) {
      const ipRef = this.db
        .collection("email_verification_ips")
        .doc(createHash("sha256").update(ip).digest("hex"));
      const ipSends = (
        ((await ipRef.get()).data()?.sends as number[] | undefined) ?? []
      ).filter((t) => now - t < HOUR);
      if (ipSends.length >= MAX_SENDS_PER_IP_PER_HOUR)
        tooMany(
          "too_many_codes",
          "Too many codes requested. Try again in an hour.",
        );
      await ipRef.set({ sends: [...ipSends, now] });
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await ref.set({
      codeHash: hash(uid, code),
      expiresAt: now + CODE_TTL_MS,
      attempts: 0,
      sends: [...sends, now],
    } satisfies CodeDoc);
    await this.emails.verificationCode(u.email, code, CODE_TTL_MS / 60_000);
    return {
      sent: true,
      expiresInSeconds: CODE_TTL_MS / 1000,
      resendInSeconds: RESEND_COOLDOWN_MS / 1000,
    };
  }

  async verify(uid: string, code: string) {
    const u = await this.firebase.auth.getUser(uid);
    if (u.emailVerified) return { verified: true };
    const ref = this.db.collection("email_verifications").doc(uid);
    const d = (await ref.get()).data() as CodeDoc | undefined;
    const bad = (c: string, message: string): never => {
      throw new BadRequestException({ statusCode: 400, code: c, message });
    };
    if (!d?.codeHash) bad("no_code", "Ask for a code first.");
    if (d.expiresAt <= this.clock.now())
      bad("code_expired", "That code has expired. Ask for a new one.");
    if (d.attempts >= MAX_ATTEMPTS)
      tooMany("too_many_attempts", "Too many wrong codes. Ask for a new one.");
    const ok =
      /^\d{6}$/.test(code) &&
      timingSafeEqual(Buffer.from(hash(uid, code)), Buffer.from(d.codeHash));
    if (!ok) {
      await ref.set({ ...d, attempts: d.attempts + 1 });
      bad("code_invalid", "That code isn't right.");
    }
    await this.firebase.auth.updateUser(uid, { emailVerified: true });
    await ref.set({ ...d, codeHash: "", expiresAt: 0, attempts: 0 });
    return { verified: true };
  }
}
