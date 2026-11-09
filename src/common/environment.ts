import type { ConfigService } from "@nestjs/config";

/**
 * Which deployment this process is.
 *
 * "Production" is decided by the Firebase/GCP project, not NODE_ENV: staging
 * also runs with NODE_ENV=production. PRODUCTION_PROJECT_IDS (comma-separated)
 * overrides the default list; the default names the live project so a
 * forgotten env var errs on the side of treating a deploy as production.
 */
export const DEFAULT_PRODUCTION_PROJECT_IDS = "market-catalyst-502415";

export function currentProjectId(config: ConfigService): string {
  return String(
    config.get("FIREBASE_PROJECT_ID") ??
      config.get("GOOGLE_CLOUD_PROJECT") ??
      config.get("GCLOUD_PROJECT") ??
      "",
  ).trim();
}

export function isProductionProject(config: ConfigService): boolean {
  const project = currentProjectId(config);
  if (!project) return false;
  const ids = String(
    config.get("PRODUCTION_PROJECT_IDS", DEFAULT_PRODUCTION_PROJECT_IDS) ??
      DEFAULT_PRODUCTION_PROJECT_IDS,
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.includes(project);
}
