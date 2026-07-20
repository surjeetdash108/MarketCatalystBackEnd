import { Global, Module } from '@nestjs/common';
import { FirebaseAdminService } from './firebase-admin.provider';
import { NotificationsService } from './notifications.service';
import { SyncMetaService } from './sync-meta.service';
import { SyncRegistry } from './sync-registry.service';

@Global()
@Module({
  providers: [FirebaseAdminService, SyncRegistry, SyncMetaService, NotificationsService],
  exports: [FirebaseAdminService, SyncRegistry, SyncMetaService, NotificationsService],
})
export class CommonModule {}
