# nova-dev-agent

An AI-DLC developer agent for Claude Code. You give it a Jira ticket; it plans the work across your repos,
builds each repo in its own git worktree by following that repo's `*-task-to-pr` skill, verifies and reviews it,
and hands you local branches plus PR text. You push and open the PRs.

## Status (version 0.2)

| Phase | What | State |
|---|---|---|
| 1 | Plugin, repo config, safety hooks, Jira read | done |
| 2 | Inception: ticket, repo choice, plan, approval gate | done |
| 3 | Build one repo: worktree, builder agent, verify, report | built, first run on NOVA-162 (`agent-panel`) |
| 4 | Several repos: order, contract handoff, review, commit gate, summary | built, **not yet run across several repos** |
| 5 to 7 | Polish, pilot, make it global | not built |

## Use it

From the Nova aid folder:

```bash
claude --plugin-dir C:/NovaDevAgent
```

Then `/nova-dev-agent:solve-ticket 145` (a bare number uses the project key in the config, `NOVA`).

1. Rewrites any free-text request into a short brief, reviews the ticket (acceptance criteria checked, ambiguities
   listed, code inspection scoped; stops with questions if criteria are vague), checks each repo, writes
   `runs/NOVA-145/plan.md`. Builder and reviewer enforce minimal, pattern-matching changes with no unrelated edits.
2. **Gate:** approve and build, approve plan only, change, or stop.
3. For each repo (api-server first, then the callers in parallel): creates a worktree and branch, runs the
   `repo-builder` agent, then the `repo-reviewer` agent (one fix round at most).
4. **Gate:** you choose which repos get a local commit.
5. Writes `runs/NOVA-145/summary.md` with branches, results, PR text, manual checks, and your push and cleanup commands.

## How code changes reach the Nova aid repos

The plugin folder only holds instructions, config and plans. Code is written in git worktrees of the Nova aid
repos, under `runs/<KEY>/worktrees/<repo>`, on new branches cut from the freshly fetched `main` with `--no-track`.
Your own checkouts and uncommitted work are not touched. `node_modules` is linked from your checkout, not reinstalled.
Branches live in the real repos, so `git push` from the worktree (run by you) publishes them.

## What it cannot do

- Run checks that need `.env`, MongoDB, RabbitMQ, Redis or a running server. Those become "Manual checks for the
  developer" in the report, because the safety hooks block reading secrets.
- Replace review: always read the diffs. The reviewer agent is a second opinion, not a guarantee.

## What is inside

```
.claude-plugin/plugin.json     plugin manifest
config/workspace.config.json   repos, verify commands, rules, Jira project (edit this for a new project)
skills/solve-ticket/SKILL.md   the conductor: Inception and Construction
agents/repo-builder.md         builds one repo in its worktree, writes a report
agents/repo-reviewer.md        read-only review of that repo's diff
scripts/worktree.mjs           creates and removes worktrees (tested against real throwaway git repos)
hooks/                         safety guard: rules.mjs (logic), guard.mjs (hook), hooks.json
runs/                          plans, reports and worktrees per ticket (git-ignored)
```

## Safety guard (hooks, not just prompts)

Blocked for every tool call while the plugin is on:
- `git push`, `git merge`, `git stash`, `git reset --hard`, `git clean -f`, discarding changes
- `gh pr create/merge/...` and write calls through `gh api`
- `git commit` unless prefixed with `NOVA_COMMIT_OK=1` (the conductor does that only after you approve) and `--no-verify`
- `git add -A`, `-u` and `.` (files are staged by name)
- creating a branch or worktree without `--no-track`; removing worktrees outside `scripts/worktree.mjs`
- reading, copying or editing real `.env*` files (`.env.example` is fine)
- editing `node_modules` or `.git`

The commit marker prevents accidents; it is not a security boundary against someone deliberately typing it.

Run all tests: `npm test` (guard, worktree, and prompt-structure tests).

## Make it work for another project

Copy `config/workspace.config.json`, then change the workspace root, Jira key, and the `repos` list
(path, area prefix, task skill, verify and run commands). The hooks and scripts are generic. `skills/solve-ticket`
still names Nova Aid and its `nova-aid` skill in a few places; making that wording config-driven is part of phase 7.
