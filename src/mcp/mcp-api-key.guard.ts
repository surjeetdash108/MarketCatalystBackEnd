import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { McpKeysService } from "./mcp-keys.service";

/**
 * Authorizes the MCP server endpoint (McpServerController), completely
 * separate from AdminGuard: an MCP client presents one of the keys minted
 * through McpKeysController, not a Firebase admin ID token. Anyone holding a
 * live key can call every blog tool — there is no per-key scoping — so
 * minting one is equivalent to handing out console-admin's own blog access,
 * which is why only AdminGuard-protected endpoints can create or revoke one.
 */
@Injectable()
export class McpApiKeyGuard implements CanActivate {
  constructor(private readonly keys: McpKeysService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header: string = req.headers?.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) {
      throw new UnauthorizedException(
        "Missing Authorization: Bearer <mcp key>",
      );
    }
    const match = await this.keys.verify(token);
    if (!match) {
      throw new UnauthorizedException("Invalid or revoked MCP key.");
    }
    return true;
  }
}
