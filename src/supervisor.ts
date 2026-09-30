import fs from "node:fs";
import path from "node:path";
import { PiRpc, type RpcResponse } from "./rpc.js";
import { instancePaths, expandHome } from "./paths.js";
import { instanceEnv, piCommand } from "./pi.js";
import { loadConfig, redact } from "./config.js";
import { store } from "./store.js";
import { publish } from "./bus.js";
import { configHash, getProfile, ID_RE } from "./profiles.js";
import { ensureInstanceDirs, provisionInstance } from "./packages.js";
import { startJob, pool, type JobCtx } from "./jobs.js";
import type { Instance, InstanceStatus, PackageEntry, Profile } from "./types.js";

interface Runtime {
  rpc?: PiRpc;
  status: InstanceStatus;
  startedAt?: string;
  sessionId?: string;
  modelLabel?: string;
  tail: string;
  lastEventAt?: string;
  cost: number;
  tokens: number;
  pendingRestart?: { reprovision: boolean };
  idleWaiters: (() => void)[];
  stopping?: boolean;
  crashes: number[];
  stderrTail: string[];
}

const runtimes = new Map<string, Runtime>();
const running = new Set<string>(); // instances with an active agent run (holding a concurrency slot)
const promptQueue: { id: string; cmd: Record<string, unknown> }[] = [];
const TAIL_CHARS = 4000;
const MAX_EVENT_LOG = 20 * 1024 * 1024;

function rt(id: string): Runtime {
  let r = runtimes.get(id);
  if (!r) {
    r = { status: "stopped", tail: "", cost: 0, tokens: 0, idleWaiters: [], crashes: [], stderrTail: [] };
    runtimes.set(id, r);
  }
  return r;
}

// ------------------------------------------------------------ views

export function instanceView(inst: Instance) {
  const r = rt(inst.id);
  const profile = store.get("profile", inst.profile);
  const repoDrift = profile
    ? profile.repos.some((rid) => {
        const repo = store.get("repo", rid);
        return repo?.currentSha && inst.repoShas[rid] && inst.repoShas[rid] !== repo.currentSha;
      })
    : false;
  return {
    ...inst,
    status: r.status,
    pid: r.rpc?.exited ? undefined : r.rpc?.pid,
    startedAt: r.startedAt,
    sessionId: r.sessionId,
    modelLabel: r.modelLabel ?? inst.model ?? profile?.model,
    tail: r.tail.slice(-1200),
    lastEventAt: r.lastEventAt,
    cost: r.cost,
    tokens: r.tokens,
    pendingRestart: !!r.pendingRestart,
    configDrift: profile ? inst.configHash !== configHash(inst, profile) : false,
    repoDrift,
    queuePosition: promptQueue.findIndex((q) => q.id === inst.id) + 1 || undefined,
    stderrTail: r.stderrTail.slice(-20),
  };
}

export function listInstances() {
  return store.list("instance").map(instanceView);
}

function emitInstance(id: string) {
  const inst = store.get("instance", id);
  if (inst) publish({ topic: "instance", instance: instanceView(inst) });
}

function setStatus(id: string, status: InstanceStatus) {
  const r = rt(id);
  if (r.status === status) return;
  r.status = status;
  if (status === "idle" || status === "stopped" || status === "error") {
    const w = r.idleWaiters.splice(0);
    w.forEach((f) => f());
  }
  emitInstance(id);
}

export function getInstance(idOrName: string): Instance {
  const inst = store.get("instance", idOrName) ?? store.list("instance").find((i) => i.name === idOrName);
  if (!inst) throw new Error(`Unknown instance: ${idOrName}`);
  return inst;
}

export function stats() {
  const all = [...runtimes.values()];
  return {
    running: running.size,
    queued: promptQueue.length,
    maxConcurrent: loadConfig().maxConcurrent,
    live: all.filter((r) => r.rpc && !r.rpc.exited).length,
    cost: all.reduce((a, r) => a + r.cost, 0),
  };
}

// ------------------------------------------------------------ event log

