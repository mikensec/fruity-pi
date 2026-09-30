import crypto from "node:crypto";
import { loadConfig, saveConfig } from "./config.js";

// ------------------------------------------------------------ passwords (scrypt)

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const [algo, N, r, p, salt, key] = stored.split("$");
  if (algo !== "scrypt") return false;
  const expected = Buffer.from(key, "base64");
  const got = crypto.scryptSync(pw, Buffer.from(salt, "base64"), expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(expected, got);
}

export function setPassword(pw: string) {
  if (pw.length < 12) throw new Error("Password must be at least 12 characters");
  const c = loadConfig();
  saveConfig({ auth: { ...c.auth, passwordHash: hashPassword(pw) } });
  revokeAllSessions();
}

// ------------------------------------------------------------ sessions

interface Session {
  token: string;
  csrf: string;
  createdAt: number;
  lastSeen: number;
  ip: string;
}

const sessions = new Map<string, Session>();
const hash = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

export function createSession(ip: string): Session {
  const token = crypto.randomBytes(32).toString("base64url");
  const s: Session = { token, csrf: crypto.randomBytes(24).toString("base64url"), createdAt: Date.now(), lastSeen: Date.now(), ip };
  sessions.set(hash(token), s);
  return s;
}

export function getSession(token: string | undefined): Session | undefined {
  if (!token) return;
  const s = sessions.get(hash(token));
  if (!s) return;
  const idle = loadConfig().auth.sessionIdleHours * 3600_000;
  if (Date.now() - s.lastSeen > idle || Date.now() - s.createdAt > 7 * 24 * 3600_000) {
    sessions.delete(hash(token));
    return;
  }
  s.lastSeen = Date.now();
  return s;
}

export function destroySession(token: string | undefined) {
  if (token) sessions.delete(hash(token));
}

export function revokeAllSessions() {
  sessions.clear();
}

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// ------------------------------------------------------------ login throttling

const failures = new Map<string, { count: number; until: number }>();

/** Returns ms the caller must wait, or 0. */
export function lockoutRemaining(ip: string): number {
  const f = failures.get(ip);
  return f && f.until > Date.now() ? f.until - Date.now() : 0;
}

export function recordFailure(ip: string) {
  const f = failures.get(ip) ?? { count: 0, until: 0 };
  f.count++;
  // 5 free attempts, then 2s, 4s, 8s … capped at 15 minutes.
  if (f.count >= 5) f.until = Date.now() + Math.min(15 * 60_000, 1000 * 2 ** (f.count - 4));
  failures.set(ip, f);
}

export function recordSuccess(ip: string) {
  failures.delete(ip);
}

// ------------------------------------------------------------ TOTP (RFC 6238)

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCode(secret: string, t = Date.now(), step = 30): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / 1000 / step)));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
  return code;
}

export function verifyTotp(secret: string | undefined, code: string | undefined): boolean {
  if (!secret || !code || !/^\d{6}$/.test(code)) return false;
  const now = Date.now();
  return [-30_000, 0, 30_000].some((d) => safeEqual(totpCode(secret, now + d), code));
}

export function newTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}
