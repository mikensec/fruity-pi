import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { store } from "./store.js";
import { configHash, getProfile, ID_RE } from "./profiles.js";
import { createInstances, deleteInstance, reprovision, waitForIdle, getInstance } from "./supervisor.js";
import { startJob, pool } from "./jobs.js";
import { instancePaths, expandHome, ensureDir } from "./paths.js";
import { runCommand } from "./pi.js";
import { audit } from "./audit.js";
import { publish } from "./bus.js";
import type { Deployment, DeploymentGroup, Instance } from "./types.js";

export const EXAMPLE_SPEC = `# Declarative spec: apply to create/scale/update clusters of pi instances.
name: example
groups:
  - cluster: reviewers      # target with  cluster:reviewers
    profile: default
    replicas: 3
    # cwd: ~/src/app        # shared working dir (default: private workspace per replica)
    # worktree: true        # one git worktree per replica (cwd must be a git repo)
  # - cluster: writers
  #   profile: docs
  #   replicas: 5
  #   model: anthropic/claude-sonnet-5-5
`;

export function parseSpec(text: string): Omit<Deployment, "yaml"> {
  let doc: any;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    throw new Error(`YAML error: ${(e as Error).message}`);
  }
  if (!doc || typeof doc !== "object") throw new Error("Spec must be a YAML mapping");
  const name = String(doc.name ?? "").trim();
  if (!ID_RE.test(name)) throw new Error("name: lowercase letters, digits, - _ . (max 63)");
  if (!Array.isArray(doc.groups)) throw new Error("groups: must be a list");
  const seen = new Set<string>();
  const groups: DeploymentGroup[] = doc.groups.map((g: any, i: number) => {
    const where = `groups[${i}]`;
    const cluster = String(g?.cluster ?? "").trim();
    if (!ID_RE.test(cluster)) throw new Error(`${where}.cluster is invalid`);
    if (seen.has(cluster)) throw new Error(`${where}: duplicate cluster ${cluster}`);
    seen.add(cluster);
    const profile = String(g.profile ?? "");
    if (!store.get("profile", profile)) throw new Error(`${where}: unknown profile "${profile}"`);
    const replicas = Number(g.replicas ?? 1);
    if (!Number.isInteger(replicas) || replicas < 0 || replicas > 200) throw new Error(`${where}.replicas must be an integer 0–200`);
    const cwd = g.cwd ? String(g.cwd) : undefined;
    if (cwd && !fs.existsSync(path.resolve(expandHome(cwd)))) throw new Error(`${where}.cwd does not exist: ${cwd}`);
    if (g.worktree && !cwd) throw new Error(`${where}: worktree: true needs a cwd pointing at a git repo`);
    return { cluster, profile, replicas, cwd, worktree: !!g.worktree, model: g.model ? String(g.model) : undefined };
  });
  return { name, groups };
}

export function saveDeployment(yaml: string): Deployment {
  const spec = parseSpec(yaml);
  const prev = store.get("deployment", spec.name);
  const dep: Deployment = { ...spec, yaml, appliedAt: prev?.appliedAt, updatedAt: new Date().toISOString() };
  store.put("deployment", dep.name, dep);
  publish({ topic: "state" });
  return dep;
}

export interface PlanStep {
  op: "create" | "remove" | "update";
  cluster: string;
  name: string;
  reasons?: string[];
}

