/**
 * Minimal OpenAI-compatible chat-completions server for end-to-end tests.
 * Replies "ECHO: <last user text> | SKILLS: <skill names seen in the system prompt>".
 * A user message containing "slow" delays the reply by 3s (for concurrency tests).
 *
 *   tsx test/fake-llm.ts [port]
 */
import http from "node:http";
import fs from "node:fs";

const port = Number(process.argv[2] ?? 7799);
const dump = process.env.FAKE_LLM_DUMP;
let active = 0;
let peak = 0;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => c?.text ?? "").join("");
  return "";
}

http
  .createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/stats") {
      res.end(JSON.stringify({ active, peak }));
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const c of req) body += c;
    const j = JSON.parse(body);
    if (dump) fs.writeFileSync(dump, JSON.stringify(j, null, 2));
    const msgs: any[] = j.messages ?? [];
    const system = msgs.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
    const lastUser = textOf([...msgs].reverse().find((m) => m.role === "user")?.content);
    const skills = [...system.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1]).sort();
    const reply = `ECHO: ${lastUser.trim().split("\n").pop()} | SKILLS: ${skills.join(",") || "none"}`;

    active++;
    peak = Math.max(peak, active);
    try {
      if (/slow/.test(lastUser)) await new Promise((r) => setTimeout(r, 3000));
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const id = "chatcmpl-fake";
      const chunk = (delta: object, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: j.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ role: "assistant", content: "" });
      for (const piece of reply.match(/.{1,12}/g) ?? []) chunk({ content: piece });
      chunk({}, "stop");
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: j.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } finally {
      active--;
    }
  })
  .listen(port, "127.0.0.1", () => console.log(`fake llm on :${port}`));
