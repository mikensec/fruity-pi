import fs from "node:fs";
import { paths, ensureDir } from "./paths.js";
import { redact } from "./config.js";
import { bus } from "./bus.js";

export interface AuditEntry {
  at: string;
  action: string;
  ip?: string;
  detail?: Record<string, unknown>;
}

/** Append-only audit trail of security-relevant and state-changing actions. */
export function audit(action: string, detail?: Record<string, unknown>, ip?: string) {
  ensureDir(paths.root);
  const entry: AuditEntry = { at: new Date().toISOString(), action, ip, detail };
  const line = redact(JSON.stringify(entry));
  fs.appendFileSync(paths.audit, line + "\n", { mode: 0o600 });
  bus.emit("msg", { topic: "audit", entry: JSON.parse(line) });
}

export function readAudit(limit = 200): AuditEntry[] {
  if (!fs.existsSync(paths.audit)) return [];
  const lines = fs.readFileSync(paths.audit, "utf8").trimEnd().split("\n");
  return lines
    .slice(-limit)
    .reverse()
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as AuditEntry];
      } catch {
        return [];
      }
    });
}