function appendEvent(id: string, rec: unknown) {
  const p = instancePaths(id);
  try {
    if (fs.existsSync(p.events) && fs.statSync(p.events).size > MAX_EVENT_LOG) fs.renameSync(p.events, p.events + ".1");
    fs.appendFileSync(p.events, redact(JSON.stringify({ at: new Date().toISOString(), ...(rec as object) })) + "\n");
  } catch {
    /* logging must never break the supervisor */
  }
}

export function readEvents(id: string, tail = 500): unknown[] {
  const p = instancePaths(id);
  if (!fs.existsSync(p.events)) return [];
  const lines = fs.readFileSync(p.events, "utf8").trimEnd().split("\n");
  return lines.slice(-tail).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}

function pushTail(r: Runtime, text: string) {
  r.tail = (r.tail + text).slice(-TAIL_CHARS);
}

function onEvent(id: string, ev: any) {
  const r = rt(id);
  r.lastEventAt = new Date().toISOString();
  const type = ev?.type;
  switch (type) {
    case "agent_start":
      running.add(id);
      setStatus(id, "running");
      break;
    case "agent_settled":
      running.delete(id);
      setStatus(id, "idle");
      afterSettle(id);
      drainQueue();
      break;
    case "message_update": {
      const d = ev.assistantMessageEvent;
      if (d?.type === "text_delta" && typeof d.delta === "string") pushTail(r, d.delta);
      break;
    }
    case "message_start":
      if (ev.message?.role === "user") {
        const text = contentText(ev.message.content);
        if (text) pushTail(r, `\n\n› ${text}\n\n`);
      }
      break;
    case "message_end": {
      const u = ev.message?.usage;
      if (u) {
        r.tokens += (u.input ?? 0) + (u.output ?? 0);
        r.cost += typeof u.cost === "number" ? u.cost : (u.cost?.total ?? 0);
      }
      if (ev.message?.role === "assistant" && ev.message?.stopReason === "error" && ev.message?.errorMessage) {
        pushTail(r, `\n⚠ ${ev.message.errorMessage}\n`);
      }
      break;
    }
    case "tool_execution_start":
      pushTail(r, `\n⚙ ${ev.toolName ?? "tool"} ${summarizeArgs(ev.args)}\n`);
      break;
  }
  // Streaming deltas go live over the socket but aren't persisted (message_end carries the full text).
  if (type !== "message_update" && type !== "tool_execution_update" && type !== "bash_execution_update") appendEvent(id, ev);
  publish({ topic: "event", id, event: ev });
  if (type === "message_end" || type === "tool_execution_start" || type === "message_start") emitInstance(id);
}

function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
  return "";
}

function summarizeArgs(a: any): string {
  if (!a || typeof a !== "object") return "";
  const v = a.command ?? a.path ?? a.file_path ?? a.pattern ?? Object.values(a)[0];
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
}

// ------------------------------------------------------------ lifecycle

function launchArgs(inst: Instance, profile: Profile): string[] {
  const p = instancePaths(inst.id);
  const args = ["--mode", "rpc", "--continue", "--session-dir", p.sessions, "--name", inst.name];
  const model = inst.model ?? profile.model;
  if (model) args.push("--model", model);
  if (profile.thinking) args.push("--thinking", profile.thinking);
  if (profile.tools) args.push("--tools", profile.tools);
  args.push(profile.approve ? "--approve" : "--no-approve");
  if (profile.appendSystemPrompt) args.push("--append-system-prompt", profile.appendSystemPrompt);
  args.push(...profile.extraArgs);
  return args;
}

export function instanceCwd(inst: Instance): string {
  return inst.cwd ? path.resolve(expandHome(inst.cwd)) : instancePaths(inst.id).workspace;
}

