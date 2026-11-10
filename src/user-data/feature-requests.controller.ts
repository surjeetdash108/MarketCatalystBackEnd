import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Timestamp } from "firebase-admin/firestore";
import { CurrentUser } from "../common/current-user.decorator";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";

const MAX_LEN = 2000;

interface FeatureRequest {
  id: string;
  uid: string;
  text: string;
  createdAt: string;
}

/**
 * Create-only feature-request box: a user can submit a request and see their
 * own submissions, never anyone else's, and never edit/delete one once sent
 * — same "verified uid, never client-supplied" scoping as StockNotesController.
 */
@Controller("api")
@UseGuards(FirebaseAuthGuard)
export class FeatureRequestsController {
  constructor(private readonly firebase: FirebaseAdminService) {}

  @Get("feature-requests")
  async list(@CurrentUser() uid: string): Promise<FeatureRequest[]> {
    const snap = await this.firebase.firestore
      .collection("feature_requests")
      .where("uid", "==", uid)
      .orderBy("createdAt", "desc")
      .get();

    return snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        uid: data.uid as string,
        text: data.text as string,
        createdAt: (data.createdAt as Timestamp).toDate().toISOString(),
      };
    });
  }

  @Post("feature-requests")
  async create(
    @CurrentUser() uid: string,
    @Body() body: { text?: string },
  ): Promise<FeatureRequest> {
    const text = (body.text ?? "").trim();
    if (!text) throw new BadRequestException("text is required");
    if (text.length > MAX_LEN)
      throw new BadRequestException(
        `text must be ${MAX_LEN} characters or fewer`,
      );

    const now = Timestamp.now();
    const ref = await this.firebase.firestore
      .collection("feature_requests")
      .add({
        uid,
        text,
        createdAt: now,
      });
    return { id: ref.id, uid, text, createdAt: now.toDate().toISOString() };
  }
}
