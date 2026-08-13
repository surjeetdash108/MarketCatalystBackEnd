import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get()
  check() {
    return {
      ok: true,
      service: "market-catalyst-backend",
      time: new Date().toISOString(),
    };
  }
}
