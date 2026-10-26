import { Controller, Get } from "@nestjs/common";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function resolveBuildInfo(): { commit: string; buildTime: string } {
  let commit =
    process.env.GIT_COMMIT_HASH ||
    process.env.COMMIT_HASH ||
    process.env.K_REVISION ||
    "";
  let buildTime = process.env.BUILD_TIME || "";

  if (!commit || !buildTime) {
    try {
      const candidatePaths = [
        path.resolve(__dirname, "../../build-info.json"),
        path.resolve(__dirname, "../build-info.json"),
        path.resolve(process.cwd(), "build-info.json"),
      ];
      for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
          const info = JSON.parse(fs.readFileSync(p, "utf-8"));
          if (!commit && info.commit) commit = info.commit;
          if (!buildTime && info.buildTime) buildTime = info.buildTime;
          break;
        }
      }
    } catch {}
  }

  if (!commit) {
    try {
      commit = execSync("git rev-parse HEAD", {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      commit = "unknown";
    }
  }

  if (!buildTime) {
    try {
      const gitTime = execSync("git log -1 --format=%cI", {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      buildTime = gitTime || new Date().toISOString();
    } catch {
      buildTime = new Date().toISOString();
    }
  }

  return { commit, buildTime };
}

const BUILD_INFO = resolveBuildInfo();

@Controller("health")
export class HealthController {
  @Get()
  check() {
    return {
      ok: true,
      service: "market-catalyst-backend",
      commit: BUILD_INFO.commit,
      buildTime: BUILD_INFO.buildTime,
      time: new Date().toISOString(),
    };
  }
}
