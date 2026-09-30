import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate all state for the test run.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fruity-pi-test-"));
process.env.FRUITY_PI_HOME = TMP;

const { JsonlSplitter } = await import("../src/jsonl.js");
const { instanceEnv } = await import("../src/pi.js");
const { saveSecrets, redact } = await import("../src/config.js");
const { packageIdentity } = await import("../src/profiles.js");
const { toggleResource, gitUrlAndRef, packageDir } = await import("../src/packages.js");
const { resolveSelector } = await import("../src/selectors.js");
const { store } = await import("../src/store.js");
const auth = await import("../src/auth.js");

test("jsonl: splits on LF only, keeps U+2028/U+2029 inside records", () => {
  const out: string[] = [];
  const s = new JsonlSplitter((l) => out.push(l));
  const rec1 = JSON.stringify({ text: "a b c" });
  const rec2 = JSON.stringify({ n: 2 });
  const buf = Buffer.from(`${rec1}\r\n${rec2}\n`);
  // Feed byte-by-byte to exercise multi-byte UTF-8 split across chunks.
  for (const b of buf) s.push(Buffer.from([b]));
  assert.equal(out.length, 2);
  assert.equal(JSON.parse(out[0]).text, "a b c");
  assert.equal(JSON.parse(out[1]).n, 2);
});

test("jsonl: flushes trailing record without newline", () => {
  const out: string[] = [];
  const s = new JsonlSplitter((l) => out.push(l));
  s.push(Buffer.from('{"a":1}'));
  assert.equal(out.length, 0);
  s.end();
  assert.deepEqual(out, ['{"a":1}']);
});

test("env: isolates HOME / agent dir and never leaks the real home", () => {
  const env = instanceEnv({ id: "demo-1" }, { env: { FOO: "bar" } });
  const realHome = os.homedir();
  assert.ok(env.HOME.startsWith(TMP), "HOME inside fruity-pi root");
  assert.equal(env.PI_CODING_AGENT_DIR, path.join(env.HOME, ".pi", "agent"));
  assert.ok(env.PI_CODING_AGENT_SESSION_DIR.startsWith(TMP));
  assert.equal(env.FOO, "bar");
  for (const [k, v] of Object.entries(env)) {
    if (["GIT_CONFIG_GLOBAL", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "PATH", "SHELL", "SSH_AUTH_SOCK"].includes(k)) continue;
    assert.ok(!v.startsWith(realHome + "/") || v.startsWith(TMP), `${k} leaks real home: ${v}`);
  }
  assert.notEqual(instanceEnv({ id: "demo-2" }).HOME, env.HOME);
});

test("secrets: injected into env and redacted from logs", () => {
  saveSecrets({ ANTHROPIC_API_KEY: "fake-test-secret-value-123" });
  const env = instanceEnv({ id: "demo-1" });
  assert.equal(env.ANTHROPIC_API_KEY, "fake-test-secret-value-123");
  assert.equal(redact("key=fake-test-secret-value-123!"), "key=[REDACTED]!");
  assert.equal(fs.statSync(path.join(TMP, "secrets.env")).mode & 0o777, 0o600);
});

test("bedrock: EC2 instance-role mode generates a region-only AWS profile", () => {
  saveSecrets({ FRUITY_PI_AWS_INSTANCE_ROLE: "1", AWS_REGION: "us-west-2" });
  const env = instanceEnv({ id: "bedrock-1" });
  assert.equal(env.AWS_PROFILE, "fruity-pi-instance-role");
  assert.equal(env.AWS_REGION, "us-west-2");
  assert.ok(env.AWS_CONFIG_FILE.startsWith(TMP));
  assert.equal(fs.readFileSync(env.AWS_CONFIG_FILE, "utf8"), "[profile fruity-pi-instance-role]\nregion = us-west-2\n");
  // Region is not a secret: must not be redacted from logs.
  assert.equal(redact("region us-west-2"), "region us-west-2");
  // Explicit credentials win over the instance role.
  saveSecrets({ AWS_BEARER_TOKEN_BEDROCK: "bedrock-token-abcdef" });
  const env2 = instanceEnv({ id: "bedrock-1" });
  assert.equal(env2.AWS_PROFILE, undefined);
  assert.equal(env2.AWS_BEARER_TOKEN_BEDROCK, "bedrock-token-abcdef");
  saveSecrets({ FRUITY_PI_AWS_INSTANCE_ROLE: null, AWS_REGION: null, AWS_BEARER_TOKEN_BEDROCK: null });
});

