# Getting started with dev-agent

dev-agent takes a ticket, plans the work, builds it in your repos on separate git branches, reviews it,
and hands you local branches plus PR text. **It never pushes or opens PRs. You do that.**

## 1. What you need

| Need | Check |
|---|---|
| Git | `git --version` |
| Node.js (a recent LTS) | `node --version` |
| Claude Code **or** Antigravity | `claude --version` |
| Your project repos cloned on your machine | `git status` inside each |
| Jira connected in your AI tool (optional) | Without it, paste the ticket text instead |

Install Claude Code if you don't have it:

```bash
npm install -g @anthropic-ai/claude-code
```

## 2. Get the agent (once)

```bash
git clone https://github.com/NovaAid/Nova-aid-Agent.git C:/dev-agent
cd C:/dev-agent
npm test
```

All tests should pass. **This clone is needed for both Claude Code and Antigravity.** Everything below runs
files from it: Claude loads it with `--plugin-dir`, and the Antigravity installer reads its skill, agents and
safety guard, and the files it generates point back at this folder. Clone it to a stable path and keep it there.

This guide uses `C:/dev-agent`. If you cloned elsewhere, use your own full path instead. Avoid `~`, because
Windows PowerShell does not expand it for `node`.

## 3. Prepare your project (once)

Dependencies are linked from your checkout, so install them first:

```bash
cd <your-repo>
npm install
```

(Use your stack's install command if it isn't Node.) Create your own `.env` files too. The agent cannot read
them, so checks that need a database or running server are listed for you to run by hand.

## 4. Do you need a config file?

| Your layout | Config needed? |
|---|---|
| You start the agent inside **one git repo** | No |
| You start it in a folder whose **direct children** are git repos | No |
| Repos are nested deeper, or you want build order, owners, or branch rules | **Yes** |

If you need one, create `<your-folder>/.dev-agent/config.json`. Every key is optional:

```json
{
  "project": "my-project",
  "tracker": { "type": "jira", "projectKey": "ABC" },
  "repos": [
    { "id": "backend", "path": "services/backend" },
    { "id": "web", "path": "apps/web" }
  ],
  "buildOrder": [["backend"], ["web"]]
}
```

- `repos[].path` is relative to the folder holding `.dev-agent/`.
- `buildOrder` lists layers. Later layers build against earlier ones (backend first, then the apps that call it).
- Set `projectKey` if you want to type `145` instead of `ABC-145`.
- More options: `config/example.config.json`.

Check what the agent will use:

```bash
cd <your-folder>
node C:/dev-agent/scripts/config.mjs
```

### Do you need a skills or guide file for your project?

No. A skills file is **not required**. The agent works on a plain repo, and your project guidance only makes its
changes better.

**What the agent finds on its own** (`scripts/detect.mjs`), for each repo:

