import { Body, Controller, Get, Post } from '@nestjs/common';
import { PurgeService } from './purge.service';
import type { PurgeCriteria } from './purge.service';

interface ExecuteBody extends PurgeCriteria {
  previewToken?: string;
}

@Controller('purge')
export class PurgeController {
  constructor(private readonly purge: PurgeService) {}

  /** Collections that may be purged, and whether each supports a date range. */
  @Get('targets')
  targets() {
    return { targets: this.purge.listTargets() };
  }

  /**
   * Counts what would be deleted and issues a single-use token. Read-only —
   * nothing is modified here.
   */
  @Post('preview')
  preview(@Body() body: PurgeCriteria) {
    return this.purge.preview(body);
  }

  /**
   * Deletes. Requires a previewToken from an identical /preview call, so a
   * purge cannot happen without the document count having been produced first.
   */
  @Post('execute')
  execute(@Body() body: ExecuteBody) {
    const { previewToken, ...criteria } = body;
    return this.purge.execute(criteria, previewToken);
  }
}
