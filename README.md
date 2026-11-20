# dev-agent

An AI-DLC developer agent for Claude Code. You give it a ticket (a Jira key or URL, or plain text); it plans the
work across your repos, builds each repo in its own git worktree following that repo's own instructions, verifies
and reviews it, and hands you local branches plus PR text. You push and open the PRs.

It works on any repo or set of repos, in any language. Nothing about a project is built in: it comes from an
optional config file plus what the agent detects in each repo.

## Use it

From your repo (or a folder holding several repos):

```bash
claude --plugin-dir C:/NovaDevAgent
```

Then `/dev-agent:solve-ticket PROJ-145`. A bare number (`145`) uses `tracker.projectKey`. Plain text with no
key also works ("free-text mode"), which is also the fallback when the Jira connector is unavailable.

Work is sized first (`scripts/triage.mjs`, no LLM call): a **simple** task takes a short path (compact plan, no plan
gate, the same independent review as every tier, one commit question); **medium** and **complex** tasks get the full flow.
Security, deleting data, vague criteria and contract changes always stop for a human. See `docs/OPTIMIZATION.md`.

1. Rewrites any extra free text into a short brief, reviews the ticket (acceptance criteria checked, ambiguities
   listed; stops with questions if criteria are vague), checks each repo, writes `<runs>/<KEY>/plan.md`.
2. **Gate** (`rules.planGate`: `auto` asks only when needed, `always` asks on every ticket): approve and build, approve plan only, change, or stop.
3. For each repo, in `buildOrder` layers: prepares the change target (a feature branch in your own folder, or a
   worktree; see below), runs the `repo-builder` agent, then the `repo-reviewer` agent (one fix round at most).
4. **Gate:** you choose which repos get a local commit. It never pushes.
5. Writes `summary.md` with branches, results, PR text, manual checks, and your push and rollback or cleanup commands.

## Providers

The flow, agents, config and safety rules are provider-neutral. Each host gets a thin adapter.

| Host | Install | Start |
|---|---|---|
| Claude Code | `claude --plugin-dir C:/NovaDevAgent` (no install) | `/dev-agent:solve-ticket PROJ-145` |
| Antigravity (IDE and CLI) | `node scripts/setup.mjs` in your workspace (guided; or `scripts/install.mjs --provider antigravity`, `--scope global` for all) | IDE chat: `Use the solve-ticket skill for PROJ-145`. CLI: `agy`, then `/solve-ticket PROJ-145` |
| Kiro (IDE and CLI) | `node scripts/install.mjs --provider kiro` (`--scope global` for all workspaces) | IDE chat: `#dev-agent`, then describe the ticket. CLI: see `docs/KIRO.md` |

Kiro is a host like Antigravity: no API call is made and no key is stored. Sign in to Kiro itself (`kiro-cli login`, or
`KIRO_API_KEY` for headless runs on eligible plans). Kiro meters in **credits**, not tokens, and its docs describe no way to read
them from a hook, so a Kiro session records its request count and shows credits as *unavailable* unless you record the figure you
read in Kiro (`node scripts/usage.mjs credits ...`, labelled user-reported). `node scripts/usage.mjs show --ticket KEY`
lists every session with tokens and credits kept apart. Setup, hook limits and what is unverified: `docs/KIRO.md`.