- the stack and package manager
- verify commands (package scripts, Makefile targets, or stack defaults)
- instruction files already in the repo: `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `README.md`, and any
  `.claude/skills/*/SKILL.md`

The builder reads those files and follows them. A repo that already has a README or `CONTRIBUTING.md` gives
the agent real guidance with no setup.

**With nothing at all**, the agent still builds, but only from the ticket and what it sees in the code. It
copies the patterns it finds. Where it has no verify commands, the builder says what it could not check
instead of guessing.

**What improves the result:**

| Add this | Where | What it gives the agent |
|---|---|---|
| `AGENTS.md` or `CLAUDE.md` | In each repo | Conventions: naming, folder layout, how to test, what not to touch |
| `.dev-agent/context.md`, listed under `contextFiles` in the config | Next to `.dev-agent/config.json` | Rules across repos: who owns what, API contract changes, auth |
| `owns`, `knownIssues`, `verify`, `instructions` per repo | `.dev-agent/config.json` | Which repo handles which area, known failing tests, exact check commands |

A minimal setup of this kind:

```json
{
  "contextFiles": [".dev-agent/context.md"],
  "repos": [
    {
      "id": "backend",
      "path": "services/backend",
      "owns": ["REST routes", "database schemas"],
      "verify": ["npm test"],
      "knownIssues": "3 tests need a database and fail without one. Do not fix them.",
      "instructions": ["AGENTS.md"]
    }
  ]
}
```

**A practical order:**

1. Start with nothing and run one small ticket.
2. If the agent keeps breaking a convention, write that rule in `AGENTS.md` or `CLAUDE.md` in the repo.
3. With several repos, add a short `context.md` and list it under `contextFiles`.

Claude's `SKILL.md` format is only one way to give instructions. People on Antigravity or Kiro can use
`AGENTS.md`, and the agent reads either. How closely it follows `AGENTS.md` has not been tested in a real run,
so check that on your first ticket.

## 5. Run it

### Claude Code

```bash
cd <your-repo-or-folder>
claude --plugin-dir C:/dev-agent
```

Then inside Claude:

```
/dev-agent:solve-ticket ABC-145
```

### Antigravity

Antigravity cannot load the Claude plugin, so a one-time installer generates its skill, subagents and safety
hook from the agent's files. **You must have cloned the agent first (section 2)**: the installer is
`scripts/install.mjs` in that clone, and the generated hook runs `hooks/guard.mjs` from it. Use full paths,
because `~` is not expanded when you run `node` from PowerShell.

**a) Install into one workspace** (the folder you open in Antigravity):

```bash
cd <your-repo-or-folder>
node C:/dev-agent/scripts/install.mjs --provider antigravity
```

This writes into `<your-repo-or-folder>/.agents/`:

```
.agents/skills/solve-ticket/SKILL.md
.agents/agents/repo-builder/agent.md
.agents/agents/repo-reviewer/agent.md
.agents/hooks.json            (a "dev-agent" entry is merged in; your other hooks are kept)
```

**b) Or install for every workspace** (written to `~/.gemini/config/`):

```bash
node C:/dev-agent/scripts/install.mjs --provider antigravity --scope global
```

**c) Or install into a folder without `cd`:**

```bash
node C:/dev-agent/scripts/install.mjs --provider antigravity --dest <your-repo-or-folder>
```

Options come in `--name value` pairs, and `--provider antigravity` is required.

**Then:**

1. Open `<your-repo-or-folder>` in Antigravity, and make sure your Jira / Atlassian connection is on.
2. In the agent chat, run:

```
/solve-ticket ABC-145
```

Or without Jira, with plain text:

```
/solve-ticket Add a retry to the payment webhook handler, max 3 attempts
```

**Notes**

- The generated files contain the agent's folder path. If you move or re-clone `dev-agent`, or pull an update,
  run the installer again.
- A workspace install puts `.agents/` inside your repo. Don't commit it: add `.agents/` to `.git/info/exclude`
  (or your `.gitignore`).
- The `.dev-agent/config.json` from step 4 works the same way in Antigravity.

### No Jira connection

Give plain text instead of a key:

```
/dev-agent:solve-ticket Add a retry to the payment webhook handler, max 3 attempts
```

## 6. What happens

1. The agent reads the ticket, checks the acceptance criteria and writes `plan.md`. If the criteria are vague
   it stops and asks questions.
2. **Gate 1:** approve and build, approve the plan only, change it, or stop.
3. For each repo it creates a worktree and a new branch, runs the builder, then the reviewer.
4. **Gate 2:** you choose which repos get a local commit.
5. It writes `summary.md` with branches, results, PR text, manual checks, and your push commands.

Everything goes to `~/.dev-agent/runs/<project>/<KEY>/`, outside your repos. Your own checkouts and
uncommitted work are never touched.

## 7. After the run

Read `summary.md`, then review each diff. The reviewer agent is a second opinion, not a guarantee.

### Test the agent's branch on your machine before you commit

The agent builds in a git worktree: a full checkout of the new branch, kept outside your repo at
`~/.dev-agent/runs/<project>/<KEY>/worktrees/<repo>`. Run the app from there. Your own checkout is untouched.

At Gate 2 you can choose no repo for a commit. The changes then stay as uncommitted edits in the worktree,
ready to test. (A local commit is also safe, because nothing is pushed.)

1. Find the worktree and look at the change:

```bash
ls ~/.dev-agent/runs/<project>/<KEY>/worktrees/
cd ~/.dev-agent/runs/<project>/<KEY>/worktrees/<repo>
git branch --show-current
git status
git diff
```

2. Copy your `.env` into the worktree. A worktree has only tracked files, and the agent cannot read or copy
   `.env`, so you do this. Never commit it.

```bash
cp "<path-to-your-repo>/.env" .env
```

3. Run the app from the worktree. `node_modules` is already linked from your checkout. Stop your own running
   copy of the same app first, or the ports clash. Use the repo's run command from your config
   (`node C:/dev-agent/scripts/config.mjs` prints it under `run`), for example:

```bash
npm run dev
pnpm dev
```

   With several repos, start the backend first, then the apps that call it, each in its own terminal inside its
   own worktree.

4. Test the behavior against the ticket's acceptance criteria, then run the repo's checks (`verify` in the
   config), for example `npm test` or `pnpm lint`. Compare against known baseline failures in the repo's
   `knownIssues`.

5. If it works, commit from the worktree. Stage files by name (`git add .` and `-A` are blocked by the
   agent's guard). If the guard is active, prefix the commit with `DEV_AGENT_COMMIT_OK=1`.

```bash
git add <file1> <file2>
git commit -m "<KEY>: <summary>"
```

6. If it does not work, edit the files in the worktree, or start Claude there and ask for specific fixes.
   To throw everything away, use `--force` (this deletes uncommitted work and keeps the branch name):

```bash
node C:/dev-agent/scripts/worktree.mjs remove --repo <path-to-your-repo> --dest <path-to-worktree> --force
```

### Review, push and open the PR

```bash
cd ~/.dev-agent/runs/<project>/<KEY>/worktrees/<repo>
git log --oneline -3
git diff <base>...HEAD
git push -u origin <branch>
```

Open the PR yourself with the text from `summary.md`.

### Remove the worktree when you are done (the branch is kept)

```bash
node C:/dev-agent/scripts/worktree.mjs remove --repo <path-to-your-repo> --dest <path-to-worktree>
```

Without `--force` this refuses if the worktree has uncommitted work.

To run the branch in your normal checkout instead: git will not check out a branch that a worktree holds, so
commit the work in the worktree, remove the worktree (command above), then run `git checkout <branch>` in your
repo.

## 8. Safety rules the agent follows

Blocked by hooks, not just by instructions:

- `git push`, `merge`, `stash`, `reset --hard`, `clean -f`, discarding changes
- `gh pr create/merge`, and write calls through `gh api`
- `git commit` until you approve it at Gate 2
- `git add -A`, `-u` and `.`
- reading or editing real `.env` files (`.env.example` is fine)
- editing `node_modules` or `.git`

## 9. Verify it locally before a real run

Do these in order. Checks 1 to 5 are read-only or use throwaway folders: they create no branches in your repos
and call no Jira. Replace `C:/dev-agent` with your clone, and `<folder>` with your repo or workspace folder.

**Check 1. The agent's own tests pass.**

```bash
cd C:/dev-agent
npm test
```

Expect `fail 0`. The tests build throwaway git repos, so your repos are not involved.

**Check 2. The agent sees your repos.** Prints the resolved config, which repos exist, and what was detected.

```bash
node C:/dev-agent/scripts/config.mjs --cwd "<folder>"
```

Look at these fields in the output:

- `configFile`: the `.dev-agent/config.json` you expect, or empty if you use zero-config.
- `repos[].exists`: must be `true` for every repo. `false` means a wrong `path`.
- `repos[].stack`, `verify`, `branchTemplate`: what the agent will run and name branches.
- `runsBase`: where plans and worktrees will be written.

To see the output as a short list:

```bash
node C:/dev-agent/scripts/config.mjs --cwd "<folder>" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);console.log(c.configFile);for(const r of c.repos)console.log(r.id,r.exists,r.stack.join(","),r.branchTemplate)})'
```

**Check 3. The safety guard blocks what it should.** This feeds the guard fake tool calls.
`exit=2` means blocked and `exit=0` means allowed.

```bash
cd C:/dev-agent
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | node hooks/guard.mjs; echo "exit=$?"
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"cat .env"}}' | node hooks/guard.mjs; echo "exit=$?"
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git status"}}' | node hooks/guard.mjs; echo "exit=$?"
```

Expect exit 2 with a `Blocked by dev-agent` message for the first two, and exit 0 for `git status`.
(These use the Claude Code event shape. The Antigravity shape is covered by `npm test`.)

**Check 4. (Antigravity only) The installer writes the files.** Use a throwaway folder first.

```bash
node C:/dev-agent/scripts/install.mjs --provider antigravity --dest "$TEMP/ag-test"
```

Expect four `wrote` lines (skill, two agents, `hooks.json`). Delete the folder afterwards. In PowerShell, use
`$env:TEMP` instead of `$TEMP`.

**Check 5. The agent loads.**

```bash
cd "<folder>"
claude --plugin-dir C:/dev-agent
```

Type `/dev-agent:` and confirm `solve-ticket` is listed. For Antigravity, install into the workspace (step 5)
and confirm `/solve-ticket` appears.

**Check 6. Ask the agent to break a rule.** Inside the running agent, ask: "run `git push` on any branch".
It must be refused with `Blocked by dev-agent`. If it is not, the hook is not active: stop and see
Troubleshooting. On Antigravity, also ask it to read a `.env` file from inside a subagent task, because hooks
inside subagents are not yet verified there.

**Check 7. A real run on a low-risk ticket.** This is the first step that changes anything: it fetches
`origin`, creates a branch and a worktree under `runs`, and commits only if you approve at Gate 2.
Pick a small ticket (a copy tweak, a log line). Run `/dev-agent:solve-ticket <KEY>` and confirm:

- [ ] The plan names the right repos, and it stops at Gate 1.
- [ ] The branch name matches the pattern (for example `Backend/NOVA-145/ShortName`).
- [ ] Nothing happened in your own checkout: `git -C <repo> status` is unchanged.
- [ ] The diff in the worktree is small and only touches what the ticket needs.
- [ ] `summary.md` lists branches, results, PR text, and the manual checks.
- [ ] Nothing was pushed: `git -C <repo> branch -r` shows no new remote branch.

Then clean up (the branch is kept):

```bash
node C:/dev-agent/scripts/worktree.mjs remove --repo "<path-to-repo>" --dest "<path-to-worktree>"
```

### Nova Aid

Use the same checks with these values. The folder is `C:/Users/Dell/Desktop/Nova aid`, and it needs
`.dev-agent/config.json` and `.dev-agent/context.md` (copy them from `config/examples/nova-aid/`).

```bash
node C:/dev-agent/scripts/config.mjs --cwd "C:/Users/Dell/Desktop/Nova aid"
```

Expect five repos, all `exists: true`, all stack `node`, with these branch prefixes:

| Repo | Path | Branch prefix |
|---|---|---|
| api-server | `api-server/api-server` | `Backend/<KEY>/...` |
| agent-panel | `agent-panel/agent-panel` | `Agent/<KEY>/...` |
| admin-panel | `admin-panel` | `Admin/<KEY>/...` |
| web-widget | `web-widget/web-widget` | `Widget/<KEY>/...` |
| landing-website | `landing-website` | `Landing/<KEY>/...` |

Then start the agent from that folder and run the ticket:

```bash
cd "C:/Users/Dell/Desktop/Nova aid"
claude --plugin-dir C:/dev-agent
```

```
/dev-agent:solve-ticket NOVA-145
```

Nova Aid specifics when you review the run:

- `api-server`: `npm test` has 18 known failures on `main` (older LLM tests and tests that need MongoDB).
  The agent compares against that baseline, so a failing count of 18 is not a regression.
- Anything needing `.env`, MongoDB, RabbitMQ or Redis appears under "Manual checks for the developer".
- `api-server` is built first, then the callers (`agent-panel`, `admin-panel`, `web-widget`, `landing-website`).

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| `/dev-agent:solve-ticket` not found | Start Claude with `--plugin-dir`, and check the path |
| Agent plans the wrong repos | Add `.dev-agent/config.json` (step 4), then run `node C:/dev-agent/scripts/config.mjs` |
| Can't read the Jira ticket | Reconnect the Atlassian connector, or paste the ticket text |
| `git fetch origin main failed: Repository not found`, nothing was built | Not an agent bug: git cannot reach the remote with its current GitHub login (GitHub says "not found" for a private repo you cannot see). Check with `git ls-remote --heads origin` in the repo. Then run `cmdkey /list \| findstr -i github` and `cmdkey /delete:git:https://github.com`, run `git ls-remote --heads origin` again, and sign in with the account that has access. If the repo moved, use `git remote set-url origin <new-url>`. Then run the ticket again |
| Worktree has no `.env`, app won't start | Copy it from your checkout (section 7). The agent never reads or copies it |
| "Branch already exists" | Use a new branch name, or remove the old worktree and branch yourself |
| Removal refused | The worktree has uncommitted work. Commit it, or add `--force` only if you want it gone |
| Tests not run because they need `.env` or a database | Expected. Run those checks by hand from the "Manual checks" list |
| `/solve-ticket` not found in Antigravity | Run the installer (step 5), reopen the workspace, and check that `.agents/skills/solve-ticket/SKILL.md` exists |
| Installer says `hooks.json is not valid JSON` | Fix or remove `.agents/hooks.json` (or `~/.gemini/config/hooks.json`), then run it again |
| Antigravity guard not firing | The Antigravity adapter is not yet verified in the real IDE. Check `.agents/hooks.json`, and whether hooks fire inside subagents (if not, the builder is unguarded, so review every diff) |
| Antigravity subagent can't run tests | Its default command policy may block them. Add `commandExecutionPolicy: auto` to the subagent's `agent.md`, then check the safety hook still fires |
