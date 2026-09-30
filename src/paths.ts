import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Root of all fruity-pi state. Override with FRUITY_PI_HOME. */
export const ROOT = path.resolve(process.env.FRUITY_PI_HOME || path.join(os.homedir(), ".fruity-pi"));

/** Directory of the installed fruity-pi app (the package root). */
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const paths = {
  root: ROOT,
  config: path.join(ROOT, "config.json"),
  secrets: path.join(ROOT, "secrets.env"),
  db: path.join(ROOT, "state.db"),
  audit: path.join(ROOT, "audit.log"),
  tls: path.join(ROOT, "tls"),
  instances: path.join(ROOT, "instances"),
  repos: path.join(ROOT, "repos"),
  tmp: path.join(ROOT, "tmp"),
  shellRecordings: path.join(ROOT, "recordings"),
  webDist: path.join(APP_DIR, "web", "dist"),
};

export interface InstancePaths {
  dir: string;
  home: string;
  agentDir: string;
  npmPrefix: string;
  workspace: string;
  sessions: string;
  logs: string;
  events: string;
  stderr: string;
  settings: string;
}

export function instancePaths(id: string): InstancePaths {
  const dir = path.join(paths.instances, id);
  const home = path.join(dir, "home");
  const agentDir = path.join(home, ".pi", "agent");
  const logs = path.join(dir, "logs");
  return {
    dir,
    home,
    agentDir,
    npmPrefix: path.join(dir, "npm"),
    workspace: path.join(dir, "workspace"),
    sessions: path.join(dir, "sessions"),
    logs,
    events: path.join(logs, "events.jsonl"),
    stderr: path.join(logs, "stderr.log"),
    settings: path.join(agentDir, "settings.json"),
  };
}

export function repoPaths(id: string) {
  const dir = path.join(paths.repos, id);
  return {
    dir,
    mirror: path.join(dir, "mirror.git"),
    current: path.join(dir, "current"),
    checkout: (sha: string) => path.join(dir, sha),
  };
}

export function ensureDir(p: string, mode = 0o700) {
  fs.mkdirSync(p, { recursive: true, mode });
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
