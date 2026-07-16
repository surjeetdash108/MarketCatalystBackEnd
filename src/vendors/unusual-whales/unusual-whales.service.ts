import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class UnusualWhalesService implements OnModuleInit {
  private readonly logger = new Logger(UnusualWhalesService.name);
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get('UNUSUAL_WHALES_API_KEY', '');
  }

  onModuleInit(): void {
    if (!this.apiKey) {
      this.logger.warn(
        'UNUSUAL_WHALES_API_KEY not configured — options flow/dark pool prints unavailable (Phase 2, not MVP-critical). Set UNUSUAL_WHALES_API_KEY in backend/.env to activate.',
      );
    }
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }
}
