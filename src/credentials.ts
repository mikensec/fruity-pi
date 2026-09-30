import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths, ensureDir } from "./paths.js";

/**
 * Credentials for private git repos and npm packages, taken from secrets.env:
 *
 *   GITHUB_TOKEN / GH_TOKEN      → https://github.com
 *   GITLAB_TOKEN                 → https://gitlab.com
 *   FRUITY_PI_GIT_TOKENS         → "git.corp.com=TOKEN,https://bitbucket.org=user:APP_PASSWORD,http://10.0.0.5:3000=TOKEN"
 *   NPM_TOKEN                    → registry.npmjs.org (private/scoped packages)
 *
 * Git credentials are injected through GIT_CONFIG_COUNT/KEY/VALUE env config and a
 * tiny credential helper that reads the token from the environment, so no token is
 * ever written to disk. npm uses an .npmrc that references ${NPM_TOKEN} by name.
 */
export interface GitCred {
  prefix: string; // e.g. https://github.com
  username: string;
  token: string;
}

export function gitCredentials(secrets: Record<string, string>): GitCred[] {
  const out: GitCred[] = [];
  const gh = secrets.GITHUB_TOKEN || secrets.GH_TOKEN;
  if (gh) out.push({ prefix: "https://github.com", username: "x-access-token", token: gh });
  if (secrets.GITLAB_TOKEN) out.push({ prefix: "https://gitlab.com", username: "oauth2", token: secrets.GITLAB_TOKEN });
  for (const item of (secrets.FRUITY_PI_GIT_TOKENS ?? "").split(",")) {
    const m = item.trim().match(/^([^=\s]+)=(.+)$/);
    if (!m) continue;
    let prefix = m[1].replace(/\/+$/, "");
    if (!/^https?:\/\//.test(prefix)) prefix = `https://${prefix}`;
    // "user:secret" sets an explicit username (Bitbucket app passwords, Gitea, …).
    const userSplit = m[2].match(/^([^:]+):(.+)$/);
    const username = userSplit ? userSplit[1] : /gitlab/i.test(prefix) ? "oauth2" : "x-access-token";
    out.push({ prefix, username, token: userSplit ? userSplit[2] : m[2] });
  }
  return out;
}

/** Add git auth + non-interactive defaults to an environment (mutates and returns it). */
export function applyGitAuth(env: Record<string, string>, secrets: Record<string, string>): Record<string, string> {
  // Never hang waiting for a password prompt or an unknown SSH host key.
  env.GIT_TERMINAL_PROMPT = "0";
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new";
  const creds = gitCredentials(secrets);
  if (!creds.length) return env;
  let n = Number(env.GIT_CONFIG_COUNT ?? 0) || 0;
  creds.forEach((c, i) => {
    const tokVar = `FRUITY_PI_GIT_TOKEN_${i}`;
    const userVar = `FRUITY_PI_GIT_USER_${i}`;
    env[tokVar] = c.token;
    env[userVar] = c.username;
    // An empty helper resets helpers from ~/.gitconfig for this URL, so our token wins.
    env[`GIT_CONFIG_KEY_${n}`] = `credential.${c.prefix}.helper`;
    env[`GIT_CONFIG_VALUE_${n++}`] = "";
    env[`GIT_CONFIG_KEY_${n}`] = `credential.${c.prefix}.helper`;
    env[`GIT_CONFIG_VALUE_${n++}`] = `!f() { test "$1" = get || exit 0; echo "username=$${userVar}"; echo "password=$${tokVar}"; }; f`;
  });
  env.GIT_CONFIG_COUNT = String(n);
  return env;
}

/**
 * Point npm at a user config that keeps the operator's ~/.npmrc (registry mirrors etc.)
 * and adds `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` when NPM_TOKEN is set.
 * The file references the variable; the token itself stays in the environment.
 */
export function applyNpmAuth(env: Record<string, string>, secrets: Record<string, string>): Record<string, string> {
  const real = path.join(os.homedir(), ".npmrc");
  const hasReal = fs.existsSync(real);
  if (!secrets.NPM_TOKEN) {
    if (hasReal && !env.NPM_CONFIG_USERCONFIG) env.NPM_CONFIG_USERCONFIG = real;
    return env;
  }
  env.NPM_TOKEN = secrets.NPM_TOKEN;
  const file = path.join(paths.root, "npmrc");
  const body =
    (hasReal ? fs.readFileSync(real, "utf8").replace(/\n?$/, "\n") : "") +
    "# added by fruity-pi (System → Secrets → NPM_TOKEN)\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n";
  try {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== body) {
      ensureDir(paths.root);
      fs.writeFileSync(file, body, { mode: 0o600 });
    }
    env.NPM_CONFIG_USERCONFIG = file;
  } catch {
    /* fall back to npm defaults */
  }
  return env;
}
