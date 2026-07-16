import { Injectable } from '@nestjs/common';

export type SyncRunner = () => Promise<unknown>;

export interface JobMeta {
  collections: string[];
  cronExpression: string;
  timeZone: string;
}

interface RegisteredJob {
  runner: SyncRunner;
  isRunning: boolean;
  runningSince: string | null;
  meta: JobMeta;
}

@Injectable()
export class SyncRegistry {
  private readonly jobs = new Map<string, RegisteredJob>();

  register(name: string, runner: SyncRunner, meta: JobMeta): void {
    this.jobs.set(name, { runner, isRunning: false, runningSince: null, meta });
  }

  get(name: string): SyncRunner | undefined {
    const job = this.jobs.get(name);
    if (!job) return undefined;
    return async () => {
      job.isRunning = true;
      job.runningSince = new Date().toISOString();
      try {
        return await job.runner();
      } finally {
        job.isRunning = false;
        job.runningSince = null;
      }
    };
  }

  getMeta(name: string): JobMeta | undefined {
    return this.jobs.get(name)?.meta;
  }

  names(): string[] {
    return [...this.jobs.keys()];
  }

  list(): Array<{
    name: string;
    isRunning: boolean;
    runningSince: string | null;
    collections: string[];
    cronExpression: string;
    timeZone: string;
  }> {
    return [...this.jobs.entries()].map(([name, job]) => ({
      name,
      isRunning: job.isRunning,
      runningSince: job.runningSince,
      collections: job.meta.collections,
      cronExpression: job.meta.cronExpression,
      timeZone: job.meta.timeZone,
    }));
  }
}
