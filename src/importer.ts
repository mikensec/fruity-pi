import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths, ensureDir, instancePaths, expandHome } from "./paths.js";
import { store } from "./store.js";
import { saveProfile, getProfile, ID_RE } from "./profiles.js";
import { createInstances, startInstance } from "./supervisor.js";
import { startJob } from "./jobs.js";
import type { PackageEntry } from "./types.js";

/**
 * Import from an existing, stand-alone pi install (default ~/.pi/agent).
 * Everything is COPIED into ~/.fruity-pi; the source is only ever read.
 */

export function sourcePiDir(dir?: string): string {
  const d = path.resolve(expandHome(dir || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")));
  return d;
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join(" ");
  return "";
}

export interface SessionSummary {
  file: string;
  id: string;
  cwd: string;
  cwdExists: boolean;
  startedAt: string;
  updatedAt: string;
  bytes: number;
  messages: number;
  firstPrompt: string;
  lastPrompt: string;
  name?: string;
  model?: string;
}

/** Sessions dir of a pi install: settings.sessionDir, else <agentDir>/sessions. */
function sessionsRoot(dir: string) {
  const s = readJson(path.join(dir, "settings.json"))?.sessionDir;
  return s ? path.resolve(dir, expandHome(s)) : path.join(dir, "sessions");
}

export function listSessions(dir?: string, limit = 200): { dir: string; sessionsDir: string; sessions: SessionSummary[] } {
  const src = sourcePiDir(dir);
  const root = sessionsRoot(src);
  const files: { file: string; mtime: number; size: number }[] = [];
  const walk = (d: string, depth: number) => {
    if (depth < 0 || !fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, depth - 1);
      else if (e.name.endsWith(".jsonl")) {
        const st = fs.statSync(f);
        files.push({ file: f, mtime: st.mtimeMs, size: st.size });
      }
    }
  };
  walk(root, 2);
  files.sort((a, b) => b.mtime - a.mtime);
  const sessions: SessionSummary[] = [];
  for (const f of files.slice(0, limit)) {
    try {
      // Large sessions: only the head and tail are needed for a summary.
      const raw = f.size > 8 * 1024 * 1024 ? readHeadTail(f.file) : fs.readFileSync(f.file, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const header = JSON.parse(lines[0]);
      if (header.type !== "session") continue;
      let messages = 0;
      let firstPrompt = "";
      let lastPrompt = "";
      let name: string | undefined;
      let model: string | undefined;
      for (const l of lines.slice(1)) {
        let e: any;
        try {
          e = JSON.parse(l);
        } catch {
          continue;
        }
        if (e.type === "message") {
          messages++;
          if (e.message?.role === "user") {
            const t = textOf(e.message.content).trim();
            if (t) {
              if (!firstPrompt) firstPrompt = t;
              lastPrompt = t;
            }
          }
          if (e.message?.role === "assistant" && e.message.model) model = `${e.message.provider ?? ""}/${e.message.model}`.replace(/^\//, "");
        } else if ((e.type === "session_info" || e.type === "session_name") && (e.name || e.title)) name = e.name ?? e.title;
      }
      sessions.push({
        file: f.file,
        id: header.id,
        cwd: header.cwd ?? "",
        cwdExists: !!header.cwd && fs.existsSync(header.cwd),
        startedAt: header.timestamp,
        updatedAt: new Date(f.mtime).toISOString(),
        bytes: f.size,
        messages,
        firstPrompt: firstPrompt.slice(0, 200),
        lastPrompt: lastPrompt.slice(0, 200),
        name,
        model,
      });
    } catch {
      /* skip unreadable/partial files */
    }
  }
  return { dir: src, sessionsDir: root, sessions };
}

function readHeadTail(file: string) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(256 * 1024);
    const tail = Buffer.alloc(2 * 1024 * 1024);
    const h = fs.readSync(fd, head, 0, head.length, 0);
    const t = fs.readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
    const headStr = head.subarray(0, h).toString("utf8");
    const tailStr = tail.subarray(0, t).toString("utf8");
    return headStr.slice(0, headStr.lastIndexOf("\n")) + "\n" + tailStr.slice(tailStr.indexOf("\n") + 1);
  } finally {
    fs.closeSync(fd);
  }
}

/** Only files inside the source pi's sessions dir may be imported (no arbitrary file reads). */
function assertSessionFile(file: string, dir?: string) {
  const root = fs.realpathSync(sessionsRoot(sourcePiDir(dir)));
  const real = fs.realpathSync(file);
  if (!real.startsWith(root + path.sep) || !real.endsWith(".jsonl")) throw new Error("Not a session file of that pi install");
  return real;
}

export interface ImportSessionInput {
  file: string;
  dir?: string;
  profile: string;
  name?: string;
  /** "original" = keep working in the session's project folder; "private" = fresh workspace; or an explicit path. */
  cwd?: "original" | "private" | string;
  start?: boolean;
}

export function importSession(input: ImportSessionInput) {
  const file = assertSessionFile(input.file, input.dir);
  getProfile(input.profile);
  const header = JSON.parse(fs.readFileSync(file, "utf8").split("\n", 1)[0]);
  const base = (input.name || `imported-${String(header.id).slice(-6)}`).toLowerCase().replace(/[^a-z0-9-_.]+/g, "-").slice(0, 60);
  if (!ID_RE.test(base)) throw new Error("Invalid instance name");
  if (store.get("instance", base)) throw new Error(`Instance ${base} already exists`);
  const mode = input.cwd ?? (header.cwd && fs.existsSync(header.cwd) ? "original" : "private");
  const cwd = mode === "original" ? header.cwd : mode === "private" ? undefined : path.resolve(expandHome(mode));
  if (cwd && !fs.existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);

  return startJob("import", `Import session ${String(header.id).slice(0, 8)} → ${base}`, async (ctx) => {
    ctx.log(`source (read-only): ${file}`);
    const { instances, done } = createInstances({ profile: input.profile, names: [base], cwd, start: false }, ctx);
    await done;
    const inst = instances[0];
    // pi's --continue resumes the newest session whose header cwd matches the instance cwd,
    // so rewrite the cwd in the COPY (never in the original).
    const effectiveCwd = cwd ?? instancePaths(inst.id).workspace;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const h = JSON.parse(lines[0]);
    h.cwd = effectiveCwd;
    delete h.parentSession;
    lines[0] = JSON.stringify(h);
    const dest = path.join(instancePaths(inst.id).sessions, path.basename(file));
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, lines.join("\n"), { mode: 0o600 });
    ctx.log(`copied ${lines.length - 1} entries → ${dest}`);
    ctx.log(`working directory: ${effectiveCwd}${mode === "original" ? " (the session's original project folder)" : ""}`);
    if (input.start !== false) {
      store.update("instance", inst.id, { desired: "running" });
      await startInstance(inst.id);
      ctx.log(`✓ ${inst.name} started — it continues the imported conversation`);
    }
    return { instance: inst.id };
  });
}

