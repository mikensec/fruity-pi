import crypto from "node:crypto";
import { store } from "./store.js";
import type { Instance, PackageEntry, Profile } from "./types.js";

export const ID_RE = /^[a-z0-9][a-z0-9-_.]{0,62}$/;
export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function packageSource(p: PackageEntry): string {
  return typeof p === "string" ? p : p.source;
}

/** Normalise a package source for identity comparison (drops the @ref / @version suffix). */
export function packageIdentity(src: string): string {
  if (src.startsWith("npm:")) {
    const name = src.slice(4);
    const at = name.lastIndexOf("@");
    return "npm:" + (at > 0 ? name.slice(0, at) : name);
  }
  const m = src.match(/^(git:|https?:\/\/|ssh:\/\/)(.+?)(@[^/@]+)?$/);
  if (m) return (m[1] === "git:" ? "git:" : m[1]) + m[2].replace(/\.git$/, "");
  return src;
}

export function isRemoteSource(src: string) {
  return /^(npm:|git:|https?:\/\/|ssh:\/\/)/.test(src);
}

export function validateProfile(input: any): Profile {
  const id = String(input?.id ?? "").trim();
  if (!ID_RE.test(id)) throw new Error("Profile id must be lowercase letters, digits, - _ . (max 63)");
  const strArr = (v: unknown, name: string): string[] => {
    if (v == null) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`${name} must be a list of strings`);
    return (v as string[]).map((s) => s.trim()).filter(Boolean);
  };
  const packages: PackageEntry[] = (input.packages ?? []).map((p: any) => {
    if (typeof p === "string") return p.trim();
    if (p && typeof p.source === "string") {
      const out: any = { source: p.source.trim() };
      for (const k of ["extensions", "skills", "prompts", "themes"]) if (Array.isArray(p[k])) out[k] = strArr(p[k], k);
      return out;
    }
    throw new Error("Invalid package entry");
  });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Invalid env var name: ${k}`);
    env[k] = String(v);
  }
  let modelsJson: string | undefined;
  if (input.modelsJson && String(input.modelsJson).trim()) {
    try {
      const parsed = JSON.parse(String(input.modelsJson));
      if (!parsed || typeof parsed !== "object") throw new Error();
      modelsJson = JSON.stringify(parsed, null, 2);
    } catch {
      throw new Error("modelsJson must be valid JSON (pi models.json format)");
    }
  }
  if (input.thinking && !THINKING.includes(input.thinking)) throw new Error(`thinking must be one of ${THINKING.join(", ")}`);
  const repos = strArr(input.repos, "repos");
  for (const r of repos) if (!store.get("repo", r)) throw new Error(`Unknown tracked repo: ${r}`);
  return {
    id,
    description: input.description ? String(input.description) : undefined,
    packages,
    repos,
    skills: strArr(input.skills, "skills"),
    model: input.model ? String(input.model).trim() : undefined,
    thinking: input.thinking || undefined,
    tools: input.tools ? String(input.tools).trim() : undefined,
    approve: !!input.approve,
    appendSystemPrompt: input.appendSystemPrompt ? String(input.appendSystemPrompt) : undefined,
    modelsJson,
    extraArgs: strArr(input.extraArgs, "extraArgs"),
    env,
    updatedAt: new Date().toISOString(),
  };
}

export function saveProfile(input: any): Profile {
  const p = validateProfile(input);
  return store.put("profile", p.id, p);
}

export function getProfile(id: string): Profile {
  const p = store.get("profile", id);
  if (!p) throw new Error(`Unknown profile: ${id}`);
  return p;
}

/**
 * Hash of everything that affects how an instance is launched. When it changes
 * the instance needs re-provisioning + restart.
 */
export function configHash(inst: Pick<Instance, "model" | "cwd" | "extraPackages">, profile: Profile): string {
  const { updatedAt: _u, description: _d, ...rest } = profile;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ rest, model: inst.model, cwd: inst.cwd, extra: inst.extraPackages }))
    .digest("hex")
    .slice(0, 16);
}
