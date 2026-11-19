import { readFileSync } from "fs";
import { join } from "path";

/**
 * The branded HTML emails (designs: EmailTemplatesMarketCatalyst, light mode).
 * Each template in ./templates holds placeholders:
 *   {{name}}    → the value, HTML-escaped
 *   {{{name}}}  → the value as HTML (only for markup this code builds)
 *   <!--IF:name-->…<!--/IF:name-->  → kept only when `name` is truthy
 * A placeholder left without a value is an error, so a missing field can never
 * ship as literal braces.
 */
export type TemplateName =
  | "verify-email"
  | "welcome"
  | "trial-started"
  | "getting-started"
  | "first-activation"
  | "trial-ending"
  | "trial-ended"
  | "pro-confirmed"
  | "elite-confirmed"
  | "pro-renewal-reminder"
  | "elite-renewal-reminder"
  | "password-reset"
  | "login-alert"
  | "account-deleted"
  | "notice";

export type TemplateVars = Record<
  string,
  string | number | boolean | null | undefined
>;

const cache = new Map<TemplateName, string>();

function load(name: TemplateName): string {
  let t = cache.get(name);
  if (t == null) {
    t = readFileSync(join(__dirname, "templates", `${name}.html`), "utf8");
    cache.set(name, t);
  }
  return t;
}

export function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderTemplate(name: TemplateName, vars: TemplateVars): string {
  let html = load(name).replace(
    /<!--IF:([A-Za-z]+)-->([\s\S]*?)<!--\/IF:\1-->/g,
    (_m, key: string, inner: string) => (vars[key] ? inner : ""),
  );
  html = html.replace(/\{\{\{([A-Za-z]+)\}\}\}/g, (_m, key: string) => {
    if (!(key in vars))
      throw new Error(`email template ${name}: no value for {{{${key}}}}`);
    return String(vars[key] ?? "");
  });
  html = html.replace(/\{\{([A-Za-z]+)\}\}/g, (_m, key: string) => {
    if (!(key in vars))
      throw new Error(`email template ${name}: no value for {{${key}}}`);
    return escapeHtml(vars[key]);
  });
  return html;
}

/** One card row (✓ + text) in the generic notice layout; `html` is trusted markup. */
export function noticeRow(html: string, last = false): string {
  const pad = last ? "0 0 0" : "0 0 8px";
  return `<tr><td width="24" valign="top" style="width:24px;padding:${pad};font-family:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace;font-size:13.5px;line-height:20px;font-weight:600;color:#1f7a46;">&#10003;</td><td valign="top" style="padding:${pad};font-family:'Space Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13.5px;line-height:20px;color:#3a4148;">${html}</td></tr>`;
}

/** The unsubscribe line for promotional emails' footers (empty for account/billing/security mail). */
export function unsubscribeHtml(url: string | null | undefined): string {
  if (!url) return "";
  return `&nbsp;&nbsp;&middot;&nbsp;&nbsp;<a href="${escapeHtml(url)}" target="_blank" style="color:#6c747c;text-decoration:underline;">Unsubscribe</a>`;
}
