import fs from "node:fs";
import path from "node:path";
import { repoPaths, ensureDir, paths } from "./paths.js";
import { runCommand, toolEnv } from "./pi.js";
import { store } from "./store.js";
import { publish } from "./bus.js";
import { audit } from "./audit.js";
import { ID_RE } from "./profiles.js";
import { requestRestartWhenIdle } from "./supervisor.js";
import type { Repo, RepoKind } from "./types.js";

type Log = (line: string) => void;
const gitEnv = () => toolEnv();
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(id, next.finally(() => locks.get(id) === next && locks.delete(id)));
  return next;
}

/** Accept github.com/x/y, https://…, git@…, git:… and return a clonable URL. */
export function normalizeRepoUrl(input: string): string {
  let s = input.trim().replace(/\/+$/, "");
  if (s.startsWith("git:")) s = s.slice(4);
  if (/^[\w.-]+\.[a-z]{2,}\/[\w.-]+\/[\w.-]+/i.test(s)) s = `https://${s}`;
  if (!/^(https?:\/\/|ssh:\/\/|git@|file:\/\/\/)/.test(s)) throw new Error("Repo URL must look like github.com/owner/repo, https://…, git@…, or file:///path");
  return s;
}

function slugFor(url: string, ref: string) {
  const m = url.replace(/\.git$/, "").match(/([\w.-]+)\/([\w.-]+)$/);
  const base = (m ? `${m[1]}-${m[2]}` : "repo").toLowerCase().replace(/[^a-z0-9-_.]/g, "-");
  return ref && ref !== "main" && ref !== "master" ? `${base}-${ref.toLowerCase().replace(/[^a-z0-9-_.]/g, "-")}`.slice(0, 63) : base.slice(0, 63);
}

const isSha = (ref: string) => /^[0-9a-f]{7,40}$/i.test(ref);

