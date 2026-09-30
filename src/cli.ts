import fs from "node:fs";
import path from "node:path";
import { paths, ensureDir } from "./paths.js";
import { loadConfig, saveConfig, randomToken } from "./config.js";

const HELP = `fruity-pi — run and manage many isolated pi instances

Usage:
  fruity-pi serve                      Start the dashboard server
  fruity-pi init [--password <pw>]     Create config; generates an admin password if none given
  fruity-pi set-password               Set admin password (reads FRUITY_PI_PASSWORD or stdin)
  fruity-pi ls                         List instances
  fruity-pi send <selector> <message>  Prompt instances (selector: all, cluster:x, profile:x, name…)
  fruity-pi collect <selector>         Print the last answer from each matched instance
  fruity-pi apply <spec.yaml>          Save + apply a deployment spec
  fruity-pi plan <spec.yaml>           Show what apply would do

State lives in ${paths.root} (override with FRUITY_PI_HOME).`;

async function api(method: string, route: string, body?: unknown) {
  const cfg = loadConfig();
  const token = fs.readFileSync(path.join(paths.root, "cli.token"), "utf8").trim();
  const scheme = cfg.tls ? "https" : "http";
  const host = cfg.host === "0.0.0.0" || cfg.host === "::" ? "127.0.0.1" : cfg.host;
  if (cfg.tls) process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= "0"; // local self-signed cert
  const res = await fetch(`${scheme}://${host}:${cfg.port}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "serve": {
      process.removeAllListeners("warning"); // node:sqlite experimental warning noise
      const { buildServer, cliToken } = await import("./server.js");
      const { bootInstances, shutdownAll } = await import("./supervisor.js");
      const { startRepoPoller, stopRepoPoller } = await import("./repos.js");
      cliToken();
      const { app, cfg, useTls } = await buildServer();
      await app.listen({ host: cfg.host, port: cfg.port });
      console.log(`🍓 fruity-pi listening on ${useTls ? "https" : "http"}://${cfg.host}:${cfg.port}`);
      if (cfg.host === "127.0.0.1") console.log(`   remote access: ssh -L ${cfg.port}:127.0.0.1:${cfg.port} <this-vm>  then open http://localhost:${cfg.port}`);
      startRepoPoller();
      bootInstances().catch((e) => console.error("boot:", e));
      let closing = false;
      const stop = async () => {
        if (closing) return;
        closing = true;
        console.log("shutting down…");
        stopRepoPoller();
        await shutdownAll();
        await app.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "init": {
      ensureDir(paths.root);
      const cfg = loadConfig();
      saveConfig({});
      const i = args.indexOf("--password");
      let pw = i >= 0 ? args[i + 1] : undefined;
      if (!cfg.auth.passwordHash || pw) {
        const { hashPassword } = await import("./auth.js");
        const generated = !pw;
        pw ??= randomToken(15);
        if (pw.length < 12) throw new Error("Password must be at least 12 characters");
        saveConfig({ auth: { ...loadConfig().auth, passwordHash: hashPassword(pw) } });
        if (generated) console.log(`Admin password (shown once): ${pw}`);
      } else console.log("Config exists; password unchanged.");
      const { cliToken } = await import("./server.js");
      cliToken();
      if (!fs.existsSync(paths.secrets)) fs.writeFileSync(paths.secrets, "", { mode: 0o600 });
      console.log(`Initialized ${paths.root}`);
      return;
    }
    case "set-password": {
      const { setPassword } = await import("./auth.js");
      const pw = process.env.FRUITY_PI_PASSWORD ?? (await readStdin());
      setPassword(pw);
      console.log("Password updated (restart the server to drop existing sessions).");
      return;
    }
    case "ls": {
      const s = await api("GET", "/api/state");
      const rows = s.instances.map((i: any) => [i.name, i.status, i.cluster ?? "-", i.profile, i.modelLabel ?? "-"]);
      const w = [0, 1, 2, 3, 4].map((c) => Math.max(8, ...rows.map((r: string[]) => String(r[c]).length)));
      console.log(["NAME", "STATUS", "CLUSTER", "PROFILE", "MODEL"].map((h, c) => h.padEnd(w[c])).join("  "));
      for (const r of rows) console.log(r.map((v: string, c: number) => String(v).padEnd(w[c])).join("  "));
      console.log(`\n${s.stats.running} running, ${s.stats.queued} queued (max ${s.stats.maxConcurrent})`);
      return;
    }
    case "send": {
      const [selector, ...msg] = args;
      if (!selector || !msg.length) throw new Error("usage: fruity-pi send <selector> <message>");
      const r = await api("POST", "/api/send", { selector, action: "prompt", message: msg.join(" ") });
      for (const x of r.results) console.log(`${x.ok ? "✓" : "✗"} ${x.name} ${x.disposition ?? x.error ?? ""}`);
      return;
    }
    case "collect": {
      const r = await api("POST", "/api/collect", { selector: args[0] ?? "all" });
      for (const x of r.results) console.log(`\n=== ${x.name} (${x.status}) ===\n${x.text ?? "(no answer yet)"}`);
      return;
    }
    case "plan":
    case "apply": {
      if (!args[0]) throw new Error(`usage: fruity-pi ${cmd} <spec.yaml>`);
      const yaml = fs.readFileSync(args[0], "utf8");
      if (cmd === "plan") {
        const r = await api("POST", "/api/deployments/plan", { yaml });
        if (!r.steps.length) console.log("No changes.");
        for (const s of r.steps) console.log(`${{ create: "+", remove: "-", update: "~" }[s.op as string]} ${s.name}${s.reasons ? `  (${s.reasons.join("; ")})` : ""}`);
      } else {
        const r = await api("PUT", "/api/deployments", { yaml, apply: true });
        console.log(`Applying ${r.deployment.name}: ${r.steps.length} step(s). Job ${r.job.id} — follow it in the dashboard.`);
      }
      return;
    }
    default:
      console.log(HELP);
      if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exit(1);
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
