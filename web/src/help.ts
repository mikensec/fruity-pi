/** Help texts behind the "?" buttons. Keep them short: what it is, when to use it, an example. */
export interface HelpTopic {
  title: string;
  body: string;
  example?: string;
}

export const HELP = {
  // ---- commanding
  selector: {
    title: "Target selector",
    body: "Chooses which instances receive the command. Combine with commas; * is a wildcard. Checked cards on the dashboard are added too.",
    example: "all · cluster:reviewers · profile:docs · writers-3 · review*",
  },
  action: {
    title: "Actions",
    body: "Prompt starts a new run. Steer redirects a run that's already in progress. Follow-up queues a message to run after the current one. Abort stops the current run. New session starts a fresh conversation, and Compact summarizes the history to free up context. Set model and Set thinking change settings live until the next restart.",
  },
  concurrency: {
    title: "Concurrency limit",
    body: "The maximum number of prompts running at the same time across all instances. Extra prompts wait in a queue and start automatically when a slot frees up, which protects your API rate limits and the machine's CPU.",
  },

  // ---- instances / deployments
  cluster: {
    title: "Cluster",
    body: "A name for a group of instances. You can then send commands to the whole group with the selector cluster:NAME. Instances are named NAME-1, NAME-2, …",
    example: "reviewers",
  },
  namePrefix: {
    title: "Name prefix",
    body: "Instances are named PREFIX-1, PREFIX-2, … Defaults to the cluster name, or the profile name if there's no cluster.",
  },
  count: {
    title: "How many",
    body: "How many identical instances to create from the profile. Each one gets its own isolated home, pi config, packages and sessions.",
  },
  replicas: {
    title: "Replicas",
    body: "How many instances this cluster should have. Raising it creates new ones. Lowering it DELETES the highest-numbered instances, along with their sessions. The plan preview shows exactly what will happen before you apply.",
  },
  cwd: {
    title: "Working directory",
    body: "The folder the agents work in (their current directory). Blank gives each instance its own private, empty workspace. A path such as ~/src/app is shared by every instance in the group, which is fine for reading but risky when several agents edit the same files. See worktree.",
    example: "~/src/my-app",
  },
  worktree: {
    title: "One git worktree per replica",
    body: "Gives every instance its own checkout of the repo in the working directory, on its own branch (fruity-pi/<instance-name>), created with `git worktree add`. Agents can edit and commit in parallel without overwriting each other's files. The working directory must be a git repository. Worktrees are removed when instances are removed.",
    example: "cwd: ~/src/app + worktree → reviewers-1 works on branch fruity-pi/reviewers-1",
  },
  modelOverride: {
    title: "Model override",
    body: "Uses a different model for just this group, instead of the one in the profile. Format: provider/model-id, optionally with :thinking.",
    example: "anthropic/claude-sonnet-5-5 · amazon-bedrock/us.anthropic.claude-sonnet-5 · openai/gpt-5.5:high",
  },
  deploymentName: {
    title: "Deployment name",
    body: "A lowercase id for this spec. Every instance it creates is tagged with it, so you can target them all with deployment:NAME and tear them down together.",
  },
  plan: {
    title: "Plan preview",
    body: "What Apply will do: create new instances, update ones whose config changed (restarted two at a time, after their current run finishes, with the conversation kept), and remove extras. Nothing changes until you apply.",
  },
  reprovision: {
    title: "Re-provision",
    body: "Re-applies the profile to this instance (packages, skills, tracked repos, settings) and restarts it. The conversation continues. Use it after editing a profile, or when the instance shows 'drift'.",
  },
  drift: {
    title: "Drift",
    body: "The instance is running an older config: either its profile changed or a tracked repo has a newer commit. It updates automatically after its current run, or immediately if you re-provision or roll out the profile.",
  },

  // ---- profiles
  profileId: {
    title: "Profile id",
    body: "A lowercase name for this recipe. Instances and deployment groups refer to it. It can't be changed later, but you can duplicate the profile.",
  },
  model: {
    title: "Model",
    body: "The model instances use: provider/model-id, optionally with :thinking. Leave blank for pi's default. Provider credentials come from System → Secrets.",
    example: "anthropic/claude-sonnet-5-5 · amazon-bedrock/us.anthropic.claude-sonnet-5 · ollama/qwen2.5-coder:7b",
  },
  thinking: {
    title: "Thinking level",
    body: "How much the model reasons before answering, for models that support it. Higher is smarter but slower and more expensive.",
  },
  tools: {
    title: "Tools allowlist",
    body: "Restricts which tools the agent may use (comma-separated). Blank keeps pi's defaults. Use read,grep,find,ls for read-only reviewers.",
    example: "read,grep,find,ls",
  },
  approve: {
    title: "Trust project files (pi -a)",
    body: "Lets pi load .pi/ settings, packages, skills and extensions from the working directory. Only turn it on for repositories you trust: project extensions run code.",
  },
  trackedRepos: {
    title: "Tracked skill repos",
    body: "Git repos of skills or pi packages that fruity-pi keeps up to date. When a new commit lands, every instance using this profile is updated after its current run finishes. Add repos on the Tracked repos page.",
  },
  packages: {
    title: "pi packages",
    body: "Extra skills, extensions, prompts or themes from npm or git, installed into every instance of this profile. Pin a version with @1.2.3 or @v1.",
    example: "npm:pi-web-access · git:github.com/acme/pi-tools@v1 · /opt/skills/pkg",
  },
  skillPaths: {
    title: "Local skill paths",
    body: "Folders on this machine that contain SKILL.md files, loaded as-is (not copied). One path per line.",
    example: "~/skills/house-style",
  },
  env: {
    title: "Environment",
    body: "Extra environment variables for instances of this profile, one KEY=value per line. Put API keys and tokens in System → Secrets instead: those are hidden in the UI and removed from logs.",
  },
  appendSystemPrompt: {
    title: "Append to system prompt",
    body: "Text added to pi's system prompt for every instance, e.g. house rules or a role.",
    example: "You are a security reviewer. Report findings as a table.",
  },
  extraArgs: {
    title: "Extra CLI args",
    body: "Additional pi command-line flags, one per line. Useful for anything the form doesn't cover.",
    example: "--no-context-files",
  },
  modelsJson: {
    title: "Custom models.json",
    body: "Adds providers pi doesn't have built in: Ollama, LM Studio, vLLM, or any OpenAI-compatible endpoint. Written to each instance's pi config.",
  },

  // ---- repos
  repoUrl: {
    title: "Repository",
    body: "The git repo to track. Private repos work with a token in System → Secrets (GITHUB_TOKEN, GITLAB_TOKEN or FRUITY_PI_GIT_TOKENS), or with this machine's git credentials or SSH keys.",
    example: "github.com/acme/pi-skills · git@github.com:acme/private.git",
  },
  repoRef: {
    title: "Branch, tag or commit",
    body: "What to check out. A branch is followed as it moves. A tag or commit stays fixed.",
  },
  repoMode: {
    title: "Track vs pinned",
    body: "Track polls for new commits on the branch and rolls them out automatically. Pinned stays on the exact ref until you change it; rolling back also pins.",
  },
  pollSeconds: {
    title: "Poll interval",
    body: "How often to check the remote for new commits. For instant updates, add the GitHub webhook below.",
  },
  subdir: {
    title: "Subdirectory",
    body: "Use this if the skills or pi package live in a folder of the repo rather than at the root.",
    example: "packages/pi-skills",
  },
  webhook: {
    title: "GitHub webhook",
    body: "Optional. GitHub notifies fruity-pi on every push, so updates land in seconds instead of on the next poll. It only works if GitHub can reach this server.",
  },

  // ---- packages
  scope: {
    title: "Where to install",
    body: "Profile saves the change to the profile, so current instances roll over and future ones inherit it. Cluster, Deployment, Instance or All adds it to just those instances as an override.",
  },
  runsCode: {
    title: "Runs code",
    body: "This package includes extensions: TypeScript that runs inside pi with your user's permissions. Review the source before installing.",
  },

  // ---- system
  secrets: {
    title: "Secrets",
    body: "Stored in ~/.fruity-pi/secrets.env (readable only by you), passed to every instance, removed from logs, and never shown again in the browser. Restart instances after changing them.",
    example: "ANTHROPIC_API_KEY · GITHUB_TOKEN (private repos) · NPM_TOKEN · AWS_REGION",
  },
  privateRepos: {
    title: "Private repos & packages",
    body: "GITHUB_TOKEN / GITLAB_TOKEN: a personal access token with read access to the repos. FRUITY_PI_GIT_TOKENS: other hosts, as host=token or host=user:password, comma-separated. NPM_TOKEN: private npm packages. The tokens are handed to git and npm when they need them and are never written into repos.",
    example: "FRUITY_PI_GIT_TOKENS = git.corp.com=glpat-xxx,https://bitbucket.org=me:app-pass",
  },
  webShell: {
    title: "Web shell",
    body: "A terminal on this machine in your browser, running as the fruity-pi user. Anyone who can sign in can then run commands here, so it's off by default. Every session is audit-logged.",
  },
  recordShell: {
    title: "Record shell sessions",
    body: "Saves every web-shell session (input and output) as an asciicast file you can replay, for auditing.",
  },
  totp: {
    title: "Two-factor login",
    body: "Requires a 6-digit code from an authenticator app (Google Authenticator, 1Password, Authy, …) in addition to your password.",
  },
  tokenScope: {
    title: "Token scope",
    body: "Full lets an agent run prompts, deploy and scale, and manage repos and packages. Read-only lets it view state and collect answers. No token can open the shell, see secrets, change security settings or create more tokens.",
  },
  tokenExpiry: {
    title: "Expiry",
    body: "The token stops working after this many days. Leave blank for a token that never expires, and revoke it when it's no longer needed.",
  },
} satisfies Record<string, HelpTopic>;

export type HelpKey = keyof typeof HELP;
