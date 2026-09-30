import fs from "node:fs";
import crypto from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { paths, ensureDir } from "./paths.js";
import { loadConfig, saveConfig, safeConfig, saveSecrets, refreshRedactor, randomToken } from "./config.js";
import * as auth from "./auth.js";
import { audit, readAudit } from "./audit.js";
import { bus } from "./bus.js";
import { store } from "./store.js";
import { saveProfile, getProfile, packageIdentity, packageSource, THINKING } from "./profiles.js";
import * as sup from "./supervisor.js";
import { resolveSelector } from "./selectors.js";
import * as repos from "./repos.js";
import * as deploy from "./deploy.js";
import * as pkgs from "./packages.js";
import { startJob, listJobs, getJob, pool } from "./jobs.js";
import { attachShell } from "./shell.js";
import * as system from "./system.js";
import type { Instance, PackageEntry } from "./types.js";

const COOKIE = "fp_session";

declare module "fastify" {
  interface FastifyRequest {
    session?: { token: string; csrf: string };
    rawBody?: string;
  }
}

/** Token for the local CLI, created on first use. Readable only by the owning user. */
export function cliToken(): string {
  const file = `${paths.root}/cli.token`;
  ensureDir(paths.root);
  if (!fs.existsSync(file)) fs.writeFileSync(file, randomToken(32) + "\n", { mode: 0o600 });
  return fs.readFileSync(file, "utf8").trim();
}

function isLoopback(host: string) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const bad = (msg: string) => new HttpError(400, msg);

