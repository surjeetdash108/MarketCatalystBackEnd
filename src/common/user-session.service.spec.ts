import { UnauthorizedException } from "@nestjs/common";
import { FirebaseAdminService } from "./firebase-admin.provider";
import { UserSessionService } from "./user-session.service";

function makeService(stored: Record<string, string>, opts: { failReads?: boolean } = {}) {
  const get = jest.fn(async () => {
    if (opts.failReads) throw new Error("firestore down");
    return { exists: "uid1" in stored, get: () => stored["uid1"] };
  });
  const set = jest.fn(async (data: { sessionId: string }) => {
    stored["uid1"] = data.sessionId;
  });
  const firebase = {
    firestore: { collection: () => ({ doc: () => ({ get, set }) }) },
  } as unknown as FirebaseAdminService;
  return { service: new UserSessionService(firebase), get };
}

describe("UserSessionService", () => {
  it("lets a user with no stored session through", async () => {
    const { service } = makeService({});
    await expect(service.assertCurrent("uid1", undefined)).resolves.toBeUndefined();
  });

  it("accepts the current session and rejects a superseded or missing one", async () => {
    const { service } = makeService({ uid1: "session-current-000" });
    await expect(service.assertCurrent("uid1", "session-current-000")).resolves.toBeUndefined();
    await expect(service.assertCurrent("uid1", "session-old-0000000")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.assertCurrent("uid1", undefined)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("supersedes the previous session when a new one is claimed", async () => {
    const { service } = makeService({ uid1: "session-first-0000" });
    await service.assertCurrent("uid1", "session-first-0000");

    await service.claim("uid1", "session-second-000");

    await expect(service.assertCurrent("uid1", "session-second-000")).resolves.toBeUndefined();
    await expect(service.assertCurrent("uid1", "session-first-0000")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("serves repeat checks from cache rather than re-reading Firestore", async () => {
    const { service, get } = makeService({ uid1: "session-current-000" });
    await service.assertCurrent("uid1", "session-current-000");
    await service.assertCurrent("uid1", "session-current-000");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("fails open when the session store is unreachable", async () => {
    const { service } = makeService({ uid1: "session-current-000" }, { failReads: true });
    await expect(service.assertCurrent("uid1", "anything-at-all-000")).resolves.toBeUndefined();
  });
});
