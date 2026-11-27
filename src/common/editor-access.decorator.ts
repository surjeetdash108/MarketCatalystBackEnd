import { SetMetadata } from "@nestjs/common";

export const EDITOR_ACCESS = "admin:editorAccess";

/**
 * Opens an AdminGuard route (or a whole controller) to the content editors
 * listed in ADMIN_EDITOR_EMAILS, not only the admin. Editors run the console's
 * Blogs and Content pipeline sections and nothing else, so this goes ONLY on
 * the routes those two sections call: blog posts and media, Pulse posts, Stock
 * in Focus, the content pipeline and the ticker picker they use. Every other admin route
 * refuses an editor (403). route-guards.spec.ts holds the exact list.
 */
export const AllowEditor = () => SetMetadata(EDITOR_ACCESS, true);
