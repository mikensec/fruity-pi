/**
 * End-to-end test against a real fruity-pi server, real pi processes and a fake LLM.
 *   tsx test/e2e.ts
 * Covers: isolation, deployments, fan-out prompts, repo auto-update rollout,
 * concurrency cap, package toggles, auth/CSRF/origin checks, restart + resume.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "fruity-e2e-"));
const HOME = path.join(ROOT, "fp");
const PORT = 7788;
const LLM_PORT = 7799;
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, FRUITY_PI_HOME: HOME, FRUITY_PI_LOG: "error" };
const tsx = path.resolve("node_modules/.bin/tsx");
const procs: ChildProcess[] = [];

function log(...a: unknown[]) {
  console.log("•", ...a);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const p = spawn(tsx, ["src/cli.ts", "serve"], { env: { ...env, FRUITY_PI_PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout!.on("data", (d) => process.env.E2E_VERBOSE && process.stdout.write(`[srv] ${d}`));
  p.stderr!.on("data", (d) => process.stderr.write(`[srv:err] ${d}`));
  procs.push(p);
  return p;
}

let token = "";
async function api(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(BASE + route, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${method} ${route} → ${res.status} ${data.error}`), { status: res.status });
  return data;
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false>, timeoutMs = 120_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${what}${last ? `: ${last}` : ""}`);
}

const waitJob = (id: string) => waitFor(`job ${id}`, async () => {
  const j = await api("GET", `/api/jobs/${id}`);
  if (j.status === "failed") throw new Error(`job failed: ${j.error}\n${j.log.join("\n")}`);
  return j.status === "done" && j;
});

async function instances() {
  return (await api("GET", "/api/state")).instances as any[];
}
const allIdle = (n: number) => waitFor(`${n} idle instances`, async () => {
  const insts = await instances();
  return insts.length === n && insts.every((i) => i.status === "idle") && insts;
});

function makeSkillRepo(dir: string, skills: string[]) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  for (const s of skills) {
    fs.mkdirSync(path.join(dir, "skills", s), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: The ${s} skill\n---\nDo ${s}.\n`);
  }
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
}

async function main() {
  // Fake LLM
  const llm = spawn(tsx, ["test/fake-llm.ts", String(LLM_PORT)], { stdio: "ignore" });
  procs.push(llm);

  // A pre-existing, stand-alone pi install ("the user's own pi") with a real conversation.
  const userPi = path.join(ROOT, "user-home", ".pi", "agent");
  const userProj = path.join(ROOT, "user-project");
  fs.mkdirSync(path.join(userPi, "skills", "my-own-skill"), { recursive: true });
  fs.mkdirSync(userProj, { recursive: true });
  fs.writeFileSync(path.join(userPi, "skills", "my-own-skill", "SKILL.md"), "---\nname: my-own-skill\ndescription: mine\n---\nmine\n");
  fs.writeFileSync(path.join(userPi, "AGENTS.md"), "Always be concise.\n");
  fs.writeFileSync(path.join(userPi, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${LLM_PORT}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "fake-model" }] } } }));
  fs.writeFileSync(path.join(userPi, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-model" }));
  await waitFor("fake llm", () => fetch(`http://127.0.0.1:${LLM_PORT}/stats`).then((r) => r.ok));
  execFileSync(process.execPath, [path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), "-p", "remember the word mango"], {
    cwd: userProj,
    env: { ...process.env, HOME: path.join(ROOT, "user-home"), PI_CODING_AGENT_DIR: userPi, PI_OFFLINE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const snapshot = (dir: string) => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else out.push(`${path.relative(dir, f)}:${fs.statSync(f).mtimeMs}:${fs.readFileSync(f).toString("base64")}`);
      }
    };
    walk(dir);
    return out.sort().join("\n");
  };
  const userPiBefore = snapshot(userPi);
  env.PI_CODING_AGENT_DIR = userPi; // the server sees the user's pi exactly like a normal login shell would

  // Config + password
  execFileSync(tsx, ["src/cli.ts", "init", "--password", "e2e-password-123"], { env });
  const cfgPath = path.join(HOME, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgPath, "utf8")), port: PORT }, null, 2));
  token = fs.readFileSync(path.join(HOME, "cli.token"), "utf8").trim();

  startServer();
  await waitFor("server", () => fetch(BASE + "/api/auth/me").then((r) => r.ok));
  log("server up");

  // ---- security basics
  const unauth = await fetch(BASE + "/api/state");
  assert.equal(unauth.status, 401, "unauthenticated request rejected");
  const login = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "e2e-password-123" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const { csrf } = (await login.json()) as any;
  const noCsrf = await fetch(BASE + "/api/system/cleanup", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
  assert.equal(noCsrf.status, 403, "POST without CSRF token rejected");
  const badOrigin = await fetch(BASE + "/api/state", { headers: { cookie, origin: "https://evil.example" } });
  assert.equal(badOrigin.status, 403, "foreign Origin rejected");
  const okCsrf = await fetch(BASE + "/api/system/cleanup", { method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: "{}" });
  assert.equal(okCsrf.status, 200, "POST with CSRF token accepted");
  const shellWhileDisabled = await fetch(BASE + "/api/system/shell", { method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ enabled: true, password: "nope" }) });
  assert.equal(shellWhileDisabled.status, 401, "enabling shell needs the password");
  log("auth / csrf / origin checks ok");

  // ---- tracked repos
  const repoA = path.join(ROOT, "repo-a");
  const repoB = path.join(ROOT, "repo-b");
  makeSkillRepo(repoA, ["alpha"]);
  makeSkillRepo(repoB, ["bravo"]);
  const ra = await api("POST", "/api/repos", { url: `file://${repoA}`, ref: "main", id: "skills-a", pollSeconds: 30 });
  const rb = await api("POST", "/api/repos", { url: `file://${repoB}`, ref: "main", id: "skills-b" });
  await waitJob(ra.job.id);
  await waitJob(rb.job.id);
  log("repos fetched");

  // ---- profiles pointing at the fake LLM
  const modelsJson = JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${LLM_PORT}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "fake-model" }] } } });
  await api("PUT", "/api/profiles/pa", { repos: ["skills-a"], model: "fake/fake-model", modelsJson });
  await api("PUT", "/api/profiles/pb", { repos: ["skills-b"], model: "fake/fake-model", modelsJson });

  // ---- deployment: 3 × a, 2 × b
  const yaml = `name: e2e\ngroups:\n  - cluster: a\n    profile: pa\n    replicas: 3\n  - cluster: b\n    profile: pb\n    replicas: 2\n`;
  const plan = await api("POST", "/api/deployments/plan", { yaml });
  assert.equal(plan.steps.filter((s: any) => s.op === "create").length, 5);
  const applied = await api("PUT", "/api/deployments", { yaml, apply: true });
  await waitJob(applied.job.id);
  await allIdle(5);
  log("deployment applied: 5 idle instances");

  // ---- isolation: each cluster only sees its own skills
  const cmdsA = await api("GET", "/api/instances/a-1/commands");
  const skillNames = (c: any) => c.commands.filter((x: any) => x.name.startsWith("skill:")).map((x: any) => x.name).sort();
  assert.deepEqual(skillNames(cmdsA), ["skill:alpha"]);
  assert.deepEqual(skillNames(await api("GET", "/api/instances/b-1/commands")), ["skill:bravo"]);
  assert.ok(!fs.existsSync(path.join(os.homedir(), ".pi", "agent", "sessions", "e2e")), "nothing written to the real ~/.pi");
  log("isolation ok (a sees alpha only, b sees bravo only)");

  // ---- fan-out prompt to a cluster + collect
  const sent = await api("POST", "/api/send", { selector: "cluster:a", action: "prompt", message: "hello cluster a" });
  assert.equal(sent.results.length, 3);
  assert.ok(sent.results.every((r: any) => r.ok), JSON.stringify(sent.results));
  await sleep(500);
  await allIdle(5);
  const col = await api("POST", "/api/collect", { selector: "cluster:a" });
  for (const r of col.results) assert.match(r.text ?? "", /ECHO: hello cluster a \| SKILLS: alpha/);
  const colB = await api("POST", "/api/collect", { selector: "cluster:b" });
  for (const r of colB.results) assert.equal(r.text, null, "cluster b was not prompted");
  log("fan-out prompt + collect ok");

  // ---- repo auto-update: push a new skill, all 'a' instances roll onto it
  fs.mkdirSync(path.join(repoA, "skills", "alpha2"), { recursive: true });
  fs.writeFileSync(path.join(repoA, "skills", "alpha2", "SKILL.md"), "---\nname: alpha2\ndescription: new\n---\nnew\n");
  execFileSync("git", ["-C", repoA, "add", "."]);
  execFileSync("git", ["-C", repoA, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "add alpha2"]);
  const newSha = execFileSync("git", ["-C", repoA, "rev-parse", "HEAD"]).toString().trim();
  await waitJob((await api("POST", "/api/repos/skills-a/check")).job.id);
  await waitFor("rollout to new sha", async () => {
    const insts = (await instances()).filter((i) => i.cluster === "a");
    return insts.every((i) => i.repoShas["skills-a"] === newSha && i.status === "idle");
  });
  assert.deepEqual(skillNames(await api("GET", "/api/instances/a-2/commands")), ["skill:alpha", "skill:alpha2"]);
  assert.deepEqual(skillNames(await api("GET", "/api/instances/b-2/commands")), ["skill:bravo"]);
  // Conversation survived the restart (--continue).
  const st = await api("GET", "/api/instances/a-1/state");
  assert.ok(st.messageCount >= 2, `session continued after rollout (messageCount=${st.messageCount})`);
  log("repo update rolled out; sessions continued");

  // ---- concurrency cap
  await api("POST", "/api/system/settings", { maxConcurrent: 2 });
  await fetch(`http://127.0.0.1:${LLM_PORT}/stats`); // warm
  const slow = await api("POST", "/api/send", { selector: "all", action: "prompt", message: "slow please" });
  assert.equal(slow.results.filter((r: any) => r.disposition === "queued-by-fruity-pi").length, 3, "3 of 5 queued");
  await sleep(500);
  await waitFor("all slow runs done", async () => (await instances()).every((i) => i.status === "idle"), 60_000);
  const stats: any = await (await fetch(`http://127.0.0.1:${LLM_PORT}/stats`)).json();
  assert.ok(stats.peak <= 2, `LLM saw at most 2 concurrent requests (peak ${stats.peak})`);
  log(`concurrency cap ok (peak ${stats.peak})`);

  // ---- agent API: tokens, scopes, human-only endpoints, send+wait, fpi client
  await api("POST", "/api/system/settings", { maxConcurrent: 8 });
  const mint = (name: string, extra: string[] = []) =>
    execFileSync(tsx, ["src/cli.ts", "token", "create", name, ...extra], { env }).toString().match(/FRUITY_PI_TOKEN=(fpi_\S+)/)![1];
  const full = mint("agent-full");
  const read = mint("agent-read", ["--read"]);
  const as = (tok: string, method: string, route: string, body?: unknown) =>
    fetch(BASE + route, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await fetch(BASE + "/api/agent")).status, 200, "discovery is public");
  assert.equal((await as(full, "GET", "/api/state")).status, 200);
  for (const [m, r, b] of [
    ["POST", "/api/tokens", { name: "x", password: "e2e-password-123" }],
    ["POST", "/api/system/shell", { enabled: true, password: "e2e-password-123" }],
    ["POST", "/api/system/secrets", { X: "y" }],
    ["POST", "/api/system/settings", { maxConcurrent: 1 }],
    ["GET", "/api/import/sessions", undefined],
  ] as const)
    assert.equal((await as(full, m, r, b)).status, 403, `${r} is human-only`);
  assert.equal((await as(read, "POST", "/api/send", { selector: "all", action: "abort" })).status, 403, "read token can't act");
  assert.equal((await as(read, "POST", "/api/collect", { selector: "all" })).status, 200, "read token can collect");
  const shellWs = await as(full, "GET", "/ws/shell");
  assert.equal(shellWs.status, 403, "no shell for tokens");
  const waited: any = await (await as(full, "POST", "/api/send", { selector: "cluster:b", action: "prompt", message: "waited hello", wait: true, timeout: 60 })).json();
  assert.equal(waited.results.length, 2);
  for (const r of waited.results) {
    assert.equal(r.done, true);
    assert.match(r.text, /ECHO: waited hello \| SKILLS: bravo/);
  }
  const fpiOut = execFileSync("bash", ["skills/fruity-pi/scripts/fpi", "ask", "a-1", "hello from fpi"], {
    env: { ...process.env, FRUITY_PI_URL: BASE, FRUITY_PI_TOKEN: full, FRUITY_PI_HOME: "/nonexistent" },
  }).toString();
  assert.match(fpiOut, /ECHO: hello from fpi/, fpiOut);
  const fpiLs = execFileSync("bash", ["skills/fruity-pi/scripts/fpi", "ls"], { env: { ...process.env, FRUITY_PI_URL: BASE, FRUITY_PI_TOKEN: read } }).toString();
  assert.match(fpiLs, /a-1/);
  execFileSync(tsx, ["src/cli.ts", "token", "revoke", "agent-read"], { env });
  assert.equal((await as(read, "GET", "/api/state")).status, 401, "revoked token rejected");
  assert.match(fs.readFileSync(path.join(HOME, "audit.log"), "utf8"), /token:agent-full/, "audit records the token");
  log("agent API ok (tokens, scopes, send+wait, fpi)");

  // ---- package manager: disable a skill at profile scope
  const inst = await api("GET", "/api/packages/installed");
  const pkgA = inst.packages.find((p: any) => p.tracked === "skills-a");
  assert.ok(pkgA, "tracked repo visible in package matrix");
  // tracked repo of kind "package": toggle via profile-scope override
  const local = path.join(ROOT, "local-pkg");
  fs.mkdirSync(path.join(local, "skills", "charlie"), { recursive: true });
  fs.mkdirSync(path.join(local, "skills", "delta"), { recursive: true });
  fs.writeFileSync(path.join(local, "package.json"), JSON.stringify({ name: "local-pkg", version: "1.0.0", pi: { skills: ["./skills"] } }));
  for (const s of ["charlie", "delta"]) fs.writeFileSync(path.join(local, "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: ${s}\n---\n${s}\n`);
  await waitJob((await api("POST", "/api/packages/action", { action: "install", source: local, scope: { kind: "cluster", value: "b" } })).job.id);
  await allIdle(5);
  assert.deepEqual(skillNames(await api("GET", "/api/instances/b-1/commands")), ["skill:bravo", "skill:charlie", "skill:delta"]);
  assert.deepEqual(skillNames(await api("GET", "/api/instances/a-1/commands")), ["skill:alpha", "skill:alpha2"]);
  await waitJob((await api("POST", "/api/packages/action", { action: "toggle", source: local, resourceType: "skills", resourcePath: "skills/delta", enabled: false, scope: { kind: "instance", value: "b-1" } })).job.id);
  await allIdle(5);
  assert.deepEqual(skillNames(await api("GET", "/api/instances/b-1/commands")), ["skill:bravo", "skill:charlie"]);
  assert.deepEqual(skillNames(await api("GET", "/api/instances/b-2/commands")), ["skill:bravo", "skill:charlie", "skill:delta"]);
  await waitJob((await api("POST", "/api/packages/action", { action: "remove", source: local, scope: { kind: "cluster", value: "b" } })).job.id);
  await allIdle(5);
  assert.deepEqual(skillNames(await api("GET", "/api/instances/b-2/commands")), ["skill:bravo"]);
  log("package install / toggle / remove ok");

  // ---- scale down + model change via deployment
  const yaml2 = yaml.replace("replicas: 3", "replicas: 1");
  const plan2 = await api("POST", "/api/deployments/plan", { yaml: yaml2 });
  assert.deepEqual(plan2.steps.filter((s: any) => s.op === "remove").map((s: any) => s.name).sort(), ["a-2", "a-3"]);
  await waitJob((await api("PUT", "/api/deployments", { yaml: yaml2, apply: true })).job.id);
  await allIdle(3);
  log("scale down ok");

  // ---- import an existing pi setup + session; the original must stay untouched
  const setup = await api("GET", "/api/import/setup");
  assert.equal(setup.exists, true);
  assert.ok(setup.skills.some((x: string) => x.endsWith("my-own-skill")));
  assert.equal(setup.sessions, 1);
  const imp = await api("POST", "/api/import/setup", { id: "mine" });
  assert.equal(imp.profile.model, "fake/fake-model");
  const sess = await api("GET", "/api/import/sessions");
  assert.equal(sess.sessions.length, 1);
  assert.match(sess.sessions[0].firstPrompt, /remember the word mango/);
  await waitJob((await api("POST", "/api/import/session", { file: sess.sessions[0].file, profile: "mine", name: "resumed", cwd: "original" })).job.id);
  await waitFor("imported instance idle", async () => (await instances()).find((i) => i.name === "resumed")?.status === "idle");
  const rs = await api("GET", "/api/instances/resumed/state");
  assert.ok(rs.messageCount >= 2, `imported conversation continued (messageCount=${rs.messageCount})`);
  const ans = await api("POST", "/api/send", { selector: "resumed", action: "prompt", message: "what word?", wait: true, timeout: 60 });
  assert.match(ans.results[0].text, /ECHO: what word\? \| SKILLS: my-own-skill/);
  assert.equal((await api("GET", "/api/instances/resumed")).instance.cwd, userProj, "kept the original project folder");
  // a path outside the pi sessions dir is refused
  await assert.rejects(api("POST", "/api/import/session", { file: path.join(userPi, "settings.json"), profile: "mine", name: "evil" }));
  assert.equal(snapshot(userPi), userPiBefore, "the user's own pi dir is byte-for-byte unchanged");
  await api("POST", "/api/instances/resumed/delete");
  assert.equal(snapshot(userPi), userPiBefore, "still unchanged after deleting the imported instance");
  log("import from existing pi ok (original untouched)");

  // ---- secrets redaction
  await api("POST", "/api/system/secrets", { MY_TEST_API_KEY: "zz-secret-value-4242" });
  const sys = await api("GET", "/api/system");
  assert.ok(!JSON.stringify(sys).includes("zz-secret-value-4242"), "secret never returned by API");

  // ---- restart server: instances come back and resume
  procs[1].kill("SIGTERM");
  await sleep(3000);
  startServer();
  await waitFor("server back", () => fetch(BASE + "/api/auth/me").then((r) => r.ok));
  await allIdle(3);
  const st2 = await api("GET", "/api/instances/a-1/state");
  assert.ok(st2.messageCount >= 2, "session resumed after server restart");
  log("server restart + resume ok");

  // ---- teardown via deployment delete
  await waitJob((await api("DELETE", "/api/deployments/e2e")).job.id);
  assert.equal((await instances()).length, 0);
  const audit = fs.readFileSync(path.join(HOME, "audit.log"), "utf8");
  for (const a of ["auth.login", "deployment.apply", "send", "packages.action", "repo.updated"]) assert.ok(audit.includes(`"${a}"`), `audit has ${a}`);
  assert.ok(!audit.includes("zz-secret-value-4242"));
  log("teardown + audit ok");
  console.log("\n✅ e2e passed");
}

main()
  .catch((e) => {
    console.error("\n❌ e2e failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const p of procs) p.kill("SIGTERM");
    await sleep(1500);
    if (!process.env.E2E_KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
    else console.log("kept", ROOT);
    process.exit();
  });