/** Shell command that reproduces this instance's env for interactive use. */
export function interactiveCommand(inst: Instance): string {
  const profile = store.get("profile", inst.profile);
  const env = instanceEnv(inst, profile);
  const [cmd, prefix] = piCommand();
  const keep = ["HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "npm_config_prefix"];
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const envStr = keep.map((k) => `${k}=${q(env[k])}`).join(" ");
  const args = launchArgs(inst, profile ?? ({} as Profile)).filter((a, i, arr) => a !== "--mode" && arr[i - 1] !== "--mode");
  return `cd ${q(instanceCwd(inst))} && env ${envStr} ${[cmd, ...prefix].map(q).join(" ")} ${args.map(q).join(" ")}`;
}

export async function startInstance(id: string): Promise<void> {
  try {
    await startInstanceInner(id);
  } catch (err) {
    const inst = store.get("instance", id);
    if (inst) {
      store.update("instance", inst.id, { lastError: (err as Error).message });
      setStatus(inst.id, "error");
    }
    throw err;
  }
}

async function startInstanceInner(id: string): Promise<void> {
  const inst = getInstance(id);
  const r = rt(inst.id);
  if (r.rpc && !r.rpc.exited) return;
  const profile = getProfile(inst.profile);
  ensureInstanceDirs(inst);
  const cwd = instanceCwd(inst);
  if (!fs.existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
  const [cmd, prefix] = piCommand();
  const rpc = new PiRpc({ command: cmd, args: [...prefix, ...launchArgs(inst, profile)], cwd, env: instanceEnv(inst, profile) });
  r.rpc = rpc;
  r.stopping = false;
  r.startedAt = new Date().toISOString();
  r.stderrTail = [];
  setStatus(inst.id, "starting");
  const stderrFile = instancePaths(inst.id).stderr;
  rpc.on("event", (ev) => onEvent(inst.id, ev));
  rpc.on("stderr", (line: string) => {
    const clean = redact(line);
    r.stderrTail.push(clean);
    if (r.stderrTail.length > 200) r.stderrTail.shift();
    fs.appendFile(stderrFile, clean + "\n", () => {});
    publish({ topic: "stderr", id: inst.id, line: clean });
  });
  rpc.on("exit", (code, signal) => onExit(inst.id, rpc, code, signal));
  rpc.start();

  const state = await rpc.send({ type: "get_state" }, 60_000);
  if (!state.success) {
    setStatus(inst.id, "error");
    store.update("instance", inst.id, { lastError: state.error });
    return;
  }
  r.sessionId = state.data?.sessionId;
  const m = state.data?.model;
  r.modelLabel = m && m.id !== "unknown" ? `${m.provider}/${m.id}` : undefined;
  const repoShas: Record<string, string> = {};
  for (const rid of profile.repos) {
    const sha = store.get("repo", rid)?.currentSha;
    if (sha) repoShas[rid] = sha;
  }
  store.update("instance", inst.id, { repoShas, lastError: undefined, desired: "running" });
  setStatus(inst.id, state.data?.isStreaming ? "running" : "idle");
  drainQueue();
}

function onExit(id: string, rpc: PiRpc, code: number | null, signal: string | null) {
  const r = rt(id);
  if (r.rpc !== rpc) return; // superseded by a newer process
  running.delete(id);
  const inst = store.get("instance", id);
  if (r.stopping || !inst || inst.desired === "stopped") {
    setStatus(id, "stopped");
    drainQueue();
    return;
  }
  // Unexpected exit: back off and restart, give up after 5 crashes in 5 minutes.
  const now = Date.now();
  r.crashes = r.crashes.filter((t) => now - t < 5 * 60_000);
  r.crashes.push(now);
  const msg = `pi exited unexpectedly (code ${code}, signal ${signal})`;
  store.update("instance", id, { lastError: msg });
  setStatus(id, "error");
  if (r.crashes.length < 5) {
    setTimeout(() => startInstance(id).catch(() => setStatus(id, "error")), 1000 * 2 ** r.crashes.length);
  }
  drainQueue();
}

export async function stopInstance(id: string, persistDesired = true) {
  const inst = getInstance(id);
  const r = rt(inst.id);
  if (persistDesired) store.update("instance", inst.id, { desired: "stopped" });
  for (let i = promptQueue.length - 1; i >= 0; i--) if (promptQueue[i].id === inst.id) promptQueue.splice(i, 1);
  if (!r.rpc || r.rpc.exited) {
    setStatus(inst.id, "stopped");
    return;
  }
  r.stopping = true;
  await r.rpc.stop();
}

export async function restartInstance(id: string) {
  await stopInstance(id, false);
  store.update("instance", getInstance(id).id, { desired: "running" });
  await startInstance(id);
}

/** Wait until an instance is not running an agent turn. */
export function waitForIdle(id: string): Promise<void> {
  const r = rt(id);
  if (r.status !== "running" && r.status !== "queued") return Promise.resolve();
  return new Promise((resolve) => r.idleWaiters.push(resolve));
}

/** Stop, re-provision packages/settings from the profile, and start again. */
export async function reprovision(id: string, log: (l: string) => void, { start = true } = {}) {
  const inst = getInstance(id);
  const profile = getProfile(inst.profile);
  const wasRunning = start && (inst.desired === "running" || !!rt(inst.id).rpc);
  await stopInstance(inst.id, false);
  setStatus(inst.id, "updating");
  try {
    const installed = await provisionInstance(inst, profile, log);
    store.update("instance", inst.id, { installed, configHash: configHash(inst, profile), lastError: undefined });
  } catch (err) {
    store.update("instance", inst.id, { lastError: (err as Error).message });
    setStatus(inst.id, "error");
    throw err;
  }
  setStatus(inst.id, "stopped");
  if (wasRunning) {
    store.update("instance", inst.id, { desired: "running" });
    await startInstance(inst.id);
  }
}

function afterSettle(id: string) {
  const r = rt(id);
  const pending = r.pendingRestart;
  if (!pending) return;
  r.pendingRestart = undefined;
  const work = pending.reprovision ? reprovision(id, () => {}) : restartInstance(id);
  work.catch((e) => store.update("instance", id, { lastError: String(e) }));
}

/**
 * Roll a set of instances onto their current config. Idle instances go now,
 * busy ones after their current run settles. Runs `parallel` at a time.
 */
export function rollout(ids: string[], reason: string, { reprovision: doProvision = true, parallel = 2 } = {}) {
  return startJob("rollout", `Rollout ${ids.length} instance(s): ${reason}`, async (ctx) => {
    await pool(ids, parallel, async (id) => {
      const inst = store.get("instance", id);
      if (!inst) return;
      const r = rt(id);
      if (r.status === "running") {
        ctx.log(`[${inst.name}] busy — will update after current run settles`);
        await waitForIdle(id);
      }
      ctx.log(`[${inst.name}] ${doProvision ? "re-provisioning" : "restarting"}`);
      try {
        if (doProvision) await reprovision(id, ctx.log, { start: inst.desired === "running" });
        else if (inst.desired === "running") await restartInstance(id);
        ctx.log(`[${inst.name}] ✓ done`);
      } catch (e) {
        ctx.log(`[${inst.name}] ✗ ${(e as Error).message}`);
      }
    });
  });
}

// ------------------------------------------------------------ create / delete

export interface CreateSpec {
  profile: string;
  count?: number;
  namePrefix?: string;
  names?: string[];
  cwd?: string;
  model?: string;
  deployment?: string;
  cluster?: string;
  start?: boolean;
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Create instance records now; provision + start them in a background job. */
export function createInstances(spec: CreateSpec, ctx?: JobCtx) {
  const profile = getProfile(spec.profile);
  const count = Math.max(1, Math.min(200, spec.count ?? spec.names?.length ?? 1));
  const taken = new Set(store.list("instance").map((i) => i.name));
  const prefix = spec.namePrefix ?? spec.cluster ?? profile.id;
  const created: Instance[] = [];
  for (let n = 0; n < count; n++) {
    const name = spec.names?.[n] ?? uniqueName(`${prefix}-${n + 1}`, taken);
    if (!ID_RE.test(name)) throw new Error(`Invalid instance name: ${name}`);
    if (taken.has(name)) throw new Error(`Instance name already exists: ${name}`);
    taken.add(name);
    const inst: Instance = {
      id: name,
      name,
      profile: profile.id,
      deployment: spec.deployment,
      cluster: spec.cluster,
      cwd: spec.cwd || undefined,
      model: spec.model || undefined,
      extraPackages: [],
      installed: [],
      desired: spec.start === false ? "stopped" : "running",
      repoShas: {},
      createdAt: new Date().toISOString(),
    };
    store.put("instance", inst.id, inst);
    rt(inst.id).status = "updating";
    created.push(inst);
    emitInstance(inst.id);
  }
  const run = async (c: JobCtx) => {
    await pool(created, 4, async (inst) => {
      try {
        await reprovision(inst.id, c.log, { start: false });
        if (inst.desired === "running") await startInstance(inst.id);
        c.log(`[${inst.name}] ✓ ready`);
      } catch (e) {
        c.log(`[${inst.name}] ✗ ${(e as Error).message}`);
      }
    });
  };
  if (ctx) return { instances: created, done: run(ctx) };
  const job = startJob("create", `Create ${count} × ${profile.id}`, run);
  return { instances: created, job, done: Promise.resolve() };
}

export async function deleteInstance(id: string) {
  const inst = getInstance(id);
  await stopInstance(inst.id);
  runtimes.delete(inst.id);
  fs.rmSync(instancePaths(inst.id).dir, { recursive: true, force: true });
  store.delete("instance", inst.id);
  publish({ topic: "instance-removed", id: inst.id });
}

/** Add/remove/replace a package with instance scope, then roll the instance. */
export function setInstanceExtraPackages(id: string, extra: PackageEntry[]) {
  const inst = getInstance(id);
  store.update("instance", inst.id, { extraPackages: extra });
}

// ------------------------------------------------------------ commands

export async function rpcCall(id: string, cmd: Record<string, unknown>, timeoutMs?: number): Promise<RpcResponse> {
  const inst = getInstance(id);
  const r = rt(inst.id);
  if (!r.rpc || r.rpc.exited) return { type: "response", command: String(cmd.type), success: false, error: "instance not running" };
  return r.rpc.send(cmd, timeoutMs);
}

/**
 * Send a prompt honoring the global concurrency cap. If the instance is already
 * mid-run it goes straight to pi (which queues it itself).
 */
export async function sendPrompt(id: string, message: string): Promise<{ ok: boolean; disposition?: string; error?: string }> {
  const inst = getInstance(id);
  const r = rt(inst.id);
  if (!r.rpc || r.rpc.exited) return { ok: false, error: "instance not running" };
  const cmd = { type: "prompt", message };
  if (r.status !== "running" && running.size >= loadConfig().maxConcurrent) {
    promptQueue.push({ id: inst.id, cmd });
    setStatus(inst.id, "queued");
    return { ok: true, disposition: "queued-by-fruity-pi" };
  }
  return dispatch(inst.id, cmd);
}

async function dispatch(id: string, cmd: Record<string, unknown>) {
  running.add(id); // reserve the slot before pi replies
  const res = await rpcCall(id, cmd);
  const disposition = res.data?.disposition as string | undefined;
  if (!res.success || disposition === "handled") {
    if (rt(id).status !== "running") running.delete(id);
    if (rt(id).status === "queued") setStatus(id, "idle");
  }
  if (!res.success) appendEvent(id, { type: "fp_error", command: cmd.type, error: res.error });
  return { ok: res.success, disposition, error: res.error };
}

function drainQueue() {
  const max = loadConfig().maxConcurrent;
  while (promptQueue.length && running.size < max) {
    const next = promptQueue.shift()!;
    const r = rt(next.id);
    if (!r.rpc || r.rpc.exited) continue;
    void dispatch(next.id, next.cmd);
  }
}

export async function collectLastText(id: string) {
  const res = await rpcCall(id, { type: "get_last_assistant_text" });
  return res.success ? ((res.data?.text as string | null | undefined) ?? null) : null;
}

// ------------------------------------------------------------ boot / shutdown

export async function bootInstances() {
  const insts = store.list("instance").filter((i) => i.desired === "running");
  await pool(insts, 4, (i) => startInstance(i.id).catch((e) => store.update("instance", i.id, { lastError: String(e) })));
}

export async function shutdownAll() {
  await Promise.all(
    [...runtimes.entries()].map(async ([, r]) => {
      if (r.rpc && !r.rpc.exited) {
        r.stopping = true;
        await r.rpc.stop(3000);
      }
    }),
  );
}

export function requestRestartWhenIdle(id: string, reprovisionNeeded: boolean) {
  const r = rt(id);
  if (r.status === "running") r.pendingRestart = { reprovision: reprovisionNeeded || !!r.pendingRestart?.reprovision };
  else {
    const work = reprovisionNeeded ? reprovision(id, () => {}) : restartInstance(id);
    work.catch((e) => store.update("instance", id, { lastError: String(e) }));
  }
  emitInstance(id);
}
