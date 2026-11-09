import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { StreamTicketGuard } from "./stream-ticket.guard";
import { StreamTicketService } from "./stream-ticket.service";
import { UserSessionService } from "./user-session.service";

const SECRET = "x".repeat(40);
const svc = (secret: string | undefined = SECRET) =>
  new StreamTicketService({
    get: (k: string, d?: unknown) =>
      k === "STREAM_TICKET_SECRET" ? (secret ?? d) : d,
  } as unknown as ConfigService);

describe("StreamTicketService", () => {
  const now = 1_800_000_000_000;

  it("round-trips uid and session", () => {
    const { ticket, expiresAt } = svc().issue("u1", "s1", now);
    expect(svc().verify(ticket, now + 1000)).toEqual({
      uid: "u1",
      sid: "s1",
      exp: now + StreamTicketService.TTL_MS,
    });
    expect(Date.parse(expiresAt)).toBe(now + StreamTicketService.TTL_MS);
  });

  it("rejects an expired ticket", () => {
    const { ticket } = svc().issue("u1", "s1", now);
    expect(svc().verify(ticket, now + StreamTicketService.TTL_MS)).toBeNull();
  });

  it("rejects a ticket whose payload was edited", () => {
    const { ticket } = svc().issue("u1", "s1", now);
    const [, sig] = ticket.split(".");
    const forged = Buffer.from(
      JSON.stringify({ uid: "admin", exp: now + 9e9 }),
    ).toString("base64url");
    expect(svc().verify(`${forged}.${sig}`, now)).toBeNull();
  });

  it("rejects a ticket signed with a different secret", () => {
    const { ticket } = svc("y".repeat(40)).issue("u1", undefined, now);
    expect(svc().verify(ticket, now)).toBeNull();
  });

  it.each([undefined, null, 42, "", "a.b.c", "nodot", "x".repeat(5000)])(
    "rejects malformed input %p",
    (t) => {
      expect(svc().verify(t, now)).toBeNull();
    },
  );

  it("is fail-closed without a secret (or one shorter than 32 chars)", () => {
    expect(() => svc("").issue("u1", undefined, now)).toThrow();
    expect(() => svc("short").issue("u1", undefined, now)).toThrow();
    const { ticket } = svc().issue("u1", undefined, now);
    expect(svc("").verify(ticket, now)).toBeNull();
  });
});

describe("StreamTicketGuard", () => {
  const ctx = (query: Record<string, unknown>) => {
    const req: { query: Record<string, unknown>; uid?: string } = { query };
    return {
      req,
      ctx: {
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext,
    };
  };

  it("admits a valid ticket, checks its session and sets req.uid", async () => {
    const assertCurrent = jest.fn().mockResolvedValue(undefined);
    const guard = new StreamTicketGuard(svc(), {
      assertCurrent,
    } as unknown as UserSessionService);
    const { ticket } = svc().issue("u1", "s1");
    const { req, ctx: c } = ctx({ ticket });
    await expect(guard.canActivate(c)).resolves.toBe(true);
    expect(req.uid).toBe("u1");
    expect(assertCurrent).toHaveBeenCalledWith("u1", "s1");
  });

  it("refuses a missing or bad ticket with 401", async () => {
    const guard = new StreamTicketGuard(svc(), {
      assertCurrent: jest.fn(),
    } as unknown as UserSessionService);
    await expect(guard.canActivate(ctx({}).ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      guard.canActivate(ctx({ ticket: "abc.def" }).ctx),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("refuses a ticket whose session was superseded", async () => {
    const guard = new StreamTicketGuard(svc(), {
      assertCurrent: jest
        .fn()
        .mockRejectedValue(new UnauthorizedException("superseded")),
    } as unknown as UserSessionService);
    const { ticket } = svc().issue("u1", "old-session");
    await expect(guard.canActivate(ctx({ ticket }).ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
