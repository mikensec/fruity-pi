import { randomUUID } from "node:crypto";
import { publish } from "./bus.js";

export type JobStatus = "running" | "done" | "failed";

export interface Job {
  id: string;
  title: string;
  kind: string;
  status: JobStatus;
  startedAt: string;
  endedAt?: string;
  log: string[];
  error?: string;
  result?: unknown;
}

const MAX_JOBS = 100;
const MAX_LOG = 5000;
const jobs = new Map<string, Job>();

export interface JobCtx {
  job: Job;
  log(line: string): void;
}

function summary(j: Job) {
  const { log: _log, ...rest } = j;
  return { ...rest, logLines: j.log.length };
}

/** Run a long task in the background with a live, streamable log. */
export function startJob<T>(kind: string, title: string, fn: (ctx: JobCtx) => Promise<T>): Job {
  const job: Job = { id: randomUUID(), kind, title, status: "running", startedAt: new Date().toISOString(), log: [] };
  jobs.set(job.id, job);
  if (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value!);
  const ctx: JobCtx = {
    job,
    log(line) {
      job.log.push(line);
      if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
      publish({ topic: "job-log", id: job.id, line });
    },
  };
  publish({ topic: "job", job: summary(job) });
  fn(ctx)
    .then((result) => {
      job.status = "done";
      job.result = result;
    })
    .catch((err: unknown) => {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      ctx.log(`ERROR: ${job.error}`);
    })
    .finally(() => {
      job.endedAt = new Date().toISOString();
      publish({ topic: "job", job: summary(job) });
    });
  return job;
}

export function listJobs() {
  return [...jobs.values()].reverse().map(summary);
}

export function getJob(id: string) {
  return jobs.get(id);
}

/** Run async tasks with bounded parallelism. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}
