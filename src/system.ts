import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_DIR, paths } from "./paths.js";
import { runCommand, piVersion, piCommand } from "./pi.js";
import { loadSecrets, safeConfig, maskedSecrets } from "./config.js";
import { store } from "./store.js";
import { startJob } from "./jobs.js";
import { rollout } from "./supervisor.js";
import { audit } from "./audit.js";

async function version(cmd: string, args: string[]) {
  const r = await runCommand(cmd, args, { timeoutMs: 10_000 });
  return r.code === 0 ? r.output.trim().split("\n")[0] : undefined;
}

const PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "DEEPSEEK_API_KEY", "AI_GATEWAY_API_KEY"];

export async function systemStatus() {
  let piCli: string | undefined;
  try {
    const [cmd, prefix] = piCommand();
    piCli = await version(cmd, [...prefix, "--version"]);
  } catch {
    /* not installed */
  }
  const secrets = loadSecrets();
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const checks = [
    { id: "node", label: "Node.js ≥ 22.13", ok: nodeMajor > 22 || (nodeMajor === 22 && Number(process.versions.node.split(".")[1]) >= 13), detail: process.version },
    { id: "git", label: "git", ok: !!(await version("git", ["--version"])), detail: await version("git", ["--version"]) },
    { id: "pi", label: "pi coding agent", ok: !!piCli, detail: piCli ? `v${piCli}` : "not installed" },
    { id: "keys", label: "Provider API key", ok: Object.keys(secrets).some((k) => PROVIDER_KEYS.includes(k) || /API_KEY$/.test(k)), detail: `${Object.keys(secrets).length} secret(s) configured` },
    { id: "profile", label: "At least one profile", ok: store.list("profile").length > 0, detail: `${store.list("profile").length} profile(s)` },
  ];
  return {
    checks,
    setupComplete: checks.every((c) => c.ok),
    piVersion: piVersion(),
    node: process.version,
    host: { hostname: os.hostname(), platform: `${os.type()} ${os.release()}`, cpus: os.cpus().length, loadavg: os.loadavg(), memTotal: os.totalmem(), memFree: os.freemem(), uptime: os.uptime() },
    config: safeConfig(),
    secrets: maskedSecrets(),
    providerKeys: PROVIDER_KEYS,
    root: paths.root,
  };
}

export async function latestPiVersion(): Promise<string | undefined> {
  const r = await runCommand("npm", ["view", "@earendil-works/pi-coding-agent", "version"], { timeoutMs: 20_000 });
  return r.code === 0 ? r.output.trim() : undefined;
}

/** Install or upgrade the bundled pi, then rolling-restart every running instance onto it. */
export function upgradePi(targetVersion = "latest", ip?: string) {
  if (!/^(latest|\d+\.\d+\.\d+(-[\w.]+)?)$/.test(targetVersion)) throw new Error("Invalid version");
  audit("system.upgrade-pi", { targetVersion }, ip);
  return startJob("system", `Install pi ${targetVersion}`, async (ctx) => {
    const before = piVersion();
    ctx.log(`current: ${before ?? "not installed"}`);
    const r = await runCommand(
      "npm",
      ["install", `@earendil-works/pi-coding-agent@${targetVersion}`, "--save", "--no-audit", "--no-fund"],
      { cwd: APP_DIR, timeoutMs: 600_000 },
      ctx.log,
    );
    if (r.code !== 0) throw new Error("npm install failed");
    const after = piVersion();
    ctx.log(`installed: ${after}`);
    if (before && after !== before) {
      const ids = store.list("instance").filter((i) => i.desired === "running").map((i) => i.id);
      ctx.log(`rolling restart of ${ids.length} instance(s) onto pi ${after}`);
      rollout(ids, `pi ${before} → ${after}`, { reprovision: false });
    }
    return { before, after };
  });
}

function duBytes(p: string): number {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop()!;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      try {
        for (const e of fs.readdirSync(cur)) stack.push(path.join(cur, e));
      } catch {
        /* unreadable */
      }
    } else total += st.size;
  }
  return total;
}

export function diskUsage() {
  const list = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  return {
    instances: list(paths.instances).map((id) => ({ id, bytes: duBytes(path.join(paths.instances, id)) })),
    repos: list(paths.repos).map((id) => ({ id, bytes: duBytes(path.join(paths.repos, id)) })),
    npmCache: duBytes(path.join(paths.root, "npm-cache")),
  };
}

/** Remove instance dirs with no DB record and repo dirs for deleted repos. */
export function cleanup() {
  const removed: string[] = [];
  const instIds = new Set(store.list("instance").map((i) => i.id));
  const repoIds = new Set(store.list("repo").map((r) => r.id));
  for (const [dir, known] of [[paths.instances, instIds], [paths.repos, repoIds]] as const) {
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir)) {
      if (!known.has(e)) {
        fs.rmSync(path.join(dir, e), { recursive: true, force: true });
        removed.push(path.join(path.basename(dir), e));
      }
    }
  }
  fs.rmSync(paths.tmp, { recursive: true, force: true });
  return removed;
}
