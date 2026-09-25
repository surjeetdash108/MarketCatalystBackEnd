import { Injectable } from "@nestjs/common";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  BlogsAdminService,
  composeDocument,
} from "../blogs/blogs-admin.service";
import type { BlogAdminBody } from "../blogs/blogs-admin.service";
import { MediaAdminService } from "../blogs/media-admin.service";
import { SIMPLE_THEME, composeSimpleBody } from "./blog-templates/simple";
import { RICHER_THEME, composeRicherBody } from "./blog-templates/richer";
import { buildStyleGuide } from "./blog-templates/style-guide";
import type { BlogComposeInput, BlogTemplateId } from "./blog-templates/types";

const zoneSchema = z.enum(["edu", "recap", "research", "news"]);
const templateSchema = z.enum(["simple", "richer"]);

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorText(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: `Error: ${(err as Error).message}` },
    ],
    isError: true,
  };
}

/** Recomposes the full self-contained `format: "html"` document for a given template. */
function composeFullDocument(
  template: BlogTemplateId,
  input: BlogComposeInput,
): string {
  const theme = template === "richer" ? RICHER_THEME : SIMPLE_THEME;
  const body =
    template === "richer" ? composeRicherBody(input) : composeSimpleBody(input);
  return composeDocument(body, theme);
}

/**
 * Builds the MCP server exposed at POST/GET /mcp (see McpServerController).
 *
 * Every tool is a thin wrapper over BlogsAdminService/MediaAdminService — the
 * same services BlogsAdminController and the daily recap job already use —
 * so blog creation, slugging, image hoisting and validation all go through
 * the one tested path rather than a second implementation.
 *
 * A fresh McpServer is built per request (see the controller) rather than
 * kept as a long-lived singleton: this backend runs as multiple Cloud Run
 * instances behind a load balancer, so a stateful, session-pinned MCP
 * connection would break the moment a follow-up request landed on a
 * different instance. Building tools is cheap; there's nothing here to gain
 * from reusing one server across requests.
 */
@Injectable()
export class McpServerService {
  constructor(
    private readonly blogs: BlogsAdminService,
    private readonly media: MediaAdminService,
  ) {}

