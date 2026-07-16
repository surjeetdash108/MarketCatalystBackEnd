import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    return {
      ok: true,
      service: 'finapp26-backend',
      time: new Date().toISOString(),
    };
  }
}
