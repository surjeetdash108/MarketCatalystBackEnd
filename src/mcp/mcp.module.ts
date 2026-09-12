import { Module } from "@nestjs/common";
import { BlogsModule } from "../blogs/blogs.module";
import { McpKeysController } from "./mcp-keys.controller";
import { McpKeysService } from "./mcp-keys.service";
import { McpApiKeyGuard } from "./mcp-api-key.guard";
import { McpServerController } from "./mcp-server.controller";
import { McpServerService } from "./mcp-server.service";

/**
 * The MCP blog-authoring server plus the admin-managed API keys that
 * authorize it. Imports BlogsModule to reuse BlogsAdminService/
 * MediaAdminService directly (same reuse the daily recap job already
 * relies on) rather than re-implementing blog CRUD.
 */
@Module({
  imports: [BlogsModule],
  controllers: [McpKeysController, McpServerController],
  providers: [McpKeysService, McpApiKeyGuard, McpServerService],
})
export class McpModule {}