test("bedrock: host AWS variables pass through, unrelated ones don't", () => {
  process.env.AWS_REGION = "eu-central-1";
  process.env.AWS_WEB_IDENTITY_TOKEN_FILE = "/var/run/token";
  process.env.SOME_RANDOM_HOST_VAR = "nope";
  const env = instanceEnv({ id: "x" });
  assert.equal(env.AWS_REGION, "eu-central-1");
  assert.equal(env.AWS_WEB_IDENTITY_TOKEN_FILE, "/var/run/token");
  assert.equal(env.SOME_RANDOM_HOST_VAR, undefined);
  delete process.env.AWS_REGION;
  delete process.env.AWS_WEB_IDENTITY_TOKEN_FILE;
  delete process.env.SOME_RANDOM_HOST_VAR;
});

test("proxy + custom CA variables reach instances; loopback/IMDS bypass the proxy", () => {
  process.env.HTTPS_PROXY = "http://proxy.corp:3128";
  process.env.NO_PROXY = ".corp.internal";
  process.env.NODE_EXTRA_CA_CERTS = "/etc/ssl/corp-root.pem";
  process.env.GIT_SSL_CAINFO = "/etc/ssl/bundle.pem";
  const env = instanceEnv({ id: "p1" });
  assert.equal(env.HTTPS_PROXY, "http://proxy.corp:3128");
  assert.equal(env.NODE_EXTRA_CA_CERTS, "/etc/ssl/corp-root.pem");
  assert.equal(env.GIT_SSL_CAINFO, "/etc/ssl/bundle.pem");
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
  for (const h of [".corp.internal", "localhost", "127.0.0.1", "169.254.169.254"]) assert.ok(env.NO_PROXY.split(",").includes(h), h);
  for (const k of ["HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "GIT_SSL_CAINFO"]) delete process.env[k];
  assert.equal(instanceEnv({ id: "p1" }).NODE_USE_ENV_PROXY, undefined);
});

test("private git repos: token from secrets authenticates, missing token fails fast", async () => {
  const { spawn, execFileSync } = await import("node:child_process");
  const http = await import("node:http");
  const { applyGitAuth } = await import("../src/credentials.js");
  const { runCommand } = await import("../src/pi.js");
  // Bare repo served by `git http-backend` behind HTTP basic auth (like a private GitHub repo).
  const root = fs.mkdtempSync(path.join(TMP, "git-"));
  const work = path.join(root, "work");
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  fs.writeFileSync(path.join(work, "SKILL.md"), "---\nname: secret-skill\n---\n");
  execFileSync("git", ["-C", work, "add", "."]);
  execFileSync("git", ["-C", work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  execFileSync("git", ["clone", "-q", "--bare", work, path.join(root, "private.git")]);
  const TOKEN = "tok_private_repo_123";
  const server = http.createServer((req, res) => {
    const auth = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
    if (auth.split(":")[1] !== TOKEN) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="private"' }).end();
      return;
    }
    const u = new URL(req.url!, "http://x");
    const cgi = spawn("git", ["http-backend"], {
      env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1), REQUEST_METHOD: req.method!, CONTENT_TYPE: req.headers["content-type"] ?? "", REMOTE_USER: "x" },
    });
    req.pipe(cgi.stdin);
    let buf = Buffer.alloc(0);
    let headersDone = false;
    cgi.stdout.on("data", (d: Buffer) => {
      if (headersDone) return void res.write(d);
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf("\r\n\r\n");
      if (i < 0) return;
      headersDone = true;
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of buf.subarray(0, i).toString().split("\r\n")) {
        const [k, ...v] = line.split(":");
        if (k.toLowerCase() === "status") status = parseInt(v.join(":"));
        else headers[k] = v.join(":").trim();
      }
      res.writeHead(status, headers);
      res.write(buf.subarray(i + 4));
    });
    cgi.stdout.on("end", () => res.end());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as any).port}/private.git`;
  try {
    const base = { PATH: process.env.PATH!, HOME: TMP };
    const denied = await runCommand("git", ["ls-remote", url], { env: applyGitAuth({ ...base }, {}), timeoutMs: 20_000 });
    assert.notEqual(denied.code, 0, "no token → access denied");
    const secrets = { FRUITY_PI_GIT_TOKENS: `${url.replace(/\/private\.git$/, "")}=${TOKEN}` };
    const ok = await runCommand("git", ["clone", "-q", url, path.join(root, "clone")], { env: applyGitAuth({ ...base }, secrets), timeoutMs: 20_000 });
    assert.equal(ok.code, 0, ok.output);
    assert.ok(fs.existsSync(path.join(root, "clone", "SKILL.md")));
    // The token never lands in git config on disk.
    assert.ok(!fs.readFileSync(path.join(root, "clone", ".git", "config"), "utf8").includes(TOKEN));
    // …and each token inside FRUITY_PI_GIT_TOKENS is redacted from logs.
    saveSecrets(secrets);
    assert.equal(redact(`auth ${TOKEN}`), "auth [REDACTED]");
    saveSecrets({ FRUITY_PI_GIT_TOKENS: null });
  } finally {
    server.close();
  }
});

test("package identity ignores version/ref", () => {
  assert.equal(packageIdentity("npm:@foo/bar@1.2.3"), "npm:@foo/bar");
  assert.equal(packageIdentity("npm:bar"), "npm:bar");
  assert.equal(packageIdentity("git:github.com/a/b@v1"), "git:github.com/a/b");
  assert.equal(packageIdentity("https://github.com/a/b.git"), "https://github.com/a/b");
});

test("git source parsing", () => {
  assert.deepEqual(gitUrlAndRef("git:github.com/a/b@v1"), { url: "https://github.com/a/b", ref: "v1" });
  assert.deepEqual(gitUrlAndRef("git:github.com/a/b"), { url: "https://github.com/a/b", ref: undefined });
  assert.deepEqual(gitUrlAndRef("git:git@github.com:a/b"), { url: "git@github.com:a/b", ref: undefined });
  assert.deepEqual(gitUrlAndRef("git:git@github.com:a/b@main"), { url: "git@github.com:a/b", ref: "main" });
});

test("package dirs match pi's layout", () => {
  const inst = { id: "x" } as any;
  assert.match(packageDir(inst, "npm:@s/p@1.0.0")!, /agent\/npm\/node_modules\/@s\/p$/);
  assert.match(packageDir(inst, "git:github.com/TellyD/pi-local-stats")!, /agent\/git\/github\.com\/TellyD\/pi-local-stats$/);
  assert.match(packageDir(inst, "git:github.com/a/b@v2")!, /agent\/git\/github\.com\/a\/b$/);
});

test("toggleResource adds/removes exact exclusions", () => {
  const off = toggleResource("npm:p", "skills", "skills/hello", false);
  assert.deepEqual(off, { source: "npm:p", skills: ["-skills/hello"] });
  const on = toggleResource(off, "skills", "skills/hello", true);
  assert.equal(on, "npm:p");
});

test("selectors", () => {
  const mk = (name: string, cluster: string, profile: string) =>
    store.put("instance", name, { id: name, name, cluster, profile, extraPackages: [], installed: [], desired: "stopped", repoShas: {}, createdAt: "" });
  mk("reviewers-1", "reviewers", "code");
  mk("reviewers-2", "reviewers", "code");
  mk("writers-1", "writers", "docs");
  const names = (sel: string) => resolveSelector(sel).map((i) => i.name).sort();
  assert.deepEqual(names("cluster:reviewers"), ["reviewers-1", "reviewers-2"]);
  assert.deepEqual(names("profile:docs"), ["writers-1"]);
  assert.deepEqual(names("writers-1,reviewers-2"), ["reviewers-2", "writers-1"]);
  assert.deepEqual(names("cluster:rev*"), ["reviewers-1", "reviewers-2"]);
  assert.equal(names("all").length, 3);
  assert.throws(() => resolveSelector("bogus:x"));
});

test("auth: scrypt roundtrip, TOTP, lockout", () => {
  const h = auth.hashPassword("correct horse battery");
  assert.ok(auth.verifyPassword("correct horse battery", h));
  assert.ok(!auth.verifyPassword("wrong", h));
  const secret = auth.newTotpSecret();
  assert.ok(auth.verifyTotp(secret, auth.totpCode(secret)));
  assert.ok(!auth.verifyTotp(secret, "000000") || auth.totpCode(secret) === "000000");
  for (let i = 0; i < 6; i++) auth.recordFailure("1.2.3.4");
  assert.ok(auth.lockoutRemaining("1.2.3.4") > 0);
  auth.recordSuccess("1.2.3.4");
  assert.equal(auth.lockoutRemaining("1.2.3.4"), 0);
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
