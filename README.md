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

1. Rewrites any extra free text into a short brief, reviews the ticket (acceptance criteria checked, ambiguities
   listed; stops with questions if criteria are vague), checks each repo, writes `<runs>/<KEY>/plan.md`.
2. **Gate:** approve and build, approve plan only, change, or stop.
3. For each repo, in `buildOrder` layers: creates a worktree and branch, runs the `repo-builder` agent, then the
   `repo-reviewer` agent (one fix round at most).
4. **Gate:** you choose which repos get a local commit.
5. Writes `summary.md` with branches, results, PR text, manual checks, and your push and cleanup commands.

## Providers

The flow, agents, config and safety rules are provider-neutral. Each host gets a thin adapter.

| Host | Install | Start |
|---|---|---|
| Claude Code | `claude --plugin-dir C:/NovaDevAgent` (no install) | `/dev-agent:solve-ticket PROJ-145` |
| Antigravity (IDE and CLI) | `node scripts/setup.mjs` in your workspace (guided; or `scripts/install.mjs --provider antigravity`, `--scope global` for all) | IDE chat: `Use the solve-ticket skill for PROJ-145`. CLI: `agy`, then `/solve-ticket PROJ-145` |

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
| `rules` | `baseBranch` (null: repo default), `branchPattern`, commit and push rules | see example |
| `contextFiles` | Project-wide rules the agent reads once (ownership, contracts, auth) | none |
| `repos[]` | `id`, `path`, `areaPrefix`, `owns`, `instructions`, `verify`, `run`, `knownIssues` | discovered |
| `buildOrder` | Layers of repo ids; later layers build against earlier layers' interface | one layer |

Per repo, anything not set is detected by `scripts/detect.mjs`: stack and package manager (Node, Go, Rust, Java,
Python, Ruby, PHP), verify commands (package scripts, Makefile targets, stack defaults), and instruction files
(a `*task*`/`*pr*` skill, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, README).

The Nova Aid setup is in `config/examples/nova-aid/` (copy both files into `<Nova aid folder>/.dev-agent/`).

## How code changes reach your repos

The plugin folder only holds instructions and scripts. Code is written in git worktrees of your repos, under
`<runs>/<project>/<KEY>/worktrees/<repo>`, on new branches cut from the freshly fetched base with `--no-track`
(or from the local default branch when a repo has no remote). Your checkouts and uncommitted work are not touched.
`node_modules` is linked from your checkout (extra folders via `--link-dirs`). `git push` from the worktree,
run by you, publishes the branch.

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
scripts/worktree.mjs           creates and removes worktrees (tested against real throwaway git repos)
hooks/                         safety guard: rules.mjs (logic), guard.mjs (hook), hooks.json
providers/tools.mjs            per-provider tool-call mapping and guard replies
scripts/install.mjs            generates the Antigravity skill, agents and hooks
scripts/setup.mjs, setup.sh, setup.ps1   guided Antigravity setup (Windows, macOS, Linux)
scripts/doctor.mjs             read-only readiness check
providers/antigravity.mjs      Antigravity folders, CLI and IDE detection
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