export async function addRepo(input: { url: string; ref?: string; mode?: "track" | "pinned"; pollSeconds?: number; subdir?: string; id?: string }) {
  const url = normalizeRepoUrl(input.url);
  const ref = (input.ref || "main").trim();
  const id = (input.id || slugFor(url, ref)).trim();
  if (!ID_RE.test(id)) throw new Error("Invalid repo id");
  if (store.get("repo", id)) throw new Error(`Repo ${id} already exists`);
  if (input.subdir && (path.isAbsolute(input.subdir) || input.subdir.split("/").includes(".."))) throw new Error("subdir must be a relative path inside the repo");
  const r = await runCommand("git", ["ls-remote", url], { env: gitEnv(), timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`Cannot reach repo: ${r.output.trim().slice(-300)}`);
  const repo: Repo = {
    id,
    url,
    ref,
    mode: input.mode ?? (isSha(ref) ? "pinned" : "track"),
    pollSeconds: Math.max(30, input.pollSeconds ?? 120),
    subdir: input.subdir || undefined,
    history: [],
  };
  store.put("repo", id, repo);
  publish({ topic: "repo", repo });
  return repo;
}

export function updateRepoSettings(id: string, patch: Partial<Pick<Repo, "ref" | "mode" | "pollSeconds" | "subdir">>) {
  const repo = store.get("repo", id);
  if (!repo) throw new Error(`Unknown repo ${id}`);
  const next = store.put("repo", id, {
    ...repo,
    ...patch,
    pollSeconds: Math.max(30, patch.pollSeconds ?? repo.pollSeconds),
  });
  publish({ topic: "repo", repo: next });
  return next;
}

export function deleteRepo(id: string) {
  const users = store.list("profile").filter((p) => p.repos.includes(id));
  if (users.length) throw new Error(`Repo is used by profile(s): ${users.map((p) => p.id).join(", ")}`);
  fs.rmSync(repoPaths(id).dir, { recursive: true, force: true });
  store.delete("repo", id);
  publish({ topic: "state" });
}

function detectKind(root: string): RepoKind {
  const pkgFile = path.join(root, "package.json");
  if (fs.existsSync(pkgFile)) {
    try {
      if (JSON.parse(fs.readFileSync(pkgFile, "utf8")).pi) return "package";
    } catch {
      /* fallthrough */
    }
  }
  if (["extensions", "skills", "prompts", "themes"].some((d) => fs.existsSync(path.join(root, d)))) return "package";
  return "skills";
}

async function remoteSha(repo: Repo): Promise<string | undefined> {
  if (isSha(repo.ref)) return undefined;
  const r = await runCommand("git", ["ls-remote", repo.url, repo.ref, `refs/heads/${repo.ref}`, `refs/tags/${repo.ref}^{}`, `refs/tags/${repo.ref}`], { env: gitEnv(), timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(r.output.trim().slice(-300));
  const lines = r.output.trim().split("\n").filter(Boolean);
  const peeled = lines.find((l) => l.endsWith("^{}"));
  return (peeled ?? lines[0])?.split("\t")[0];
}

/** Fetch, extract the resolved commit into its own dir, and atomically point `current` at it. */
async function materialize(repo: Repo, log: Log, targetSha?: string): Promise<{ sha: string; changed: boolean; kind: RepoKind }> {
  const rp = repoPaths(repo.id);
  ensureDir(rp.dir);
  if (!fs.existsSync(rp.mirror)) {
    log(`cloning ${repo.url}`);
    const r = await runCommand("git", ["clone", "--mirror", repo.url, rp.mirror], { env: gitEnv(), timeoutMs: 300_000 }, log);
    if (r.code !== 0) throw new Error(`git clone failed`);
  } else {
    const r = await runCommand("git", ["--git-dir", rp.mirror, "fetch", "--prune", "origin"], { env: gitEnv(), timeoutMs: 300_000 });
    if (r.code !== 0) throw new Error(`git fetch failed: ${r.output.trim().slice(-300)}`);
  }
  const want = targetSha ?? repo.ref;
  const rev = await runCommand("git", ["--git-dir", rp.mirror, "rev-parse", "--verify", `${want}^{commit}`], { env: gitEnv() });
  if (rev.code !== 0) throw new Error(`Ref not found: ${want}`);
  const sha = rev.output.trim();
  const dir = rp.checkout(sha);
  let current: string | undefined;
  try {
    current = path.basename(fs.readlinkSync(rp.current));
  } catch {
    /* no current yet */
  }
  if (current === sha && fs.existsSync(dir)) return { sha, changed: false, kind: detectKind(path.join(dir, repo.subdir ?? "")) };

  if (!fs.existsSync(dir)) {
    const tmp = `${dir}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    ensureDir(tmp, 0o755);
    log(`extracting ${sha.slice(0, 12)}`);
    const x = await runCommand("sh", ["-c", 'git --git-dir="$1" archive "$2" | tar -x -C "$3"', "sh", rp.mirror, sha, tmp], { env: gitEnv() });
    if (x.code !== 0) throw new Error(`extract failed: ${x.output.slice(-300)}`);
    const root = path.join(tmp, repo.subdir ?? "");
    if (!fs.existsSync(root)) throw new Error(`subdir ${repo.subdir} not found in ${sha.slice(0, 12)}`);
    const pkgFile = path.join(root, "package.json");
    if (fs.existsSync(pkgFile)) {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
      if (Object.keys(pkg.dependencies ?? {}).length) {
        log("installing package dependencies (npm install --omit=dev)");
        const n = await runCommand("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: root, timeoutMs: 600_000, env: toolEnv({ npm_config_cache: path.join(paths.root, "npm-cache") }) }, log);
        if (n.code !== 0) throw new Error("npm install failed");
      }
    }
    fs.renameSync(tmp, dir);
  }
  const link = `${rp.current}.new`;
  fs.rmSync(link, { force: true });
  fs.symlinkSync(sha, link);
  fs.renameSync(link, rp.current);
  return { sha, changed: true, kind: detectKind(path.join(dir, repo.subdir ?? "")) };
}

function prune(repo: Repo) {
  const rp = repoPaths(repo.id);
  const keep = new Set(repo.history.slice(-5).map((h) => h.sha));
  if (repo.currentSha) keep.add(repo.currentSha);
  for (const e of fs.readdirSync(rp.dir)) {
    if (/^[0-9a-f]{40}$/.test(e) && !keep.has(e)) fs.rmSync(path.join(rp.dir, e), { recursive: true, force: true });
  }
}

/** Roll every instance whose profile uses this repo. */
function rolloutRepo(repoId: string) {
  const profiles = new Set(store.list("profile").filter((p) => p.repos.includes(repoId)).map((p) => p.id));
  const insts = store.list("instance").filter((i) => profiles.has(i.profile));
  for (const i of insts) requestRestartWhenIdle(i.id, true);
  return insts.length;
}

export function checkRepo(id: string, log: Log = () => {}, opts: { force?: boolean; targetSha?: string } = {}) {
  return withLock(id, async () => {
    let repo = store.get("repo", id);
    if (!repo) throw new Error(`Unknown repo ${id}`);
    store.update("repo", id, { updating: true });
    publish({ topic: "repo", repo: { ...repo, updating: true } });
    try {
      if (!opts.force && !opts.targetSha && repo.currentSha) {
        const remote = await remoteSha(repo).catch((e) => {
          throw new Error(`ls-remote failed: ${e.message}`);
        });
        if (remote && remote === repo.currentSha) {
          repo = store.update("repo", id, { lastCheck: new Date().toISOString(), lastError: undefined, updating: false })!;
          publish({ topic: "repo", repo });
          return { changed: false, sha: repo.currentSha };
        }
      }
      const res = await materialize(repo, log, opts.targetSha);
      const history = repo.history.at(-1)?.sha === res.sha ? repo.history : [...repo.history, { sha: res.sha, at: new Date().toISOString() }].slice(-20);
      repo = store.update("repo", id, {
        currentSha: res.sha,
        kind: res.kind,
        history,
        lastCheck: new Date().toISOString(),
        lastError: undefined,
        updating: false,
      })!;
      prune(repo);
      publish({ topic: "repo", repo });
      if (res.changed) {
        const n = rolloutRepo(id);
        log(`now at ${res.sha.slice(0, 12)} — rolling out to ${n} instance(s)`);
        audit("repo.updated", { repo: id, sha: res.sha, instances: n });
      }
      return { changed: res.changed, sha: res.sha };
    } catch (err) {
      repo = store.update("repo", id, { lastError: (err as Error).message, lastCheck: new Date().toISOString(), updating: false })!;
      publish({ topic: "repo", repo });
      throw err;
    }
  });
}

/** Pin to a previous commit and roll instances back to it. */
export async function rollbackRepo(id: string, sha: string, log: Log = () => {}) {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error("Invalid sha");
  updateRepoSettings(id, { ref: sha, mode: "pinned" });
  audit("repo.rollback", { repo: id, sha });
  return checkRepo(id, log, { targetSha: sha });
}

/** Handle a GitHub push webhook: check any tracked repo matching the pushed repo+branch. */
export function onGithubPush(payload: any): string[] {
  const urls = [payload?.repository?.clone_url, payload?.repository?.html_url, payload?.repository?.ssh_url, payload?.repository?.git_url]
    .filter(Boolean)
    .map((u: string) => u.replace(/\.git$/, "").replace(/^git:\/\//, "https://").toLowerCase());
  const branch = String(payload?.ref ?? "").replace(/^refs\/heads\//, "");
  const hits = store
    .list("repo")
    .filter((r) => r.mode === "track" && r.ref === branch && urls.includes(r.url.replace(/\.git$/, "").toLowerCase()));
  for (const r of hits) checkRepo(r.id).catch(() => {});
  return hits.map((r) => r.id);
}

let timer: NodeJS.Timeout | undefined;

export function startRepoPoller() {
  if (timer) return;
  const tick = () => {
    const now = Date.now();
    for (const r of store.list("repo")) {
      if (r.updating) continue;
      const due = !r.currentSha || (r.mode === "track" && (!r.lastCheck || now - Date.parse(r.lastCheck) >= r.pollSeconds * 1000));
      if (due && !locks.has(r.id)) checkRepo(r.id).catch(() => {});
    }
  };
  // Clear stale "updating" flags from a previous crash.
  for (const r of store.list("repo")) if (r.updating) store.update("repo", r.id, { updating: false });
  timer = setInterval(tick, 15_000);
  setTimeout(tick, 2000);
}

export function stopRepoPoller() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
