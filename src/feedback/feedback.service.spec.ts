import { BadRequestException } from "@nestjs/common";
import { FakeFirestore } from "../../test/support/fake-firestore";
import type { FirebaseAdminService } from "../common/firebase-admin.provider";
import { isPlanExempt } from "../plans/plans.registry";
import { FeedbackService, FEEDBACK_TEXT_MAX } from "./feedback.service";

const svc = () =>
  new FeedbackService({
    firestore: new FakeFirestore(),
  } as unknown as FirebaseAdminService);

describe("user feedback", () => {
  it("stores the text with the signed-in uid and email; lists newest first for the admin", async () => {
    const s = svc();
    await s.submit(
      { uid: "u1", email: "a@example.com" },
      { text: "  Love the heatmap  " },
      new Date("2026-11-19T15:00:00Z"),
    );
    await s.submit(
      { uid: "u2", email: null },
      { text: "Faster charts please" },
      new Date("2026-11-19T16:30:00Z"),
    );
    const list = await s.list();
    expect(list.map((f) => [f.email, f.text, f.createdAt])).toEqual([
      [null, "Faster charts please", "2026-11-19T16:30:00.000Z"],
      ["a@example.com", "Love the heatmap", "2026-11-19T15:00:00.000Z"],
    ]);
    expect(list[0].uid).toBe("u2");
  });
  it("rejects an empty or over-long message", async () => {
    const s = svc();
    await expect(
      s.submit({ uid: "u", email: null }, { text: "   " }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      s.submit(
        { uid: "u", email: null },
        { text: "x".repeat(FEEDBACK_TEXT_MAX + 1) },
      ),
    ).rejects.toThrow(BadRequestException);
  });
  it("any signed-in account can send feedback (no plan needed)", () => {
    expect(isPlanExempt("/api/feedback")).toBe(true);
  });
});