function indexOf(name: string, cluster: string) {
  const m = name.slice(cluster.length).match(/^-(\d+)$/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function desiredCwd(g: DeploymentGroup, name: string) {
  return g.worktree ? path.join(instancePaths(name).dir, "worktree") : g.cwd;
}

export function planDeployment(dep: Pick<Deployment, "name" | "groups">): PlanStep[] {
  const all = store.list("instance");
  const mine = all.filter((i) => i.deployment === dep.name);
  const takenElsewhere = new Set(all.filter((i) => i.deployment !== dep.name).map((i) => i.name));
  const steps: PlanStep[] = [];
  for (const g of dep.groups) {
    const members = mine.filter((i) => i.cluster === g.cluster).sort((a, b) => indexOf(a.name, g.cluster) - indexOf(b.name, g.cluster));
    const keep = members.slice(0, g.replicas);
    for (const i of members.slice(g.replicas).reverse()) steps.push({ op: "remove", cluster: g.cluster, name: i.name });
    const used = new Set(members.map((m) => m.name));
    let n = 1;
    for (let k = members.length; k < g.replicas; k++) {
      while (used.has(`${g.cluster}-${n}`)) n++;
      const name = `${g.cluster}-${n}`;
      if (takenElsewhere.has(name)) throw new Error(`Instance name ${name} is already used outside deployment ${dep.name}`);
      used.add(name);
      steps.push({ op: "create", cluster: g.cluster, name });
    }
    const profile = getProfile(g.profile);
    for (const i of keep) {
      const reasons: string[] = [];
      if (i.profile !== g.profile) reasons.push(`profile ${i.profile} → ${g.profile}`);
      if ((i.model ?? "") !== (g.model ?? "")) reasons.push(`model ${i.model ?? "(profile)"} → ${g.model ?? "(profile)"}`);
      if ((i.cwd ?? "") !== (desiredCwd(g, i.name) ?? "")) reasons.push("working directory changed");
      const next = { ...i, model: g.model, cwd: desiredCwd(g, i.name) };
      if (!reasons.length && i.configHash !== configHash(next, profile)) reasons.push(`profile ${g.profile} config changed`);
      if (reasons.length) steps.push({ op: "update", cluster: g.cluster, name: i.name, reasons });
    }
  }
  const clusters = new Set(dep.groups.map((g) => g.cluster));
  for (const i of mine) if (!i.cluster || !clusters.has(i.cluster)) steps.push({ op: "remove", cluster: i.cluster ?? "?", name: i.name });
  return steps;
}

async function addWorktree(repoDir: string, name: string, log: (l: string) => void) {
  const dest = path.join(instancePaths(name).dir, "worktree");
  if (fs.existsSync(dest)) return dest;
  ensureDir(instancePaths(name).dir);
  const r = await runCommand("git", ["-C", repoDir, "worktree", "add", "-B", `fruity-pi/${name}`, dest], {}, log);
  if (r.code !== 0) throw new Error(`git worktree add failed for ${name}`);
  return dest;
}

async function removeWorktree(inst: Instance, group: DeploymentGroup | undefined, log: (l: string) => void) {
  const dest = path.join(instancePaths(inst.id).dir, "worktree");
  if (!fs.existsSync(dest) || !group?.cwd) return;
  await runCommand("git", ["-C", path.resolve(expandHome(group.cwd)), "worktree", "remove", "--force", dest], {}, log);
}

export function applyDeployment(name: string, ip?: string) {
  const dep = store.get("deployment", name);
  if (!dep) throw new Error(`Unknown deployment ${name}`);
  const steps = planDeployment(dep);
  audit("deployment.apply", { deployment: name, steps: steps.map((s) => `${s.op} ${s.name}`) }, ip);
  const job = startJob("deploy", `Apply ${name}: ${summarize(steps)}`, async (ctx) => {
    const groups = new Map(dep.groups.map((g) => [g.cluster, g]));
    // Removals first to free capacity.
    for (const s of steps.filter((s) => s.op === "remove")) {
      ctx.log(`− removing ${s.name}`);
      const inst = store.get("instance", s.name);
      if (inst) await removeWorktree(inst, groups.get(s.cluster) ?? findOldGroup(inst), ctx.log);
      await deleteInstance(s.name).catch((e) => ctx.log(`  ${e.message}`));
    }
    const creates = steps.filter((s) => s.op === "create");
    const pending: Promise<void>[] = [];
    for (const s of creates) {
      const g = groups.get(s.cluster)!;
      let cwd = g.cwd;
      if (g.worktree) cwd = await addWorktree(path.resolve(expandHome(g.cwd!)), s.name, ctx.log);
      ctx.log(`+ creating ${s.name}`);
      pending.push(createInstances({ profile: g.profile, names: [s.name], cluster: g.cluster, deployment: name, cwd, model: g.model }, ctx).done);
      if (pending.length >= 4) await Promise.all(pending.splice(0));
    }
    await Promise.all(pending);
    // Rolling update: 2 at a time, each waits for its current run to settle.
    await pool(
      steps.filter((s) => s.op === "update"),
      2,
      async (s) => {
        const g = groups.get(s.cluster)!;
        const inst = getInstance(s.name);
        if (inst.desired === "running") await waitForIdle(inst.id);
        ctx.log(`~ updating ${s.name}: ${s.reasons?.join("; ")}`);
        store.update("instance", inst.id, { profile: g.profile, model: g.model, cwd: desiredCwd(g, inst.id) });
        await reprovision(inst.id, ctx.log).catch((e) => ctx.log(`  ✗ ${e.message}`));
      },
    );
    store.update("deployment", name, { appliedAt: new Date().toISOString() });
    publish({ topic: "state" });
    ctx.log(`✓ ${name} applied`);
  });
  return { job, steps };
}

function findOldGroup(inst: Instance): DeploymentGroup | undefined {
  const dep = inst.deployment ? store.get("deployment", inst.deployment) : undefined;
  return dep?.groups.find((g) => g.cluster === inst.cluster);
}

export function deleteDeployment(name: string, ip?: string) {
  const dep = store.get("deployment", name);
  if (!dep) throw new Error(`Unknown deployment ${name}`);
  audit("deployment.delete", { deployment: name }, ip);
  return startJob("deploy", `Tear down ${name}`, async (ctx) => {
    const groups = new Map(dep.groups.map((g) => [g.cluster, g]));
    for (const i of store.list("instance").filter((i) => i.deployment === name)) {
      ctx.log(`− removing ${i.name}`);
      await removeWorktree(i, groups.get(i.cluster ?? ""), ctx.log);
      await deleteInstance(i.id).catch((e) => ctx.log(`  ${e.message}`));
    }
    store.delete("deployment", name);
    publish({ topic: "state" });
  });
}

function summarize(steps: PlanStep[]) {
  const c = (op: string) => steps.filter((s) => s.op === op).length;
  const parts = [c("create") && `+${c("create")}`, c("update") && `~${c("update")}`, c("remove") && `−${c("remove")}`].filter(Boolean);
  return parts.length ? parts.join(" ") : "no changes";
}
