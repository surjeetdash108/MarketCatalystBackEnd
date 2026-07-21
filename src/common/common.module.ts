import { Global, Module } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { FirebaseAdminService } from './firebase-admin.provider';
import { NotificationsService } from './notifications.service';
import { SyncMetaService } from './sync-meta.service';
import { SyncRegistry } from './sync-registry.service';

@Global()
@Module({
  providers: [AdminGuard, FirebaseAdminService, SyncRegistry, SyncMetaService, NotificationsService],
  exports: [AdminGuard, FirebaseAdminService, SyncRegistry, SyncMetaService, NotificationsService],
})
export class CommonModule {}
