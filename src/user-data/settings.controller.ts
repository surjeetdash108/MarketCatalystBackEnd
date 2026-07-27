import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { FirebaseAuthGuard } from '../common/firebase-auth.guard';

interface SettingsPatch {
  alert?: boolean;
  font?: string;
  darkMode?: boolean;
}

/**
 * Per-user app settings (theme, font, alert toggle) — replaces the four
 * separate `setDoc(doc(firebaseDb, "settings", uid), ..., { merge: true })`
 * call sites in settings.tsx and shell.tsx's topbar theme button, plus
 * shell.tsx's one-time `getDoc` on mount. Every read/write is scoped to the
 * verified `uid` from FirebaseAuthGuard.
 */
@Controller('api')
@UseGuards(FirebaseAuthGuard)
export class SettingsController {
  constructor(private readonly firebase: FirebaseAdminService) {}

  private ref(uid: string) {
    return this.firebase.firestore.doc(`settings/${uid}`);
  }

  @Get('settings')
  async get(@CurrentUser() uid: string): Promise<SettingsPatch> {
    const data = (await this.ref(uid).get()).data() ?? {};
    return {
      alert: typeof data.alert === 'boolean' ? data.alert : undefined,
      font: typeof data.font === 'string' ? data.font : undefined,
      darkMode: typeof data.darkMode === 'boolean' ? data.darkMode : undefined,
    };
  }

  @Patch('settings')
  async update(@CurrentUser() uid: string, @Body() body: SettingsPatch): Promise<SettingsPatch> {
    const patch: Record<string, unknown> = {};
    if (typeof body.alert === 'boolean') patch.alert = body.alert;
    if (typeof body.font === 'string') patch.font = body.font;
    if (typeof body.darkMode === 'boolean') patch.darkMode = body.darkMode;
    if (Object.keys(patch).length > 0) await this.ref(uid).set(patch, { merge: true });
    return this.get(uid);
  }
}
