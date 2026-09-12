import {
  Controller,
  Delete,
  Get,
  Logger,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpApiKeyGuard } from "./mcp-api-key.guard";
import { McpServerService } from "./mcp-server.service";

/**
 * The MCP endpoint itself — Streamable HTTP transport (2025-06 spec: POST for
 * JSON-RPC calls, GET for an optional server-initiated SSE stream, DELETE to
 * end a session). Guarded by McpApiKeyGuard, not AdminGuard: a caller here is
 * an MCP client (Claude Code/Desktop) holding a key minted through
 * McpKeysController, not a Firebase-authenticated admin browser session.
 *
 * Stateless: a fresh McpServer + transport is built for every POST, with
 * `sessionIdGenerator: undefined` (see the SDK's own stateless example,
 * `examples/server/simpleStatelessStreamableHttp.js`). This backend runs as
 * multiple Cloud Run instances, so pinning an MCP session to one instance's
 * in-memory state would break the moment a follow-up request landed
 * elsewhere — building tools per-request is cheap and sidesteps that
 * entirely. GET/DELETE (session resumption / explicit session close) have no
 * session to resume or close under this model, so both simply 405.
 */
@UseGuards(McpApiKeyGuard)
@Controller("mcp")
export class McpServerController {
  private readonly logger = new Logger(McpServerController.name);

  constructor(private readonly mcpServer: McpServerService) {}

  @Post()
  async handlePost(@Req() req: Request, @Res() res: Response) {
    const server = this.mcpServer.build();
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (err) {
      this.logger.error(`mcp request failed: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  }

  @Get()
  handleGet(@Res() res: Response) {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "Method not allowed — this server is stateless (no session to resume).",
      },
      id: null,
    });
  }

  @Delete()
  handleDelete(@Res() res: Response) {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "Method not allowed — this server is stateless (no session to close).",
      },
      id: null,
    });
  }
}
