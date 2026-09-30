import crypto from "node:crypto";
import { store } from "./store.js";
import { ID_RE } from "./profiles.js";

/**
 * API tokens for agents and scripts: `Authorization: Bearer fpi_…`.
 * Only a SHA-256 of the token is stored; the plaintext is shown once at creation.
 */
export interface ApiToken {
  id: string;
  name: string;
  scope: "full" | "read";
  hash: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
}

const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

export function createToken(name: string, scope: "full" | "read", ttlDays?: number) {
  const id = name.trim().toLowerCase().replace(/[^a-z0-9-_.]+/g, "-").slice(0, 60);
  if (!ID_RE.test(id)) throw new Error("Token name must contain letters or digits");
  if (store.get("token", id)) throw new Error(`A token named ${id} already exists`);
  if (scope !== "full" && scope !== "read") throw new Error("scope must be full or read");
  const secret = `fpi_${crypto.randomBytes(24).toString("base64url")}`;
  const tok: ApiToken = {
    id,
    name: name.trim(),
    scope,
    hash: sha(secret),
    prefix: secret.slice(0, 8),
    createdAt: new Date().toISOString(),
    expiresAt: ttlDays ? new Date(Date.now() + ttlDays * 86400_000).toISOString() : undefined,
  };
  store.put("token", id, tok);
  return { token: publicToken(tok), secret };
}

export function verifyToken(secret: string): ApiToken | undefined {
  if (!secret.startsWith("fpi_")) return;
  const h = sha(secret);
  const tok = store.list("token").find((t) => crypto.timingSafeEqual(Buffer.from(t.hash), Buffer.from(h)));
  if (!tok) return;
  if (tok.expiresAt && Date.parse(tok.expiresAt) < Date.now()) return;
  // Throttle lastUsedAt writes to once a minute.
  if (!tok.lastUsedAt || Date.now() - Date.parse(tok.lastUsedAt) > 60_000) store.update("token", tok.id, { lastUsedAt: new Date().toISOString() });
  return tok;
}

export function listTokens() {
  return store.list("token").map(publicToken);
}

export function revokeToken(id: string) {
  if (!store.get("token", id)) throw new Error(`Unknown token ${id}`);
  store.delete("token", id);
}

function publicToken(t: ApiToken) {
  const { hash: _h, ...rest } = t;
  return rest;
}
