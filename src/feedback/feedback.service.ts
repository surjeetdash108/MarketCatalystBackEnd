import { BadRequestException, Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { FirebaseAdminService } from "../common/firebase-admin.provider";

/**
 * Feedback from the in-app "Enjoying our platform?" box. One Firestore
 * collection, `user_feedback`, written only through this service; the uid and
 * email come from the sign-in token, never from the request body. The admin
 * console lists it (/admin/feedback).
 */
export const FEEDBACK_COLLECTION = "user_feedback";
export const FEEDBACK_TEXT_MAX = 2000;
export const FEEDBACK_LIST_LIMIT = 500;

export interface Feedback {
  id: string;
  uid: string;
  email: string | null;
  text: string;
  createdAt: string;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v ? v : null;

@Injectable()
export class FeedbackService {
  constructor(private readonly firebase: FirebaseAdminService) {}

  private get col() {
    return this.firebase.firestore.collection(FEEDBACK_COLLECTION);
  }

  async submit(
    who: { uid: string; email: string | null },
    body: { text?: unknown },
    now = new Date(),
  ): Promise<{ ok: true }> {
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) throw new BadRequestException("Write something to send.");
    if (text.length > FEEDBACK_TEXT_MAX)
      throw new BadRequestException(
        `Feedback is limited to ${FEEDBACK_TEXT_MAX} characters.`,
      );
    await this.col.doc(randomUUID()).set({
      uid: who.uid,
      email: who.email ?? null,
      text,
      createdAt: now.toISOString(),
    });
    return { ok: true };
  }

  /** Newest first. */
  async list(limit = FEEDBACK_LIST_LIMIT): Promise<Feedback[]> {
    const snap = await this.col.orderBy("createdAt", "desc").limit(limit).get();
    return snap.docs.map((d) => {
      const x = d.data();
      return {
        id: d.id,
        uid: str(x.uid) ?? "",
        email: str(x.email),
        text: str(x.text) ?? "",
        createdAt: str(x.createdAt) ?? "",
      };
    });
  }
}
