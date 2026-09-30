import type { Instance } from "./types";

/** Client-side mirror of the server's selector grammar, for live "matches N" previews. */
export function resolveSelector(selector: string, all: Instance[], ids: string[] = []): Instance[] {
  const picked = new Map<string, Instance>();
  for (const i of all) if (ids.includes(i.id)) picked.set(i.id, i);
  for (const raw of selector.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (raw === "all" || raw === "*") {
      all.forEach((i) => picked.set(i.id, i));
      continue;
    }
    const idx = raw.indexOf(":");
    const [kind, value] = idx >= 0 ? [raw.slice(0, idx), raw.slice(idx + 1)] : ["instance", raw];
    let re: RegExp;
    try {
      re = new RegExp("^" + value.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    } catch {
      continue;
    }
    const get: Record<string, (i: Instance) => string | undefined> = {
      cluster: (i) => i.cluster,
      deployment: (i) => i.deployment,
      profile: (i) => i.profile,
      instance: (i) => i.name,
      id: (i) => i.id,
    };
    const f = get[kind];
    if (!f) continue;
    for (const i of all) {
      const v = f(i);
      if (v && re.test(v)) picked.set(i.id, i);
    }
  }
  return [...picked.values()];
}
