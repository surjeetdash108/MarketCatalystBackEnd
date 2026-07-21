import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AutoPurgeJob } from './auto-purge.job';

/**
 * Imports CommonModule for the shared SyncRegistry singleton — that is what
 * makes auto-purge show up in the backend monitor's job list and be runnable
 * via POST /sync/auto-purge/run, exactly like the sync jobs.
 */
@Module({
  imports: [CommonModule],
  providers: [AutoPurgeJob],
})
export class AutoPurgeModule {}
