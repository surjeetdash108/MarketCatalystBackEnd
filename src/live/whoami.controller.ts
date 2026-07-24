import { Controller, Get, Header, Req } from '@nestjs/common';
import type { Request } from 'express';

/**
 * GET /live/whoami  →  { ip }
 *
 * First-party IP echo for the client-side login/presence tracker
 * (UI app/iq/presence.ts). A browser cannot read its own public IP, and we do
 * NOT want to send users to a third-party IP service — so the client asks its
 * own backend, which reads the real address the proxy already saw.
 *
 * Behind Cloud Run the real client IP is the FIRST entry of X-Forwarded-For
 * (Cloud Run appends the caller, then the LB); fall back to the socket address.
 */
@Controller('live')
export class WhoamiController {
  @Get('whoami')
  @Header('Cache-Control', 'no-store')
  whoami(@Req() req: Request): { ip: string | null } {
    const xff = req.headers['x-forwarded-for'];
    const fromXff = Array.isArray(xff)
      ? xff[0]
      : (xff ?? '').split(',')[0].trim();
    const ip = fromXff || req.ip || req.socket?.remoteAddress || '';
    return { ip: ip || null };
  }
}
