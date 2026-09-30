/** A package entry as it appears in pi's settings.json `packages` array. */
export type PackageEntry =
  | string
  | {
      source: string;
      extensions?: string[];
      skills?: string[];
      prompts?: string[];
      themes?: string[];
    };

export interface Profile {
  id: string;
  description?: string;
  /** pi package sources (npm:, git:, https:, local paths), optionally with resource filters. */
  packages: PackageEntry[];
  /** Tracked repo ids (see Repo). */
  repos: string[];
  /** Extra local skill paths passed via --skill. */
  skills: string[];
  model?: string;
  thinking?: string;
  tools?: string;
  /** Pass -a / --approve so project-local .pi files in the workspace are trusted. */
  approve?: boolean;
  appendSystemPrompt?: string;
  /** Contents of pi's models.json (custom providers, e.g. Ollama / OpenAI-compatible endpoints). */
  modelsJson?: string;
  extraArgs: string[];
  env: Record<string, string>;
  updatedAt?: string;
}

export type RepoKind = "package" | "skills";

export interface Repo {
  id: string;
  url: string;
  ref: string;
  mode: "track" | "pinned";
  pollSeconds: number;
  /** Package root inside the repo. */
  subdir?: string;
  kind?: RepoKind;
  currentSha?: string;
  lastCheck?: string;
  lastError?: string;
  updating?: boolean;
  history: { sha: string; at: string }[];
}

export type InstanceStatus = "stopped" | "starting" | "idle" | "running" | "queued" | "updating" | "error";

export interface Instance {
  id: string;
  name: string;
  profile: string;
  deployment?: string;
  cluster?: string;
  cwd?: string;
  /** Per-instance model override (deployment group or ad-hoc). */
  model?: string;
  /** Packages installed with instance scope, on top of the profile. */
  extraPackages: PackageEntry[];
  /** Remote package sources fruity-pi has installed into this instance (pi install). */
  installed: string[];
  desired: "running" | "stopped";
  configHash?: string;
  /** Repo SHAs this instance was started with. */
  repoShas: Record<string, string>;
  createdAt: string;
  lastError?: string;
}

export interface DeploymentGroup {
  cluster: string;
  profile: string;
  replicas: number;
  cwd?: string;
  worktree?: boolean;
  model?: string;
}

export interface Deployment {
  name: string;
  groups: DeploymentGroup[];
  yaml: string;
  appliedAt?: string;
  updatedAt?: string;
}