  build(): McpServer {
    const server = new McpServer({
      name: "marketcatalyst-blogs",
      version: "1.0.0",
    });

    server.registerTool(
      "list_blog_posts",
      {
        description:
          "List every blog post (any status — Draft and Published), newest first. Use this to find a post's id before update/delete/publish.",
        inputSchema: {},
      },
      async () => {
        try {
          return text(await this.blogs.list());
        } catch (err) {
          return errorText(err);
        }
      },
    );

    server.registerTool(
      "get_blog_style_guide",
      {
        description:
          "Returns the class vocabulary, CSS variables, structural skeleton and a worked example for composing a blog post body. ALWAYS call this before your first create_blog_post/update_blog_post for a template you haven't used yet — the site's stylesheet only recognizes a fixed set of classes, and inventing others renders as plain unstyled text.",
        inputSchema: { template: templateSchema.optional() },
      },
      ({ template }) => text(buildStyleGuide(template)),
    );

    server.registerTool(
      "create_blog_post",
      {
        description:
          "Creates a new blog post. ALWAYS saves as Draft regardless of any status — call publish_blog_post separately to make it live. Call get_blog_style_guide first for the chosen template's class vocabulary.",
        inputSchema: {
          title: z.string().min(1),
          dek: z
            .string()
            .min(1)
            .describe(
              "Summary/standfirst shown under the title and as the card excerpt.",
            ),
          zone: zoneSchema,
          template: templateSchema
            .optional()
            .describe('Article design — "simple" (default) or "richer".'),
          author: z.string().optional(),
          kick: z
            .string()
            .optional()
            .describe('Short kicker/category label, e.g. "Research desk".'),
          read: z
            .string()
            .optional()
            .describe('Read-time label, e.g. "6 min read".'),
          heroImageUrl: z
            .string()
            .optional()
            .describe(
              "URL of an already-uploaded image (see upload_blog_image), or a data: URI.",
            ),
          bodyHtml: z
            .string()
            .min(1)
            .describe(
              "Inner article content only — see get_blog_style_guide for the allowed classes.",
            ),
        },
      },
      async (args) => {
        try {
          const template: BlogTemplateId = args.template ?? "simple";
          const composed = composeFullDocument(template, args);
          const body: BlogAdminBody = {
            title: args.title,
            dek: args.dek,
            zone: args.zone,
            author: args.author,
            kick: args.kick,
            read: args.read,
            heroImageUrl: args.heroImageUrl,
            format: "html",
            html: composed,
            // Forced regardless of caller intent — see class docblock and the
            // recap job's own rule: nothing MCP-written reaches readers unseen.
            status: "draft",
          };
          const result = await this.blogs.create(body);
          return text({
            ...result,
            status: "Draft",
            note: "Call publish_blog_post to make this live.",
          });
        } catch (err) {
          return errorText(err);
        }
      },
    );

    server.registerTool(
      "update_blog_post",
      {
        description:
          "Updates an existing post's metadata and/or body. Providing bodyHtml recomposes the FULL styled document, so title, dek and template must be given together with it. Never changes publish status — use publish_blog_post for that.",
        inputSchema: {
          id: z.string().min(1),
          title: z.string().optional(),
          dek: z.string().optional(),
          zone: zoneSchema.optional(),
          template: templateSchema.optional(),
          author: z.string().optional(),
          kick: z.string().optional(),
          read: z.string().optional(),
          heroImageUrl: z.string().optional(),
          bodyHtml: z.string().optional(),
        },
      },
      async ({ id, bodyHtml, ...rest }) => {
        try {
          const body: BlogAdminBody = {
            zone: rest.zone,
            author: rest.author,
            kick: rest.kick,
            read: rest.read,
            heroImageUrl: rest.heroImageUrl,
            title: rest.title,
            dek: rest.dek,
          };
          if (bodyHtml !== undefined) {
            if (!rest.title || !rest.dek) {
              throw new Error(
                "bodyHtml was provided without both title and dek — recomposing the document needs the full masthead, not just the body. Include title and dek in this same call.",
              );
            }
            const template: BlogTemplateId = rest.template ?? "simple";
            body.format = "html";
            body.html = composeFullDocument(template, {
              title: rest.title,
              dek: rest.dek,
              author: rest.author,
              kick: rest.kick,
              read: rest.read,
              bodyHtml,
            });
          }
          // status is deliberately never set here — see publish_blog_post.
          const result = await this.blogs.update(id, body);
          return text(result);
        } catch (err) {
          return errorText(err);
        }
      },
    );

    server.registerTool(
      "publish_blog_post",
      {
        description:
          "Makes a Draft post live. The only tool that can set a post's status to Published.",
        inputSchema: { id: z.string().min(1) },
      },
      async ({ id }) => {
        try {
          const result = await this.blogs.update(id, { status: "published" });
          return text({ ...result, status: "Published" });
        } catch (err) {
          return errorText(err);
        }
      },
    );

    server.registerTool(
      "delete_blog_post",
      {
        description:
          "Permanently deletes a blog post and its uploaded images/documents.",
        inputSchema: { id: z.string().min(1) },
      },
      async ({ id }) => {
        try {
          return text(await this.blogs.remove(id));
        } catch (err) {
          return errorText(err);
        }
      },
    );

    server.registerTool(
      "upload_blog_image",
      {
        description:
          "Uploads an image (JPEG/PNG/WebP/GIF) to the shared blog media library and returns its public URL, for use as heroImageUrl or inline in bodyHtml.",
        inputSchema: {
          dataUri: z
            .string()
            .min(1)
            .describe("A data:<mime>;base64,<bytes> URI."),
          filename: z.string().optional(),
        },
      },
      async ({ dataUri, filename }) => {
        try {
          return text(await this.media.upload(dataUri, filename ?? "upload"));
        } catch (err) {
          return errorText(err);
        }
      },
    );

    server.registerTool(
      "list_blog_media",
      {
        description:
          "Lists images already in the shared blog media library, newest first — reuse one instead of re-uploading.",
        inputSchema: {},
      },
      async () => {
        try {
          return text(await this.media.list());
        } catch (err) {
          return errorText(err);
        }
      },
    );

    return server;
  }
}
