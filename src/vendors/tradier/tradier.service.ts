import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TradierService implements OnModuleInit {
  private readonly logger = new Logger(TradierService.name);
  private readonly accessToken: string;

  constructor(private readonly config: ConfigService) {
    this.accessToken = this.config.get('TRADIER_ACCESS_TOKEN', '');
  }

  onModuleInit(): void {
    if (!this.accessToken) {
      this.logger.warn(
        'TRADIER_ACCESS_TOKEN not configured — Options Chain has no data source yet. Set TRADIER_ACCESS_TOKEN in backend/.env to activate.',
      );
    }
  }

  isConfigured(): boolean {
    return Boolean(this.accessToken);
  }
}
