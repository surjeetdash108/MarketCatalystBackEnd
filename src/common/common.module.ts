import { Global, Module } from '@nestjs/common';
import { FirebaseAdminService } from './firebase-admin.provider';
import { SyncMetaService } from './sync-meta.service';
import { SyncRegistry } from './sync-registry.service';

@Global()
@Module({
  providers: [FirebaseAdminService, SyncRegistry, SyncMetaService],
  exports: [FirebaseAdminService, SyncRegistry, SyncMetaService],
})
export class CommonModule {}