// ------------------------------------------------------------ pi setup → profile

export interface SetupSummary {
  home: string;
  dir: string;
  exists: boolean;
  packages: PackageEntry[];
  skills: string[];
  extensions: string[];
  prompts: string[];
  agentsMd: boolean;
  modelsJson: boolean;
  authJson: boolean;
  model?: string;
  thinking?: string;
  sessions: number;
}

const listDir = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => !f.startsWith(".")) : []);

export function inspectSetup(dir?: string): SetupSummary {
  const src = sourcePiDir(dir);
  const settings = readJson(path.join(src, "settings.json")) ?? {};
  const home = os.homedir();
  const skills = [...listDir(path.join(src, "skills")).map((s) => `~/.pi/agent/skills/${s}`)];
  if (!dir) skills.push(...listDir(path.join(home, ".agents", "skills")).map((s) => `~/.agents/skills/${s}`));
  return {
    home,
    dir: src,
    exists: fs.existsSync(src),
    packages: Array.isArray(settings.packages) ? settings.packages : [],
    skills,
    extensions: listDir(path.join(src, "extensions")),
    prompts: listDir(path.join(src, "prompts")),
    agentsMd: fs.existsSync(path.join(src, "AGENTS.md")),
    modelsJson: fs.existsSync(path.join(src, "models.json")),
    authJson: fs.existsSync(path.join(src, "auth.json")) && Object.keys(readJson(path.join(src, "auth.json")) ?? {}).length > 0,
    model: settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : undefined,
    thinking: settings.defaultThinkingLevel,
    sessions: listSessions(dir, 10_000).sessions.length,
  };
}

