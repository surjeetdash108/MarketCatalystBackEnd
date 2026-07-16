import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class BenzingaService implements OnModuleInit {
  private readonly logger = new Logger(BenzingaService.name);
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get('BENZINGA_API_KEY', '');
  }

  onModuleInit(): void {
    if (!this.apiKey) {
      this.logger.warn(
        'BENZINGA_API_KEY not configured — Analyst Actions and News run on FMP/Finnhub interim sources instead. Set BENZINGA_API_KEY in backend/.env to activate.',
      );
    }
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }
}
