import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { APP_DIR, instancePaths, paths } from "./paths.js";
import { loadConfig, loadSecrets, redact } from "./config.js";
import type { Instance, Profile } from "./types.js";

const require = createRequire(import.meta.url);

const PI_PKG = "@earendil-works/pi-coding-agent";

/** Locate the installed pi package root (its exports map hides ./package.json from require.resolve). */
export function piPackageDir(): string | undefined {
  try {
    let dir = path.dirname(require.resolve(PI_PKG, { paths: [APP_DIR] }));
    while (dir !== path.dirname(dir)) {
      const f = path.join(dir, "package.json");
      if (fs.existsSync(f) && JSON.parse(fs.readFileSync(f, "utf8")).name === PI_PKG) return dir;
      dir = path.dirname(dir);
    }
  } catch {
    /* not installed */
  }
  const direct = path.join(APP_DIR, "node_modules", PI_PKG);
  return fs.existsSync(path.join(direct, "package.json")) ? direct : undefined;
}

/** Resolve the pi CLI entry. Returns [command, argsPrefix]. Re-resolved each call so in-place upgrades apply. */
export function piCommand(): [string, string[]] {
  const override = loadConfig().piBin;
  if (override) return override.endsWith(".js") ? [process.execPath, [override]] : [override, []];
  const dir = piPackageDir();
  if (!dir) throw new Error("pi is not installed — use System → Install pi, or run install.sh");
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pi;
  return [process.execPath, [path.join(dir, bin)]];
}

export function piVersion(): string | undefined {
  const dir = piPackageDir();
  return dir ? JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version : undefined;
}

/** Only these host variables pass through to instances; everything else (incl. the real HOME/XDG dirs) is dropped. */
const PASSTHROUGH = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "SHELL", "USER", "LOGNAME", "TZ", "SSH_AUTH_SOCK", "http_proxy", "https_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];

/**
 * Build the fully isolated environment for one pi instance.
 * HOME is overridden so ~/.pi and ~/.agents resolve inside the instance dir.
 */
export function instanceEnv(inst: Pick<Instance, "id">, profile?: Pick<Profile, "env">): Record<string, string> {
  const p = instancePaths(inst.id);
  const env: Record<string, string> = {};
  for (const k of PASSTHROUGH) if (process.env[k]) env[k] = process.env[k]!;
  // Keep node on PATH even if the server was started with an absolute node path.
  env.PATH = [path.dirname(process.execPath), env.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(":");
  const realGitConfig = path.join(os.homedir(), ".gitconfig");
  Object.assign(env, loadSecrets(), profile?.env ?? {}, {
    HOME: p.home,
    PI_CODING_AGENT_DIR: p.agentDir,
    PI_CODING_AGENT_SESSION_DIR: p.sessions,
    XDG_CONFIG_HOME: path.join(p.home, ".config"),
    XDG_CACHE_HOME: path.join(p.home, ".cache"),
    XDG_DATA_HOME: path.join(p.home, ".local", "share"),
    XDG_STATE_HOME: path.join(p.home, ".local", "state"),
    npm_config_prefix: p.npmPrefix,
    // Shared download cache is safe (content-addressed) and saves N re-downloads.
    npm_config_cache: path.join(paths.root, "npm-cache"),
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    FRUITY_PI_INSTANCE: inst.id,
  });
  // Let git in instances use the operator's git identity/credential helpers for private repos.
  if (fs.existsSync(realGitConfig) && !env.GIT_CONFIG_GLOBAL) env.GIT_CONFIG_GLOBAL = realGitConfig;
  return env;
}

export interface RunResult {
  code: number;
  output: string;
}

/** Run a one-shot pi CLI command (install/remove/list/update) inside an instance env, streaming lines. */
export function runPi(
  inst: Pick<Instance, "id">,
  profile: Pick<Profile, "env"> | undefined,
  args: string[],
  onLine?: (line: string) => void,
  cwd?: string,
): Promise<RunResult> {
  const [cmd, prefix] = piCommand();
  const p = instancePaths(inst.id);
  return runCommand(cmd, [...prefix, ...args], { env: instanceEnv(inst, profile), cwd: cwd ?? p.workspace }, onLine);
}

export function runCommand(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; timeoutMs?: number },
  onLine?: (line: string) => void,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? (process.env as Record<string, string>),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs) : undefined;
    const handle = (chunk: Buffer) => {
      const text = redact(chunk.toString("utf8"));
      output += text;
      if (onLine) for (const l of text.split(/\r?\n/)) if (l.trim()) onLine(l);
    };
    child.stdout.on("data", handle);
    child.stderr.on("data", handle);
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, output: output + String(err) });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}
