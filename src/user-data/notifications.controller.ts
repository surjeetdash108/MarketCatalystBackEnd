import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { FirebaseAuthGuard } from '../common/firebase-auth.guard';

/**
 * Per-user notification bell — replaces notification-bell.tsx's direct
 * `onSnapshot(collection(firebaseDb, "users/{uid}/notifications"))` listener.
 * Docs are written server-side by NotificationsService.publish() (see
 * src/common/notifications.service.ts, called from src/sync/news.job.ts) with
 * `read: false` at creation — this controller is the first place `read` is
 * ever flipped to `true`. "Mark all read" (not per-item) matches the bell's
 * existing UX: opening the panel marks everything currently visible as seen.
 */
@Controller('api')
@UseGuards(FirebaseAuthGuard)
export class NotificationsController {
  constructor(private readonly firebase: FirebaseAdminService) {}

  private col(uid: string) {
    return this.firebase.firestore.collection(`users/${uid}/notifications`);
  }

  @Get('notifications')
  async list(@CurrentUser() uid: string): Promise<Record<string, unknown>[]> {
    const snap = await this.col(uid).get();
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown>);
    return rows.sort((a, b) =>
      String((b.publishedAt ?? '') as string).localeCompare(String((a.publishedAt ?? '') as string)),
    );
  }

  @Post('notifications/mark-all-read')
  async markAllRead(@CurrentUser() uid: string): Promise<{ ok: true }> {
    const snap = await this.col(uid).where('read', '==', false).get();
    if (!snap.empty) {
      const batch = this.firebase.firestore.batch();
      for (const d of snap.docs) batch.set(d.ref, { read: true }, { merge: true });
      await batch.commit();
    }
    return { ok: true };
  }
}
