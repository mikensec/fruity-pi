import { store } from "./store.js";
import type { Instance } from "./types.js";

/**
 * Resolve a selector to instances. Grammar (comma = union):
 *   all | cluster:<name> | deployment:<name> | profile:<id> | instance:<name> | <name>
 * Globs with * are allowed in the value, e.g. cluster:review*.
 */
export function resolveSelector(selector: string | undefined, ids?: string[]): Instance[] {
  const all = store.list("instance");
  const picked = new Map<string, Instance>();
  if (ids?.length) for (const i of all) if (ids.includes(i.id)) picked.set(i.id, i);
  for (const raw of (selector ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (raw === "all" || raw === "*") {
      all.forEach((i) => picked.set(i.id, i));
      continue;
    }
    const [kind, value] = raw.includes(":") ? (raw.split(/:(.*)/s, 2) as [string, string]) : ["instance", raw];
    const re = new RegExp("^" + value.split("*").map(escape).join(".*") + "$");
    const field: Record<string, (i: Instance) => string | undefined> = {
      cluster: (i) => i.cluster,
      deployment: (i) => i.deployment,
      profile: (i) => i.profile,
      instance: (i) => i.name,
      id: (i) => i.id,
    };
    const get = field[kind];
    if (!get) throw new Error(`Unknown selector kind "${kind}" (use all, cluster:, deployment:, profile:, instance:)`);
    for (const i of all) {
      const v = get(i);
      if (v && re.test(v)) picked.set(i.id, i);
    }
  }
  return [...picked.values()];
}

function escape(s: string) {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
