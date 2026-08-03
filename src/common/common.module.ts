import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AdminGuard } from './admin.guard';
import { ApiUsageInterceptor } from './api-usage.interceptor';
import { ApiUsageService } from './api-usage.service';
import { FirebaseAuthGuard } from './firebase-auth.guard';
import { FirebaseAdminService } from './firebase-admin.provider';
import { NotificationsService } from './notifications.service';
import { SyncMetaService } from './sync-meta.service';
import { SyncRegistry } from './sync-registry.service';

@Global()
@Module({
  providers: [
    AdminGuard,
    FirebaseAuthGuard,
    FirebaseAdminService,
    SyncRegistry,
    SyncMetaService,
    NotificationsService,
    ApiUsageService,
    // Global metering: every authenticated request bumps a per-user counter
    // (in-memory, batched flush) that the admin console's apiCalls column reads.
    { provide: APP_INTERCEPTOR, useClass: ApiUsageInterceptor },
  ],
  exports: [
    AdminGuard,
    FirebaseAuthGuard,
    FirebaseAdminService,
    SyncRegistry,
    SyncMetaService,
    NotificationsService,
    ApiUsageService,
  ],
})
export class CommonModule {}
