export type Status = "stopped" | "starting" | "idle" | "running" | "queued" | "updating" | "error";

export type PackageEntry = string | { source: string; skills?: string[]; extensions?: string[]; prompts?: string[]; themes?: string[] };

export interface Instance {
  id: string;
  name: string;
  profile: string;
  deployment?: string;
  cluster?: string;
  cwd?: string;
  model?: string;
  extraPackages: PackageEntry[];
  installed: string[];
  desired: "running" | "stopped";
  repoShas: Record<string, string>;
  createdAt: string;
  lastError?: string;
  status: Status;
  pid?: number;
  startedAt?: string;
  sessionId?: string;
  modelLabel?: string;
  tail: string;
  lastEventAt?: string;
  cost: number;
  tokens: number;
  pendingRestart: boolean;
  configDrift: boolean;
  repoDrift: boolean;
  queuePosition?: number;
  stderrTail: string[];
}

export interface Profile {
  id: string;
  description?: string;
  packages: PackageEntry[];
  repos: string[];
  skills: string[];
  model?: string;
  thinking?: string;
  tools?: string;
  approve?: boolean;
  appendSystemPrompt?: string;
  modelsJson?: string;
  extraArgs: string[];
  env: Record<string, string>;
  updatedAt?: string;
}

export interface Repo {
  id: string;
  url: string;
  ref: string;
  mode: "track" | "pinned";
  pollSeconds: number;
  subdir?: string;
  kind?: "package" | "skills";
  currentSha?: string;
  lastCheck?: string;
  lastError?: string;
  updating?: boolean;
  history: { sha: string; at: string }[];
}

export interface PlanStep {
  op: "create" | "remove" | "update";
  cluster: string;
  name: string;
  reasons?: string[];
}

export interface Deployment {
  name: string;
  groups: { cluster: string; profile: string; replicas: number; cwd?: string; worktree?: boolean; model?: string }[];
  yaml: string;
  appliedAt?: string;
  updatedAt?: string;
  plan: PlanStep[] | { error: string };
}

export interface Job {
  id: string;
  title: string;
  kind: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  endedAt?: string;
  error?: string;
  logLines?: number;
  log?: string[];
}

export interface SafeConfig {
  host: string;
  port: number;
  allowRemote: boolean;
  tls: boolean;
  maxConcurrent: number;
  shellEnabled: boolean;
  shellLocked: boolean;
  recordShell: boolean;
  webhookConfigured: boolean;
  totpEnabled: boolean;
  passwordSet: boolean;
}

export interface AppState {
  instances: Instance[];
  profiles: Profile[];
  repos: Repo[];
  deployments: Deployment[];
  stats: { running: number; queued: number; maxConcurrent: number; live: number; cost: number };
  config: SafeConfig;
  jobs: Job[];
}
