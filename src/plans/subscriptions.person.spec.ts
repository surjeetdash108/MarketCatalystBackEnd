import { FakeFirestore } from "../../test/support/fake-firestore";
import { SubscriptionsService } from "./subscriptions.service";
import { emailHash } from "../billing/retention/email-normalise";

function make(users: Record<string, { email: string; created: string }>) {
  const fs = new FakeFirestore();
  const auth = {
    getUser: (uid: string) =>
      users[uid]
        ? Promise.resolve({
            uid,
            email: users[uid].email,
            metadata: { creationTime: users[uid].created },
          })
        : Promise.reject(new Error("auth/user-not-found")),
  };
  const svc = new SubscriptionsService(
    { firestore: fs, auth } as never,
    {} as never,
    {
      now: () => Date.parse("2026-11-21T00:00:00Z"),
      nowIso: () => "2026-11-21T00:00:00.000Z",
    } as never,
  );
  return { fs, svc };
}

describe("SubscriptionsService.personOf: the person behind an account", () => {
  it("the first account ever made with an email is the first; it records the sign-up claim", async () => {
    const { fs, svc } = make({
      a1: { email: "Ana@Example.com", created: "2026-11-18T19:30:00Z" },
    });
    const p = await svc.personOf("a1");
    expect(p).toEqual({
      emailKey: emailHash("ana@example.com"),
      firstUid: "a1",
      isFirst: true,
    });
    expect(
      (
        await fs
          .collection("signup_claims")
          .doc(p?.emailKey ?? "")
          .get()
      ).data(),
    ).toMatchObject({ firstUid: "a1" });
  });

  it("a deleted-and-recreated account with the same email is not the first", async () => {
    const { fs, svc } = make({
      a2: { email: "ana@example.com", created: "2026-11-20T22:25:00Z" },
    });
    await fs
      .collection("signup_claims")
      .doc(emailHash("ana@example.com"))
      .set({ firstCreatedAt: "2026-11-18T19:30:00.000Z", firstUid: "a1" });
    await expect(svc.personOf("a2")).resolves.toEqual({
      emailKey: emailHash("ana@example.com"),
      firstUid: "a1",
      isFirst: false,
    });
  });

  it("no email → null", async () => {
    const { svc } = make({});
    await expect(svc.personOf("ghost")).resolves.toBeNull();
  });
});
