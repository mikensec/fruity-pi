import { useEffect, useSyncExternalStore } from "react";
import { get, wsUrl } from "./api";
import type { AppState, Instance, Job, Repo } from "./types";

type Listener = () => void;

interface Store {
  state: AppState | null;
  jobLogs: Record<string, string[]>;
  connected: boolean;
}

let store: Store = { state: null, jobLogs: {}, connected: false };
const listeners = new Set<Listener>();
const eventListeners = new Set<(id: string, ev: any) => void>();

function emit(next: Partial<Store>) {
  store = { ...store, ...next };
  listeners.forEach((l) => l());
}

function patchState(fn: (s: AppState) => AppState) {
  if (!store.state) return;
  emit({ state: fn(store.state) });
}

export async function refresh() {
  const state = await get<AppState>("/api/state");
  emit({ state });
}

let refreshTimer: number | undefined;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => refresh().catch(() => {}), 250);
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const next = list.slice();
  next[i] = item;
  return next;
}

let ws: WebSocket | undefined;
let retry = 0;

export function connectLive() {
  if (ws && ws.readyState <= 1) return;
  ws = new WebSocket(wsUrl("/ws"));
  ws.onopen = () => {
    retry = 0;
    emit({ connected: true });
    refresh().catch(() => {});
  };
  ws.onclose = () => {
    emit({ connected: false });
    ws = undefined;
    setTimeout(connectLive, Math.min(10_000, 500 * 2 ** retry++));
  };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    switch (msg.topic) {
      case "instance":
        patchState((s) => ({ ...s, instances: upsert(s.instances, msg.instance as Instance) }));
        break;
      case "instance-removed":
        patchState((s) => ({ ...s, instances: s.instances.filter((i) => i.id !== msg.id) }));
        break;
      case "repo":
        patchState((s) => ({ ...s, repos: upsert(s.repos, msg.repo as Repo) }));
        break;
      case "job": {
        const job = msg.job as Job;
        patchState((s) => {
          const jobs = [job, ...s.jobs.filter((j) => j.id !== job.id)].slice(0, 50);
          return { ...s, jobs };
        });
        if (job.status !== "running") refreshSoon();
        break;
      }
      case "job-log": {
        const cur = store.jobLogs[msg.id] ?? [];
        emit({ jobLogs: { ...store.jobLogs, [msg.id]: [...cur, msg.line].slice(-3000) } });
        break;
      }
      case "event":
        eventListeners.forEach((l) => l(msg.id, msg.event));
        break;
      case "state":
        refreshSoon();
        break;
    }
  };
}

export function disconnectLive() {
  ws?.close();
}

export function useStore<T>(select: (s: Store) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(store),
  );
}

export function useAppState() {
  return useStore((s) => s.state);
}

/** Subscribe to raw pi events for live streaming views. */
export function useInstanceEvents(fn: (id: string, ev: any) => void, deps: unknown[]) {
  useEffect(() => {
    eventListeners.add(fn);
    return () => {
      eventListeners.delete(fn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function seedJobLog(id: string, lines: string[]) {
  emit({ jobLogs: { ...store.jobLogs, [id]: lines } });
}