export async function buildServer() {
  const cfg = loadConfig();
  refreshRedactor();

  // Inside a container the server must bind 0.0.0.0 on the container network; the
  // operator is then responsible for publishing the port on host loopback only.
  const containerBind = process.env.FRUITY_PI_CONTAINER === "1";
  if (!isLoopback(cfg.host) && !containerBind) {
    if (!cfg.allowRemote) throw new Error(`Refusing to bind ${cfg.host}: set "allowRemote": true in ${paths.config} (TLS is then required)`);
    if (!cfg.tls || !fs.existsSync(cfg.tls.cert) || !fs.existsSync(cfg.tls.key)) {
      throw new Error(`Refusing to bind ${cfg.host} without TLS: configure "tls": {"cert","key"} in ${paths.config} (install.sh --remote can generate one)`);
    }
  }
  if (containerBind && !isLoopback(cfg.host)) {
    console.warn(`⚠ container mode: listening on ${cfg.host}:${cfg.port} inside the container. Publish it on host loopback only (-p 127.0.0.1:${cfg.port}:${cfg.port}) or put TLS in front.`);
  }
  const useTls = !!(cfg.tls && fs.existsSync(cfg.tls.cert) && fs.existsSync(cfg.tls.key));

  const opts: Record<string, unknown> = {
    logger: { level: process.env.FRUITY_PI_LOG ?? "warn" },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
    ...(useTls ? { https: { cert: fs.readFileSync(cfg.tls!.cert), key: fs.readFileSync(cfg.tls!.key) } } : {}),
  };
  const app = Fastify(opts) as unknown as FastifyInstance;

  // Keep the raw body (needed for webhook HMAC verification).
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(bad("Invalid JSON"), undefined);
    }
  });

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  // One-time setup token if no admin password exists yet (e.g. started without install.sh).
  let setupToken: string | undefined;
  if (!cfg.auth.passwordHash) {
    setupToken = randomToken(18);
    console.log(`\n  🍓 fruity-pi first-run setup token: ${setupToken}\n     Enter it in the web UI to set the admin password.\n`);
  }

  // ---------------- security headers
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    );
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    if (useTls) reply.header("Strict-Transport-Security", "max-age=31536000");
    return payload;
  });

  app.setErrorHandler((err: any, _req, reply) => {
    const status = err instanceof HttpError ? err.status : (err.statusCode ?? (err.validation ? 400 : 400));
    reply.status(status).send({ error: err.message ?? String(err) });
  });

  // ---------------- auth gate
  const PUBLIC = new Set(["/api/auth/me", "/api/auth/login", "/api/auth/setup", "/api/hooks/github"]);

  function originOk(req: FastifyRequest) {
    const origin = req.headers.origin;
    if (!origin) return true; // same-origin GETs / non-browser clients
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0];
    if (!url.startsWith("/api/") && !url.startsWith("/ws")) return;
    if (PUBLIC.has(url)) return;
    // Local CLI: bearer token from ~/.fruity-pi/cli.token (0600). Not a browser, so no CSRF/origin concerns.
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (bearer && !url.startsWith("/ws")) {
      if (auth.safeEqual(bearer, cliToken())) {
        req.session = { token: "cli", csrf: "" };
        return;
      }
      return reply.status(401).send({ error: "unauthorized" });
    }
    const s = auth.getSession(req.cookies[COOKIE]);
    if (!s) return reply.status(401).send({ error: "unauthorized" });
    req.session = s;
    if (!originOk(req)) return reply.status(403).send({ error: "bad origin" });
    if (url.startsWith("/ws")) return;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const t = req.headers["x-csrf-token"];
      if (typeof t !== "string" || !auth.safeEqual(t, s.csrf)) return reply.status(403).send({ error: "bad csrf token" });
    }
  });

  const ip = (req: FastifyRequest) => req.ip;

  function setSessionCookie(reply: FastifyReply, token: string) {
    reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: "strict", secure: useTls, path: "/", maxAge: 7 * 24 * 3600 });
  }

  // ---------------- auth routes
  app.get("/api/auth/me", async (req) => {
    const s = auth.getSession(req.cookies[COOKIE]);
    const c = loadConfig();
    return { authed: !!s, csrf: s?.csrf, needsSetup: !c.auth.passwordHash, totp: c.auth.totpEnabled };
  });

  app.post("/api/auth/setup", async (req, reply) => {
    const { token, password } = (req.body ?? {}) as any;
    if (loadConfig().auth.passwordHash || !setupToken) throw new HttpError(409, "Already set up");
    if (auth.lockoutRemaining(ip(req))) throw new HttpError(429, "Too many attempts, wait a bit");
    if (typeof token !== "string" || !auth.safeEqual(token, setupToken)) {
      auth.recordFailure(ip(req));
      audit("auth.setup-failed", {}, ip(req));
      throw new HttpError(401, "Wrong setup token (see the server console)");
    }
    auth.setPassword(String(password ?? ""));
    setupToken = undefined;
    const s = auth.createSession(ip(req));
    setSessionCookie(reply, s.token);
    audit("auth.setup", {}, ip(req));
    return { ok: true, csrf: s.csrf };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const { password, totp } = (req.body ?? {}) as any;
    const wait = auth.lockoutRemaining(ip(req));
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s`);
    const c = loadConfig();
    const ok = auth.verifyPassword(String(password ?? ""), c.auth.passwordHash) && (!c.auth.totpEnabled || auth.verifyTotp(c.auth.totpSecret, totp));
    if (!ok) {
      auth.recordFailure(ip(req));
      audit("auth.login-failed", {}, ip(req));
      throw new HttpError(401, c.auth.totpEnabled ? "Wrong password or 2FA code" : "Wrong password");
    }
    auth.recordSuccess(ip(req));
    const s = auth.createSession(ip(req));
    setSessionCookie(reply, s.token);
    audit("auth.login", {}, ip(req));
    return { ok: true, csrf: s.csrf };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    auth.destroySession(req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: "/" });
    audit("auth.logout", {}, ip(req));
    return { ok: true };
  });

  const requirePassword = (req: FastifyRequest, password: unknown) => {
    if (auth.lockoutRemaining(ip(req))) throw new HttpError(429, "Too many attempts");
    if (!auth.verifyPassword(String(password ?? ""), loadConfig().auth.passwordHash)) {
      auth.recordFailure(ip(req));
      throw new HttpError(401, "Wrong password");
    }
  };

  // ---------------- state
  app.get("/api/state", async () => ({
    instances: sup.listInstances(),
    profiles: store.list("profile"),
    repos: store.list("repo"),
    deployments: store.list("deployment").map((d) => ({ ...d, plan: safePlan(d) })),
    stats: sup.stats(),
    config: safeConfig(),
    jobs: listJobs().slice(0, 30),
  }));

  function safePlan(d: Parameters<typeof deploy.planDeployment>[0]) {
    try {
      return deploy.planDeployment(d);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  // ---------------- profiles
  app.put("/api/profiles/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = { ...(req.body as object), id };
    const p = saveProfile(body);
    audit("profile.save", { profile: id }, ip(req));
    bus.emit("msg", { topic: "state" });
    return p;
  });

  app.delete("/api/profiles/:id", async (req) => {
    const { id } = req.params as { id: string };
    const users = store.list("instance").filter((i) => i.profile === id);
    if (users.length) throw bad(`Profile in use by ${users.length} instance(s)`);
    const deps = store.list("deployment").filter((d) => d.groups.some((g) => g.profile === id));
    if (deps.length) throw bad(`Profile used by deployment(s): ${deps.map((d) => d.name).join(", ")}`);
    store.delete("profile", id);
    audit("profile.delete", { profile: id }, ip(req));
    bus.emit("msg", { topic: "state" });
    return { ok: true };
  });

  app.post("/api/profiles/:id/rollout", async (req) => {
    const { id } = req.params as { id: string };
    const ids = store.list("instance").filter((i) => i.profile === id).map((i) => i.id);
    audit("profile.rollout", { profile: id, instances: ids.length }, ip(req));
    return { job: sup.rollout(ids, `profile ${id}`) };
  });

  // ---------------- instances
  app.post("/api/instances", async (req) => {
    const b = (req.body ?? {}) as any;
    const res = sup.createInstances({
      profile: String(b.profile ?? ""),
      count: Number(b.count ?? 1),
      namePrefix: b.namePrefix || undefined,
      cwd: b.cwd || undefined,
      model: b.model || undefined,
      cluster: b.cluster || undefined,
      start: b.start !== false,
    });
    audit("instances.create", { profile: b.profile, count: res.instances.length, cluster: b.cluster }, ip(req));
    return { instances: res.instances.map((i) => i.id), job: res.job };
  });

  app.get("/api/instances/:id", async (req) => {
    const inst = sup.getInstance((req.params as any).id);
    return { instance: sup.instanceView(inst), command: sup.interactiveCommand(inst) };
  });

  app.get("/api/instances/:id/events", async (req) => {
    const inst = sup.getInstance((req.params as any).id);
    const tail = Math.min(5000, Number((req.query as any).tail ?? 1000));
    return { events: sup.readEvents(inst.id, tail) };
  });

  app.get("/api/instances/:id/commands", async (req) => {
    const res = await sup.rpcCall((req.params as any).id, { type: "get_commands" });
    if (!res.success) throw bad(res.error ?? "failed");
    return res.data;
  });

  app.get("/api/instances/:id/state", async (req) => {
    const res = await sup.rpcCall((req.params as any).id, { type: "get_state" });
    if (!res.success) throw bad(res.error ?? "failed");
    return res.data;
  });

  app.post("/api/instances/:id/:op", async (req) => {
    const { id, op } = req.params as { id: string; op: string };
    const inst = sup.getInstance(id);
    audit(`instance.${op}`, { instance: inst.name }, ip(req));
    switch (op) {
      case "start":
        store.update("instance", inst.id, { desired: "running" });
        await sup.startInstance(inst.id);
        return { ok: true };
      case "stop":
        await sup.stopInstance(inst.id);
        return { ok: true };
      case "restart":
        await sup.restartInstance(inst.id);
        return { ok: true };
      case "reprovision":
        return { job: sup.rollout([inst.id], `reprovision ${inst.name}`) };
      case "delete":
        await sup.deleteInstance(inst.id);
        return { ok: true };
      default:
        throw bad(`Unknown operation ${op}`);
    }
  });

  // ---------------- fan-out commands
  app.post("/api/send", async (req) => {
    const b = (req.body ?? {}) as any;
    const targets = resolveSelector(b.selector, b.ids);
    if (!targets.length) throw bad("Selector matched no instances");
    const action = String(b.action ?? "prompt");
    const message = typeof b.message === "string" ? b.message : "";
    audit("send", { action, selector: b.selector ?? `${b.ids?.length ?? 0} ids`, targets: targets.length, message: message.slice(0, 500) }, ip(req));
    const one = async (inst: Instance) => {
      switch (action) {
        case "prompt":
          if (!message.trim()) throw bad("message is required");
          return sup.sendPrompt(inst.id, message);
        case "steer":
        case "follow_up":
          if (!message.trim()) throw bad("message is required");
          return wrap(await sup.rpcCall(inst.id, { type: action, message }));
        case "abort":
          return wrap(await sup.rpcCall(inst.id, { type: "abort" }, 60_000));
        case "new_session":
          return wrap(await sup.rpcCall(inst.id, { type: "new_session" }));
        case "compact":
          return wrap(await sup.rpcCall(inst.id, { type: "compact", ...(message ? { customInstructions: message } : {}) }, 300_000));
        case "set_model": {
          const [provider, ...rest] = String(b.model ?? "").split("/");
          if (!provider || !rest.length) throw bad("model must be provider/modelId");
          return wrap(await sup.rpcCall(inst.id, { type: "set_model", provider, modelId: rest.join("/") }));
        }
        case "set_thinking":
          if (!THINKING.includes(b.level)) throw bad("invalid thinking level");
          return wrap(await sup.rpcCall(inst.id, { type: "set_thinking_level", level: b.level }));
        case "start":
          store.update("instance", inst.id, { desired: "running" });
          await sup.startInstance(inst.id);
          return { ok: true };
        case "stop":
          await sup.stopInstance(inst.id);
          return { ok: true };
        case "restart":
          await sup.restartInstance(inst.id);
          return { ok: true };
        default:
          throw bad(`Unknown action ${action}`);
      }
    };
    const results = await pool(targets, 16, async (inst) => {
      try {
        return { id: inst.id, name: inst.name, ...(await one(inst)) };
      } catch (e) {
        if (e instanceof HttpError) throw e;
        return { id: inst.id, name: inst.name, ok: false, error: (e as Error).message };
      }
    });
    return { action, results };
  });

  const wrap = (r: { success: boolean; error?: string; data?: any }) => ({ ok: r.success, error: r.error, disposition: r.data?.disposition });

  app.post("/api/collect", async (req) => {
    const b = (req.body ?? {}) as any;
    const targets = resolveSelector(b.selector, b.ids);
    const results = await pool(targets, 16, async (inst) => ({
      id: inst.id,
      name: inst.name,
      cluster: inst.cluster,
      status: sup.instanceView(inst).status,
      text: await sup.collectLastText(inst.id),
    }));
    return { results };
  });

  app.post("/api/resolve", async (req) => {
    const b = (req.body ?? {}) as any;
    return { ids: resolveSelector(b.selector, b.ids).map((i) => i.id) };
  });

  // ---------------- repos
  app.post("/api/repos", async (req) => {
    const repo = await repos.addRepo((req.body ?? {}) as any);
    audit("repo.add", { repo: repo.id, url: repo.url, ref: repo.ref }, ip(req));
    const job = startJob("repo", `Fetch ${repo.id}`, (ctx) => repos.checkRepo(repo.id, ctx.log, { force: true }));
    return { repo, job };
  });

  app.put("/api/repos/:id", async (req) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as any;
    const repo = repos.updateRepoSettings(id, { ref: b.ref, mode: b.mode, pollSeconds: b.pollSeconds, subdir: b.subdir });
    audit("repo.update", { repo: id, ...b }, ip(req));
    const job = startJob("repo", `Update ${id}`, (ctx) => repos.checkRepo(id, ctx.log, { force: true }));
    return { repo, job };
  });

  app.delete("/api/repos/:id", async (req) => {
    const { id } = req.params as { id: string };
    repos.deleteRepo(id);
    audit("repo.delete", { repo: id }, ip(req));
    return { ok: true };
  });

  app.post("/api/repos/:id/check", async (req) => {
    const { id } = req.params as { id: string };
    return { job: startJob("repo", `Check ${id}`, (ctx) => repos.checkRepo(id, ctx.log)) };
  });

  app.post("/api/repos/:id/rollback", async (req) => {
    const { id } = req.params as { id: string };
    const sha = String(((req.body ?? {}) as any).sha ?? "");
    return { job: startJob("repo", `Roll back ${id} to ${sha.slice(0, 10)}`, (ctx) => repos.rollbackRepo(id, sha, ctx.log)) };
  });

  app.post("/api/hooks/github", async (req, reply) => {
    const secret = loadConfig().webhookSecret;
    if (!secret) return reply.status(404).send({ error: "webhook not configured" });
    const sig = String(req.headers["x-hub-signature-256"] ?? "");
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody ?? "").digest("hex");
    if (!auth.safeEqual(sig, expected)) {
      audit("webhook.bad-signature", {}, ip(req));
      return reply.status(401).send({ error: "bad signature" });
    }
    const event = req.headers["x-github-event"];
    if (event === "ping") return { ok: true };
    if (event !== "push") return { ignored: event };
    const hit = repos.onGithubPush(req.body);
    audit("webhook.push", { repos: hit }, ip(req));
    return { checking: hit };
  });

  // ---------------- deployments
  app.get("/api/deployments/example", async () => ({ yaml: deploy.EXAMPLE_SPEC }));

  app.post("/api/deployments/plan", async (req) => {
    const yaml = String(((req.body ?? {}) as any).yaml ?? "");
    const spec = deploy.parseSpec(yaml);
    return { spec, steps: deploy.planDeployment(spec) };
  });

  app.put("/api/deployments", async (req) => {
    const b = (req.body ?? {}) as any;
    const dep = deploy.saveDeployment(String(b.yaml ?? ""));
    audit("deployment.save", { deployment: dep.name }, ip(req));
    if (b.apply) return { deployment: dep, ...deploy.applyDeployment(dep.name, ip(req)) };
    return { deployment: dep, steps: deploy.planDeployment(dep) };
  });

  app.post("/api/deployments/:name/apply", async (req) => deploy.applyDeployment((req.params as any).name, ip(req)));

  app.delete("/api/deployments/:name", async (req) => ({ job: deploy.deleteDeployment((req.params as any).name, ip(req)) }));

  // ---------------- packages
  app.get("/api/packages/search", async (req) => {
    const q = String((req.query as any).q ?? "").slice(0, 200);
    return pkgs.searchPackages(q, Number((req.query as any).from ?? 0));
  });

  app.get("/api/packages/info", async (req) => pkgs.packageInfo(String((req.query as any).name ?? "")));

  app.post("/api/packages/preview", async (req) => pkgs.previewSource(String(((req.body ?? {}) as any).source ?? "").trim()));

  app.get("/api/packages/installed", async () => {
    const instances = store.list("instance");
    const byIdentity = new Map<string, any>();
    for (const inst of instances) {
      const profile = store.get("profile", inst.profile);
      const extraIds = new Set(inst.extraPackages.map((p) => packageIdentity(packageSource(p))));
      for (const p of pkgs.listInstalled(inst, profile)) {
        let row = byIdentity.get(p.identity);
        if (!row) {
          row = { identity: p.identity, source: p.source, name: p.name, version: p.version, description: p.description, tracked: p.tracked, runsCode: p.runsCode, resources: p.resources, instances: {} };
          byIdentity.set(p.identity, row);
        }
        if (!row.name && p.name) Object.assign(row, { name: p.name, version: p.version, description: p.description, resources: p.resources });
        row.instances[inst.id] = {
          source: p.source,
          version: p.version,
          installed: !!p.dir,
          origin: p.tracked ? "repo" : extraIds.has(p.identity) ? "instance" : "profile",
          resources: p.resources,
          enabledCount: p.resources.filter((r) => r.enabled).length,
        };
      }
    }
    return {
      instances: instances.map((i) => ({ id: i.id, name: i.name, cluster: i.cluster, profile: i.profile, deployment: i.deployment })),
      packages: [...byIdentity.values()],
      profiles: store.list("profile").map((p) => ({ id: p.id, packages: p.packages, repos: p.repos })),
    };
  });

  app.post("/api/packages/action", async (req) => {
    const b = (req.body ?? {}) as any;
    const action = String(b.action ?? "");
    const source = String(b.source ?? "").trim();
    const scope = b.scope ?? {};
    if (!["install", "remove", "update", "toggle"].includes(action)) throw bad("action must be install|remove|update|toggle");
    if (!source) throw bad("source is required");
    if (action === "install" && !/^(npm:|git:|https?:\/\/|ssh:\/\/|\/|~\/)/.test(source)) throw bad("source must start with npm:, git:, https://, ssh://, / or ~/");
    const identity = source.startsWith("repo:") ? source : packageIdentity(source);
    audit("packages.action", { action, source, scope, resource: b.resourcePath, enabled: b.enabled }, ip(req));

    const edit = (list: PackageEntry[]): PackageEntry[] => {
      const idx = list.findIndex((p) => packageIdentity(packageSource(p)) === identity);
      if (action === "install") {
        const entry = idx >= 0 && typeof list[idx] !== "string" ? { ...(list[idx] as object), source } : source;
        return idx >= 0 ? list.map((p, i) => (i === idx ? (entry as PackageEntry) : p)) : [...list, source];
      }
      if (action === "remove") return list.filter((_, i) => i !== idx);
      if (action === "toggle") {
        if (idx < 0) throw bad("Package not found at this scope");
        return list.map((p, i) => (i === idx ? pkgs.toggleResource(p, b.resourceType, String(b.resourcePath), !!b.enabled) : p));
      }
      return list;
    };

    if (scope.kind === "profile") {
      const profile = getProfile(String(scope.value));
      if (action !== "update") saveProfile({ ...profile, packages: edit(profile.packages) });
      const ids = store.list("instance").filter((i) => i.profile === profile.id).map((i) => i.id);
      if (action === "update") return { job: updateJob(ids, source) };
      bus.emit("msg", { topic: "state" });
      return { job: sup.rollout(ids, `${action} ${source} on profile ${profile.id}`) };
    }

    const targets = resolveSelector(scope.kind === "selector" ? scope.value : scope.kind === "all" ? "all" : `${scope.kind}:${scope.value}`, scope.ids);
    if (!targets.length) throw bad("Scope matched no instances");
    if (action === "update") return { job: updateJob(targets.map((t) => t.id), source) };
    const skipped: string[] = [];
    const skippedIds = new Set<string>();
    for (const inst of targets) {
      const profile = store.get("profile", inst.profile);
      const trackedPath = profile?.repos
        .map((rid) => store.get("repo", rid))
        .find((r) => r && r.kind !== "skills" && pkgs.repoLoadPath(r) === source);
      const inProfile = profile?.packages.find((p) => packageIdentity(packageSource(p)) === identity) ?? (trackedPath ? source : undefined);
      let extra = inst.extraPackages;
      if (action === "remove" && inProfile && !extra.some((p) => packageIdentity(packageSource(p)) === identity)) {
        skipped.push(`${inst.name} (comes from ${trackedPath ? "tracked repo" : "profile"} ${trackedPath ? trackedPath.id : inst.profile})`);
        skippedIds.add(inst.id);
        continue;
      }
      if (action === "toggle" && !extra.some((p) => packageIdentity(packageSource(p)) === identity)) {
        if (!inProfile) {
          skipped.push(`${inst.name} (not installed)`);
          skippedIds.add(inst.id);
          continue;
        }
        extra = [...extra, inProfile]; // copy profile entry as an instance-level override
      }
      sup.setInstanceExtraPackages(inst.id, edit(extra));
    }
    const ids = targets.map((t) => t.id).filter((id) => !skippedIds.has(id));
    return { skipped, job: ids.length ? sup.rollout(ids, `${action} ${source}`) : undefined };
  });

  function updateJob(ids: string[], source: string) {
    return startJob("packages", `Update ${source} on ${ids.length} instance(s)`, async (ctx) => {
      await pool(ids, 4, async (id) => {
        const inst = store.get("instance", id);
        if (!inst) return;
        try {
          await sup.waitForIdle(id);
          await pkgs.updateInstancePackages(inst, getProfile(inst.profile), ctx.log, source.startsWith("repo:") ? undefined : source);
          if (inst.desired === "running") await sup.restartInstance(id);
          ctx.log(`[${inst.name}] ✓ updated`);
        } catch (e) {
          ctx.log(`[${inst.name}] ✗ ${(e as Error).message}`);
        }
      });
    });
  }

  // ---------------- jobs
  app.get("/api/jobs", async () => ({ jobs: listJobs() }));
  app.get("/api/jobs/:id", async (req) => {
    const j = getJob((req.params as any).id);
    if (!j) throw new HttpError(404, "no such job");
    return j;
  });

  // ---------------- system
  app.get("/api/system", async () => ({ ...(await system.systemStatus()), audit: readAudit(100) }));
  app.get("/api/system/latest-pi", async () => ({ latest: await system.latestPiVersion() }));
  app.get("/api/system/disk", async () => system.diskUsage());
  app.post("/api/system/upgrade-pi", async (req) => ({ job: system.upgradePi(String(((req.body ?? {}) as any).version ?? "latest"), ip(req)) }));

  app.post("/api/system/secrets", async (req) => {
    const b = (req.body ?? {}) as Record<string, string | null>;
    saveSecrets(b);
    audit("system.secrets", { keys: Object.keys(b), removed: Object.entries(b).filter(([, v]) => !v).map(([k]) => k) }, ip(req));
    return { ok: true, note: "Restart instances to pick up changed keys" };
  });

  app.post("/api/system/settings", async (req) => {
    const b = (req.body ?? {}) as any;
    const patch: any = {};
    if (b.maxConcurrent != null) {
      const n = Number(b.maxConcurrent);
      if (!Number.isInteger(n) || n < 1 || n > 256) throw bad("maxConcurrent must be 1–256");
      patch.maxConcurrent = n;
    }
    if (b.recordShell != null) patch.recordShell = !!b.recordShell;
    saveConfig(patch);
    audit("system.settings", patch, ip(req));
    return safeConfig();
  });

  app.post("/api/system/shell", async (req) => {
    const b = (req.body ?? {}) as any;
    const c = loadConfig();
    if (b.enabled) {
      if (c.shellLocked) throw new HttpError(403, `Shell is locked in ${paths.config} (shellLocked: true)`);
      requirePassword(req, b.password);
    }
    saveConfig({ shellEnabled: !!b.enabled });
    audit(b.enabled ? "shell.enabled" : "shell.disabled", {}, ip(req));
    return safeConfig();
  });

  app.post("/api/system/webhook", async (req) => {
    requirePassword(req, ((req.body ?? {}) as any).password);
    const secret = randomToken(24);
    saveConfig({ webhookSecret: secret });
    audit("system.webhook-secret", {}, ip(req));
    return { secret, url: "/api/hooks/github" };
  });

  app.post("/api/system/password", async (req, reply) => {
    const b = (req.body ?? {}) as any;
    requirePassword(req, b.current);
    auth.setPassword(String(b.next ?? ""));
    audit("auth.password-changed", {}, ip(req));
    const s = auth.createSession(ip(req));
    setSessionCookie(reply, s.token);
    return { ok: true, csrf: s.csrf };
  });

  let pendingTotp: string | undefined;
  app.post("/api/system/totp/setup", async (req) => {
    requirePassword(req, ((req.body ?? {}) as any).password);
    pendingTotp = auth.newTotpSecret();
    return { secret: pendingTotp, uri: `otpauth://totp/fruity-pi?secret=${pendingTotp}&issuer=fruity-pi` };
  });
  app.post("/api/system/totp/enable", async (req) => {
    const code = String(((req.body ?? {}) as any).code ?? "");
    if (!pendingTotp || !auth.verifyTotp(pendingTotp, code)) throw bad("Code does not match");
    const c = loadConfig();
    saveConfig({ auth: { ...c.auth, totpSecret: pendingTotp, totpEnabled: true } });
    pendingTotp = undefined;
    audit("auth.totp-enabled", {}, ip(req));
    return safeConfig();
  });
  app.post("/api/system/totp/disable", async (req) => {
    requirePassword(req, ((req.body ?? {}) as any).password);
    const c = loadConfig();
    saveConfig({ auth: { ...c.auth, totpSecret: undefined, totpEnabled: false } });
    audit("auth.totp-disabled", {}, ip(req));
    return safeConfig();
  });

  app.post("/api/system/cleanup", async (req) => {
    const removed = system.cleanup();
    audit("system.cleanup", { removed }, ip(req));
    return { removed };
  });

  // ---------------- websockets
  app.register(async (scope) => {
    scope.get("/ws", { websocket: true }, (socket) => {
      const handler = (msg: unknown) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };
      bus.on("msg", handler);
      socket.on("close", () => bus.off("msg", handler));
      socket.send(JSON.stringify({ topic: "hello" }));
    });

    scope.get("/ws/shell", { websocket: true }, (socket, req) => {
      const q = req.query as any;
      if (typeof q.csrf !== "string" || !auth.safeEqual(q.csrf, req.session!.csrf)) {
        socket.close(4403, "bad csrf");
        return;
      }
      try {
        attachShell(socket, { instanceId: q.instance || undefined, ip: req.ip, cols: Number(q.cols), rows: Number(q.rows) });
      } catch (e) {
        socket.close(4400, (e as Error).message.slice(0, 100));
      }
    });
  });

  // ---------------- static UI
  if (fs.existsSync(paths.webDist)) {
    await app.register(fastifyStatic, { root: paths.webDist, index: ["index.html"], wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/ws")) return reply.status(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  } else {
    app.get("/", async () => "fruity-pi API is running. Build the UI with `npm run build:web`.");
  }

  return { app, cfg, useTls };
}
