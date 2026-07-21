import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { RetentionService } from './retention.service';

/**
 * GET  /retention/preview  count-only "what would be deleted" per rule (safe)
 * POST /retention/run      run now; deletes only if RETENTION_DRY_RUN=false
 *
 * Behind Cloud Run IAM. `run` is destructive when dry-run is off, so it is a
 * POST and gated by the env flag rather than being callable into deletion by
 * a stray GET.
 */
import { AdminGuard } from '../common/admin.guard';

@Controller('retention')
@UseGuards(AdminGuard)
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Get('preview')
  async preview() {
    return { rules: await this.retention.previewAll() };
  }

  @Post('run')
  async run() {
    return { results: await this.retention.runAll() };
  }
}