/** Snapshot an existing pi setup into ~/.fruity-pi/imports/<id> and create a profile from it. */
export function importSetup(id: string, dir?: string) {
  if (!ID_RE.test(id)) throw new Error("Profile id must be lowercase letters, digits, - _ .");
  if (store.get("profile", id)) throw new Error(`Profile ${id} already exists`);
  const src = sourcePiDir(dir);
  if (!fs.existsSync(src)) throw new Error(`No pi setup found at ${src}`);
  const info = inspectSetup(dir);
  const dest = path.join(paths.root, "imports", id);
  fs.rmSync(dest, { recursive: true, force: true });
  ensureDir(dest);
  const copy = (from: string, to: string) => {
    if (!fs.existsSync(from)) return false;
    fs.cpSync(from, to, { recursive: true, dereference: true, filter: (p) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(path.relative(from, p)) });
    return true;
  };
  const skillPaths: string[] = [];
  if (copy(path.join(src, "skills"), path.join(dest, "skills"))) skillPaths.push(path.join(dest, "skills"));
  if (!dir && copy(path.join(os.homedir(), ".agents", "skills"), path.join(dest, "agents-skills"))) skillPaths.push(path.join(dest, "agents-skills"));
  const extraArgs: string[] = [];
  if (copy(path.join(src, "extensions"), path.join(dest, "extensions"))) {
    // --extension takes files: top-level *.ts/*.js, or <dir>/index.{ts,js}
    for (const e of fs.readdirSync(path.join(dest, "extensions"), { withFileTypes: true })) {
      const full = path.join(dest, "extensions", e.name);
      if (e.isFile() && /\.(ts|js|mjs)$/.test(e.name)) extraArgs.push("--extension", full);
      else if (e.isDirectory()) {
        const idx = ["index.ts", "index.js", "index.mjs"].map((f) => path.join(full, f)).find((f) => fs.existsSync(f));
        if (idx) extraArgs.push("--extension", idx);
      }
    }
  }
  if (copy(path.join(src, "prompts"), path.join(dest, "prompts"))) extraArgs.push("--prompt-template", path.join(dest, "prompts"));
  if (copy(path.join(src, "AGENTS.md"), path.join(dest, "AGENTS.md"))) extraArgs.push("--append-system-prompt", path.join(dest, "AGENTS.md"));
  // Local-path packages are snapshotted too; npm/git sources are reinstalled per instance.
  const packages: PackageEntry[] = info.packages.map((p, i) => {
    const source = typeof p === "string" ? p : p.source;
    if (/^(npm:|git:|https?:\/\/|ssh:\/\/)/.test(source)) return p;
    const abs = path.resolve(src, expandHome(source));
    const to = path.join(dest, "packages", `${i}-${path.basename(abs)}`);
    const ok = copy(abs, to);
    return ok ? (typeof p === "string" ? to : { ...p, source: to }) : p;
  });
  const modelsJson = fs.existsSync(path.join(src, "models.json")) ? fs.readFileSync(path.join(src, "models.json"), "utf8") : undefined;
  const profile = saveProfile({
    id,
    description: `Imported from ${src.replace(os.homedir(), "~")} on ${new Date().toISOString().slice(0, 10)}`,
    packages,
    repos: [],
    skills: skillPaths,
    model: info.model,
    thinking: info.thinking,
    modelsJson,
    extraArgs,
    env: {},
  });
  return { profile, snapshot: dest, notCopied: info.authJson ? ["auth.json (logins/OAuth tokens): add provider keys in System → Secrets instead"] : [] };
}
