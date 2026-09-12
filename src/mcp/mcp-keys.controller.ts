import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { AdminGuard } from "../common/admin.guard";
import { McpKeysService } from "./mcp-keys.service";

/**
 * Admin-only CRUD for MCP server API keys. Same guard as every other admin
 * surface (BlogsAdminController, ApiHealthController) — only the fixed admin
 * account can mint or revoke a key. The keys themselves authorize a
 * DIFFERENT surface (McpServerController, behind McpApiKeyGuard), so minting
 * one is an admin action but using one is not.
 */
@UseGuards(AdminGuard)
@Controller("api/admin/mcp-keys")
export class McpKeysController {
  constructor(private readonly keys: McpKeysService) {}

  @Get()
  async list() {
    return { keys: await this.keys.list() };
  }

  @Post()
  async create(@Body() body: { label?: string }) {
    return this.keys.create(String(body?.label ?? ""));
  }

  @Post(":id/revoke")
  async revoke(@Param("id") id: string) {
    return this.keys.revoke(id);
  }
}
