import fs from "node:fs";
import crypto from "node:crypto";
import { paths, ensureDir } from "./paths.js";

export interface Config {
  host: string;
  port: number;
  /** Must be true to bind anything other than loopback. TLS is then mandatory. */
  allowRemote: boolean;
  tls?: { cert: string; key: string };
  /** Max prompts running at once across all instances; the rest queue. */
  maxConcurrent: number;
  /** Web shell is off until enabled from the System page (password re-entry). */
  shellEnabled: boolean;
  /** Hard lock: when true the shell can never be enabled from the UI. */
  shellLocked: boolean;
  /** Record shell sessions as asciicast files. */
  recordShell: boolean;
  /** Override the pi CLI entry (defaults to the bundled @earendil-works/pi-coding-agent). */
  piBin?: string;
  webhookSecret?: string;
  auth: {
    passwordHash?: string;
    totpSecret?: string;
    totpEnabled: boolean;
    sessionIdleHours: number;
  };
}

const DEFAULTS: Config = {
  host: "127.0.0.1",
  port: 7777,
  allowRemote: false,
  maxConcurrent: 8,
  shellEnabled: false,
  shellLocked: false,
  recordShell: false,
  auth: { totpEnabled: false, sessionIdleHours: 12 },
};

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;
  ensureDir(paths.root);
  let raw: Partial<Config> = {};
  if (fs.existsSync(paths.config)) raw = JSON.parse(fs.readFileSync(paths.config, "utf8"));
  cached = { ...DEFAULTS, ...raw, auth: { ...DEFAULTS.auth, ...(raw.auth ?? {}) } };
  return cached;
}

export function saveConfig(patch: Partial<Config>): Config {
  const next = { ...loadConfig(), ...patch };
  fs.writeFileSync(paths.config, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(paths.config, 0o600);
  cached = next;
  return next;
}

/** Public view of config: no hashes, no secrets. */
export function safeConfig(c = loadConfig()) {
  return {
    host: c.host,
    port: c.port,
    allowRemote: c.allowRemote,
    tls: !!c.tls,
    maxConcurrent: c.maxConcurrent,
    shellEnabled: c.shellEnabled && !c.shellLocked,
    shellLocked: c.shellLocked,
    recordShell: c.recordShell,
    webhookConfigured: !!c.webhookSecret,
    totpEnabled: c.auth.totpEnabled,
    passwordSet: !!c.auth.passwordHash,
  };
}

// ---------- secrets.env ----------

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function loadSecrets(): Record<string, string> {
  if (!fs.existsSync(paths.secrets)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(paths.secrets, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function saveSecrets(patch: Record<string, string | null>) {
  const cur = loadSecrets();
  for (const [k, v] of Object.entries(patch)) {
    if (!KEY_RE.test(k)) throw new Error(`Invalid variable name: ${k}`);
    if (v === null || v === "") delete cur[k];
    else {
      if (/[\r\n]/.test(v)) throw new Error(`Value for ${k} must be a single line`);
      cur[k] = v;
    }
  }
  const body = Object.entries(cur)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join("\n");
  ensureDir(paths.root);
  fs.writeFileSync(paths.secrets, body + "\n", { mode: 0o600 });
  fs.chmodSync(paths.secrets, 0o600);
  refreshRedactor();
}

export function maskedSecrets(): { key: string; preview: string }[] {
  return Object.entries(loadSecrets()).map(([key, v]) => ({
    key,
    preview: v.length <= 8 ? "••••" : `${v.slice(0, 3)}…${v.slice(-2)}`,
  }));
}

// ---------- redaction ----------

let secretValues: string[] = [];
export function refreshRedactor() {
  secretValues = Object.values(loadSecrets())
    .filter((v) => v.length >= 8)
    .sort((a, b) => b.length - a.length);
}

/** Replace any secret values in a string. Used for every log line and event we persist or broadcast. */
export function redact(s: string): string {
  if (!secretValues.length) return s;
  for (const v of secretValues) if (s.includes(v)) s = s.split(v).join("[REDACTED]");
  return s;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}
