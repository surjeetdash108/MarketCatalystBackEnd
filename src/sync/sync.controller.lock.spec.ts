import { SyncController } from "./sync.controller";
import { acquireLock, releaseLock } from "../common/job-lock.util";
import type { SyncRegistry } from "../common/sync-registry.service";
import type { SyncMetaService } from "../common/sync-meta.service";
import type { FirebaseAdminService } from "../common/firebase-admin.provider";

jest.mock("../common/job-lock.util", () => ({
  acquireLock: jest.fn(async () => true),
  releaseLock: jest.fn(async () => undefined),
}));

/**
 * An inline (awaited) run must give its lease back when it ends. It used to
 * keep it for the full 30-minute TTL, so a job scheduled every minute or
 * every 5 minutes (news, earnings-actuals, earnings-article…) was refused
 * with "already-running" until the lease lapsed.
 */
describe("SyncController inline run lock", () => {
  const firestore = {};
  const make = (runner: () => Promise<unknown>) =>
    new SyncController(
      { get: () => runner, names: () => ["x"], list: () => [] } as unknown as SyncRegistry,
      {} as SyncMetaService,
      { firestore } as unknown as FirebaseAdminService,
    );
  const res = { status: jest.fn() } as never;

  beforeEach(() => jest.clearAllMocks());

  it("releases the lock after a successful run", async () => {
    await make(async () => ({ ok: true })).run("x", res);
    expect(acquireLock).toHaveBeenCalledTimes(1);
    const owner = (acquireLock as jest.Mock).mock.calls[0][2].ownerId;
    expect(releaseLock).toHaveBeenCalledWith(firestore, "x", owner);
  });

  it("releases the lock after a failed run", async () => {
    await expect(make(async () => { throw new Error("boom"); }).run("x", res)).rejects.toThrow();
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });
});