For Antigravity the installer generates `.agents/skills/solve-ticket/SKILL.md` (with this folder's path written in),
`.agents/agents/repo-builder|repo-reviewer/agent.md` (tools mapped to `run_command`, `view_file`, ...) and merges
a `dev-agent` entry into `.agents/hooks.json`. Run it again after editing the skill or agents. The guard maps
Antigravity's tool calls onto the same rules (`providers/tools.mjs`) and answers with `{"decision":"deny"}`.
`node scripts/doctor.mjs` checks the machine and workspace (read-only). The full IDE and CLI guide is Part 2 of
`docs/GETTING-STARTED.md`. Another host means one more mapping in `providers/tools.mjs` and one more generator in
`scripts/install.mjs`.

Antigravity is built from its published docs and unit-tested, but not yet run in the real IDE. Check on first use:
the hooks.json shape, that hooks also fire inside subagents (otherwise the builder is unguarded), and the
subagents' default `sandbox` command policy (it may need `commandExecutionPolicy: auto` in `agent.md` to run tests).

## Configuration

`node scripts/config.mjs` prints the resolved config. Lookup order: `--config <file>`, then
`.dev-agent/config.json` in the current folder or a parent, then **zero-config**: the current folder is the repo,
or every git repo directly inside it is.

All keys are optional (see `config/example.config.json`):

| Key | Meaning | Default |
|---|---|---|
| `project` | Label, also the runs sub-folder | folder name |
| `tracker` | `{ type, projectKey }`; Jira site comes from the connector | jira, no key |
| `runsDir` | Where plans, reports and worktrees go (outside every repo) | `~/.dev-agent/runs` |
| `rules` | `changeTarget` (`in-place` / `worktree`), `baseBranch` (null: repo default; a repo entry may set its own `baseBranch`), `branchPattern`, `planGate` (`auto` / `always`), `tier` (`auto` / simple / medium / complex), `models` (role to model alias), commit and push rules | see example |
| `contextFiles` | Project-wide rules the agent reads once (ownership, contracts, auth) | none |
| `repos[]` | `id`, `path`, `areaPrefix`, `owns`, `instructions`, `verify`, `run`, `knownIssues` | discovered |
| `buildOrder` | Layers of repo ids; later layers build against earlier layers' interface | one layer |

Per repo, anything not set is detected by `scripts/detect.mjs`: stack and package manager (Node, Go, Rust, Java,
Python, Ruby, PHP), verify commands (package scripts, Makefile targets, stack defaults), and instruction files
(a `*task*`/`*pr*` skill, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, README).

The Nova Aid setup is in `config/examples/nova-aid/` (copy both files into `<Nova aid folder>/.dev-agent/`).

## How code changes reach your repos

The plugin folder only holds instructions and scripts. `rules.changeTarget` decides where the agent writes code:

| | `in-place` (default) | `worktree` |
|---|---|---|
| Where | Your own checkout, on a new feature branch | A separate worktree under `<runs>/<project>/<KEY>/worktrees/<repo>` |
| Review | Right away: `git diff`, your IDE, source control | `git -C <worktree> diff`, or open the folder |
| Your checkout | Switched to the base, then to the feature branch | Never touched |
| Can you work meanwhile? | No: it is the folder you are editing | Yes |
| Use it when | You want to review and commit in the place you already work, one ticket at a time | Long or multi-repo tickets, or you keep working while it builds |

Set it in `.dev-agent/config.json` (`"rules": { "changeTarget": "worktree" }`), per run with
`node scripts/config.mjs --change-target worktree` (the skill passes this when you ask for a worktree), or with the
environment variable `DEV_AGENT_CHANGE_TARGET`. Order: flag, then env, then config, then the default. If it is not set
anywhere, the first run (or `node scripts/setup.mjs`) asks once and saves your choice. Unattended runs use the default
and save nothing.

**In-place flow** (`scripts/target.mjs`), all before any code is written:
1. Refuses to start in the middle of a merge, rebase, cherry-pick or bisect, or on a detached HEAD.
2. If you have uncommitted changes, it asks: **continue** (your files are recorded and reported apart from the
   agent's), **stash first** (named `dev-agent: before <KEY>`), or **cancel**. An unattended run cancels.
3. Asks which branch is the latest (`main`, `develop`, ...) and remembers it per repo.
4. Switches to it and runs `git pull --ff-only origin <branch>`. It continues only when git says it is up to date or
   fast-forwarded; a diverged branch stops and puts your checkout back. If origin is unreachable it asks whether to
   continue from the local branch.
5. Cuts the feature branch (`rules.branchPattern`, `--no-track`; a taken name gets a suggested one) and builds there.

It never pushes. After the build you get a summary: files modified, added and deleted, `git diff --stat`, where the
changes live, which files were already yours, and which changed without being in the builder's report (you may have
edited them during the run). Changes stay uncommitted until you approve a local commit (or commit yourself).
Commit and push from the same folder:

```bash
git add <files>
git commit -m "PROJ-150: <summary>"
git push -u origin <feature-branch>
```

The summary also prints the **rollback** commands. They keep the agent's work in a stash, switch you back to your
original branch, and (optionally) delete the feature branch; if you chose "stash first", they say how to get your own
stash back.

**Worktree flow:** the branch is cut from the freshly fetched base with `--no-track` (or from the local default branch
when a repo has no remote) into a worktree. `node_modules` is linked from your checkout (extra folders via
`--link-dirs`). `git push` from the worktree, run by you, publishes the branch.

## What it cannot do

- Run checks that need `.env`, a database, a queue or a running server. Those become "Manual checks for the
  developer", because the safety hooks block reading secrets.
- Replace review: always read the diffs. The reviewer agent is a second opinion, not a guarantee.

## What is inside

```
.claude-plugin/plugin.json     plugin manifest
config/example.config.json     generic config example; config/examples/nova-aid has the Nova setup
skills/solve-ticket/SKILL.md   the conductor: Inception and Construction
agents/repo-builder.md         builds one repo in its worktree, writes a report
agents/repo-reviewer.md        read-only review of that repo's diff
scripts/config.mjs             resolves config, applies defaults, profiles repos
scripts/detect.mjs             read-only stack, verify and instruction detection
scripts/triage.mjs             sizes a task (simple / medium / complex) and picks the flow, no LLM call
scripts/verify.mjs             parallel verify, baseline only for failures, cached by base sha
scripts/diffcheck.mjs          deterministic review of a worktree change (simple tasks)
scripts/metrics.mjs            LLM calls, tool calls, human stops, tokens and active time of a run
scripts/scorecard.mjs          tokens, estimated cost and delivery quality of one run (npm run scorecard -- --run-dir runs/KEY --write)
scripts/worktree.mjs           creates and removes worktrees (tested against real throwaway git repos)
scripts/target.mjs             picks in-place or worktree: dirty check, base pull, feature branch, rollback, change summary
hooks/                         safety guard: rules.mjs (logic), guard.mjs (hook), hooks.json
providers/tools.mjs            per-provider tool-call mapping and guard replies
scripts/install.mjs            generates the Antigravity skill, agents and hooks
scripts/setup.mjs, setup.sh, setup.ps1   guided Antigravity setup (Windows, macOS, Linux)
scripts/doctor.mjs             read-only readiness check
providers/antigravity.mjs      Antigravity folders, CLI and IDE detection
providers/kiro.mjs             Kiro folders, CLI and IDE detection, sign-in state (never reads the API key)
providers/usage.mjs            per-session usage records (tokens or credits) and the append-only usage log
hooks/kiro-usage.mjs           Kiro stop hook: counts requests per session, prints one usage line
scripts/usage.mjs              session usage report, history, and user-reported Kiro credits (npm run usage -- --ticket KEY)
```

## Safety guard (hooks, not just prompts)

Blocked for every tool call while the plugin is on:
- `git push`, `git merge`, `git stash`, `git reset --hard`, `git clean -f`, discarding changes
- `gh pr create/merge/...` and write calls through `gh api`
- `git commit` unless prefixed with `DEV_AGENT_COMMIT_OK=1` (the conductor does that only after you approve) and
  `--no-verify`. The old `NOVA_COMMIT_OK` / `NOVA_DEV_ALLOW_COMMIT` names are still accepted.
- `git add -A`, `-u` and `.` (files are staged by name)
- creating a branch or worktree without `--no-track`; removing worktrees outside `scripts/worktree.mjs`
- reading, copying or editing real `.env*` files (`.env.example` is fine)
- editing `node_modules` or `.git`

The commit marker prevents accidents; it is not a security boundary against someone deliberately typing it.

Run all tests: `npm test`.

## Status (version 0.3)

Generic config, detection, free-text mode and renamed plugin are built and unit-tested. Not yet run end to end:
a multi-repo run, a non-Node repo, and a run without Jira. Install as a user-level plugin once those pass.
