import fs from "node:fs";
import path from "node:path";
import { instancePaths, ensureDir, expandHome, paths, repoPaths } from "./paths.js";
import { runPi, runCommand, toolEnv } from "./pi.js";
import { store } from "./store.js";
import { isRemoteSource, packageIdentity, packageSource } from "./profiles.js";
import type { Instance, PackageEntry, Profile, Repo } from "./types.js";

type Log = (line: string) => void;

// ---------------------------------------------------------------- desired state

/** Absolute path pi should load for a tracked repo (through the swap-able `current` symlink). */
export function repoLoadPath(repo: Repo): string {
  return path.join(repoPaths(repo.id).current, repo.subdir ?? "");
}

export interface DesiredResources {
  packages: PackageEntry[];
  skills: string[];
}

export function desiredResources(inst: Instance, profile: Profile): DesiredResources {
  const byId = new Map<string, PackageEntry>();
  const skills = profile.skills.map((s) => path.resolve(expandHome(s)));
  // Tracked repos first so an instance-level entry with the same path (resource filters) overrides them.
  for (const rid of profile.repos) {
    const repo = store.get("repo", rid);
    if (!repo?.currentSha) continue;
    if (repo.kind === "skills") skills.push(repoLoadPath(repo));
    else byId.set(repoLoadPath(repo), repoLoadPath(repo));
  }
  for (const p of [...profile.packages, ...inst.extraPackages]) byId.set(packageIdentity(packageSource(p)), p);
  return { packages: [...byId.values()], skills };
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(inst: Instance, patch: Record<string, unknown>) {
  const p = instancePaths(inst.id);
  ensureDir(p.agentDir);
  const cur = readJson(p.settings);
  fs.writeFileSync(p.settings, JSON.stringify({ ...cur, ...patch }, null, 2) + "\n");
}

export function ensureInstanceDirs(inst: Instance) {
  const p = instancePaths(inst.id);
  for (const d of [p.dir, p.home, p.agentDir, p.npmPrefix, p.workspace, p.sessions, p.logs]) ensureDir(d);
}

/**
 * Make an instance's installed packages + settings.json match its profile.
 * Remote packages are installed/removed with the real `pi install/remove` inside
 * the instance env; settings.json `packages`/`skills` are then written declaratively.
 * Returns the list of remote sources now installed.
 */
export async function provisionInstance(inst: Instance, profile: Profile, log: Log): Promise<string[]> {
  ensureInstanceDirs(inst);
  const want = desiredResources(inst, profile);
  const wantRemote = want.packages.map(packageSource).filter(isRemoteSource);
  const have = new Set(inst.installed);

  for (const src of inst.installed) {
    if (wantRemote.includes(src)) continue;
    log(`[${inst.name}] removing ${src}`);
    const r = await runPi(inst, profile, ["remove", src], (l) => log(`[${inst.name}]   ${l}`));
    if (r.code !== 0) log(`[${inst.name}] warning: pi remove exited ${r.code}`);
    have.delete(src);
  }
  for (const src of wantRemote) {
    if (have.has(src)) continue;
    log(`[${inst.name}] installing ${src}`);
    const r = await runPi(inst, profile, ["install", src], (l) => log(`[${inst.name}]   ${l}`));
    if (r.code !== 0) throw new Error(`pi install ${src} failed in ${inst.name} (exit ${r.code})`);
    have.add(src);
  }
  const settings: Record<string, unknown> = { packages: want.packages, skills: want.skills };
  const [provider, ...rest] = (inst.model ?? profile.model ?? "").split("/");
  if (rest.length) {
    settings.defaultProvider = provider;
    settings.defaultModel = rest.join("/");
  }
  if (profile.thinking) settings.defaultThinkingLevel = profile.thinking;
  writeSettings(inst, settings);
  const modelsFile = path.join(instancePaths(inst.id).agentDir, "models.json");
  if (profile.modelsJson) fs.writeFileSync(modelsFile, profile.modelsJson + "\n", { mode: 0o600 });
  else fs.rmSync(modelsFile, { force: true });
  return [...have];
}

/** Update remote packages in place (`pi update --extensions`), e.g. to move unpinned git/npm sources. */
export async function updateInstancePackages(inst: Instance, profile: Profile, log: Log, source?: string) {
  const args = source ? ["update", source] : ["update", "--extensions"];
  const r = await runPi(inst, profile, args, (l) => log(`[${inst.name}] ${l}`));
  if (r.code !== 0) throw new Error(`pi ${args.join(" ")} failed in ${inst.name}`);
}

// ---------------------------------------------------------------- inspection

export interface Resource {
  type: "skills" | "extensions" | "prompts" | "themes";
  /** Path relative to the package root, as used in settings filters. */
  path: string;
  name: string;
  description?: string;
  enabled: boolean;
}

export interface InstalledPackage {
  source: string;
  identity: string;
  dir?: string;
  name?: string;
  version?: string;
  description?: string;
  tracked?: string;
  resources: Resource[];
  runsCode: boolean;
}

/** Where pi puts a package on disk for a given instance. */
export function packageDir(inst: Instance, src: string): string | undefined {
  const agent = instancePaths(inst.id).agentDir;
  if (src.startsWith("npm:")) {
    const spec = src.slice(4);
    const at = spec.lastIndexOf("@");
    return path.join(agent, "npm", "node_modules", at > 0 ? spec.slice(0, at) : spec);
  }
  const m = src.match(/^(?:git:|https?:\/\/|ssh:\/\/)(?:[^@/]+@)?(.+?)(?:\.git)?(?:@[^/@]+)?$/);
  if (m && isRemoteSource(src)) return path.join(agent, "git", m[1].replace(":", "/"));
  return path.isAbsolute(src) ? src : path.resolve(agent, src);
}

function frontmatter(file: string): Record<string, string> {
  try {
    const txt = fs.readFileSync(file, "utf8");
    const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return {};
    const out: Record<string, string> = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
      if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

function walk(dir: string, depth: number, visit: (file: string) => void) {
  if (depth < 0 || !fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth - 1, visit);
    else visit(full);
  }
}

function expandPatterns(root: string, patterns: string[] | undefined, fallbackDir: string): string[] {
  const list = patterns ?? [fallbackDir];
  const out: string[] = [];
  for (const pat of list) {
    if (pat.startsWith("!")) continue;
    if (/[*?[]/.test(pat)) {
      try {
        for (const f of fs.globSync(pat, { cwd: root })) out.push(path.join(root, f));
      } catch {
        /* ignore bad globs */
      }
    } else out.push(path.join(root, pat));
  }
  return out.filter((p) => fs.existsSync(p));
}

/** Enumerate the skills/extensions/prompts/themes a package provides. */
export function scanPackage(dir: string, opts: { skillsOnly?: boolean } = {}): { resources: Omit<Resource, "enabled">[]; manifest: any; pkg: any } {
  const pkg = readJson(path.join(dir, "package.json"));
  const manifest = opts.skillsOnly ? { skills: ["."], extensions: [], prompts: [], themes: [] } : (pkg.pi ?? {});
  const resources: Omit<Resource, "enabled">[] = [];
  const rel = (p: string) => path.relative(dir, p);

  for (const base of expandPatterns(dir, manifest.skills, "skills")) {
    const files: string[] = [];
    if (fs.statSync(base).isFile()) files.push(base);
    else walk(base, 4, (f) => path.basename(f) === "SKILL.md" && files.push(f));
    for (const f of files) {
      const fm = frontmatter(f);
      const skillDir = path.dirname(f);
      resources.push({ type: "skills", path: rel(skillDir), name: fm.name ?? path.basename(skillDir), description: fm.description });
    }
  }
  const fileTypes: [Resource["type"], RegExp, string][] = [
    ["extensions", /\.(ts|js|mjs)$/, "extensions"],
    ["prompts", /\.md$/, "prompts"],
    ["themes", /\.json$/, "themes"],
  ];
  for (const [type, re, fallback] of fileTypes) {
    for (const base of expandPatterns(dir, manifest[type], fallback)) {
      const files: string[] = [];
      if (fs.statSync(base).isFile()) files.push(base);
      else walk(base, type === "extensions" ? 1 : 3, (f) => re.test(f) && !f.endsWith(".d.ts") && files.push(f));
      for (const f of files) {
        const description = type === "prompts" ? frontmatter(f).description : undefined;
        resources.push({ type, path: rel(f), name: path.basename(f).replace(re, ""), description });
      }
    }
  }
  return { resources, manifest, pkg };
}

function isEnabled(entry: PackageEntry, r: Omit<Resource, "enabled">): boolean {
  if (typeof entry === "string") return true;
  const filters = entry[r.type];
  if (!filters) return true;
  if (filters.length === 0) return false;
  const hasPositive = filters.some((f) => !f.startsWith("-") && !f.startsWith("!"));
  let on = !hasPositive || filters.includes(`+${r.path}`) || filters.includes(r.path);
  if (filters.includes(`-${r.path}`)) on = false;
  return on;
}

/** Everything installed in one instance, with per-resource enabled state. */
export function listInstalled(inst: Instance, profile: Profile | undefined): InstalledPackage[] {
  if (!profile) return [];
  const want = desiredResources(inst, profile);
  const out: InstalledPackage[] = [];
  const trackedByPath = new Map(
    profile.repos.map((rid) => store.get("repo", rid)).filter(Boolean).map((r) => [repoLoadPath(r!), r!.id] as const),
  );
  for (const entry of want.packages) {
    const src = packageSource(entry);
    const dir = trackedByPath.has(src) ? src : packageDir(inst, src);
    const exists = !!dir && fs.existsSync(dir);
    const scan = exists ? scanPackage(dir!) : { resources: [], pkg: {}, manifest: {} };
    out.push({
      source: src,
      identity: trackedByPath.has(src) ? `repo:${trackedByPath.get(src)}` : packageIdentity(src),
      dir: exists ? dir : undefined,
      name: scan.pkg.name,
      version: scan.pkg.version,
      description: scan.pkg.description,
      tracked: trackedByPath.get(src),
      resources: scan.resources.map((r) => ({ ...r, enabled: isEnabled(entry, r) })),
      runsCode: scan.resources.some((r) => r.type === "extensions"),
    });
  }
  // Skills-only tracked repos load through settings.skills rather than packages.
  for (const rid of profile.repos) {
    const repo = store.get("repo", rid);
    if (!repo?.currentSha || repo.kind !== "skills") continue;
    const dir = repoLoadPath(repo);
    const scan = fs.existsSync(dir) ? scanPackage(dir, { skillsOnly: true }) : { resources: [] };
    out.push({
      source: dir,
      identity: `repo:${rid}`,
      dir,
      name: rid,
      version: repo.currentSha.slice(0, 10),
      tracked: rid,
      resources: scan.resources.map((r) => ({ ...r, enabled: true })),
      runsCode: false,
    });
  }
  return out;
}

/** Return a copy of `entry` with one resource toggled via exact +/- filters. */
export function toggleResource(entry: PackageEntry, type: Resource["type"], relPath: string, enabled: boolean): PackageEntry {
  const obj = typeof entry === "string" ? { source: entry } : { ...entry };
  let filters = [...(obj[type] ?? [])].filter((f) => f !== `-${relPath}` && f !== `+${relPath}`);
  if (!enabled) filters.push(`-${relPath}`);
  else if (obj[type] && obj[type]!.length === 0) filters = [`+${relPath}`];
  if (filters.length) obj[type] = filters;
  else delete obj[type];
  const keys = Object.keys(obj).filter((k) => k !== "source");
  return keys.length ? obj : obj.source;
}

// ---------------------------------------------------------------- discovery

const searchCache = new Map<string, { at: number; data: unknown }>();
const TTL = 10 * 60 * 1000;

async function cachedJson(url: string): Promise<any> {
  const hit = searchCache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const data = await res.json();
  searchCache.set(url, { at: Date.now(), data });
  if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value!);
  return data;
}

export async function searchPackages(q: string, from = 0) {
  const text = encodeURIComponent(`keywords:pi-package ${q}`.trim());
  const data = await cachedJson(`https://registry.npmjs.org/-/v1/search?text=${text}&size=30&from=${from}`);
  return {
    total: data.total as number,
    results: (data.objects ?? []).map((o: any) => ({
      name: o.package.name,
      version: o.package.version,
      description: o.package.description,
      keywords: o.package.keywords ?? [],
      date: o.package.date,
      publisher: o.package.publisher?.username,
      links: o.package.links ?? {},
      downloads: o.downloads?.weekly ?? null,
      score: o.score?.final,
    })),
  };
}

export async function packageInfo(name: string) {
  if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(name)) throw new Error("Invalid package name");
  const data = await cachedJson(`https://registry.npmjs.org/${name.replace("/", "%2f")}`);
  const latest = data["dist-tags"]?.latest;
  const v = data.versions?.[latest] ?? {};
  return {
    name,
    version: latest,
    description: v.description ?? data.description,
    readme: (data.readme ?? "").slice(0, 200_000),
    homepage: v.homepage,
    repository: typeof v.repository === "string" ? v.repository : v.repository?.url,
    license: v.license,
    manifest: v.pi ?? null,
    keywords: v.keywords ?? [],
    versions: Object.keys(data.versions ?? {}).reverse().slice(0, 30),
    runsCode: !!(v.pi?.extensions?.length) || (v.keywords ?? []).includes("pi-extension"),
  };
}

/** Fetch a package source into a temp dir and inspect it before installing anywhere. */
export async function previewSource(source: string) {
  if (!isRemoteSource(source) && !fs.existsSync(expandHome(source))) throw new Error("Source must be npm:, git:, https://, ssh:// or an existing local path");
  const tmp = fs.mkdtempSync(path.join((ensureDir(paths.tmp), paths.tmp), "preview-"));
  try {
    let dir = tmp;
    if (source.startsWith("npm:")) {
      const r = await runCommand("npm", ["pack", source.slice(4), "--silent", "--pack-destination", tmp], { cwd: tmp, timeoutMs: 120_000, env: toolEnv() });
      const tgz = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz"));
      if (r.code !== 0 || !tgz) throw new Error(`npm pack failed: ${r.output.slice(-400)}`);
      await runCommand("tar", ["-xzf", tgz], { cwd: tmp });
      dir = path.join(tmp, "package");
    } else if (isRemoteSource(source)) {
      const { url, ref } = gitUrlAndRef(source);
      const args = ["clone", "--depth", "1", ...(ref ? ["--branch", ref] : []), url, path.join(tmp, "repo")];
      const r = await runCommand("git", args, { timeoutMs: 120_000, env: toolEnv() });
      if (r.code !== 0) throw new Error(`git clone failed: ${r.output.slice(-400)}`);
      dir = path.join(tmp, "repo");
    } else dir = path.resolve(expandHome(source));
    const scan = scanPackage(dir);
    let readme = "";
    for (const f of ["README.md", "readme.md", "Readme.md"]) {
      if (fs.existsSync(path.join(dir, f))) {
        readme = fs.readFileSync(path.join(dir, f), "utf8").slice(0, 200_000);
        break;
      }
    }
    return {
      source,
      name: scan.pkg.name,
      version: scan.pkg.version,
      description: scan.pkg.description,
      manifest: scan.pkg.pi ?? null,
      resources: scan.resources,
      runsCode: scan.resources.some((r) => r.type === "extensions"),
      hasDependencies: Object.keys(scan.pkg.dependencies ?? {}).length > 0,
      readme,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Turn a pi git source into a clonable URL + optional ref. */
export function gitUrlAndRef(source: string): { url: string; ref?: string } {
  let s = source;
  let ref: string | undefined;
  const m = s.match(/^(.*?)(?:@([^/@:]+))?$/);
  if (m && m[2]) {
    s = m[1];
    ref = m[2];
  }
  if (s.startsWith("git:")) {
    s = s.slice(4);
    if (/^git@/.test(s)) return { url: s, ref };
    return { url: `https://${s}`, ref };
  }
  return { url: s, ref };
}
