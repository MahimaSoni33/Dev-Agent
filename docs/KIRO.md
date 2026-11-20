# Using Dev Agent with Kiro (IDE and CLI)

Kiro is a host, like Antigravity. Dev Agent makes **no API calls** to Kiro and stores **no credentials**: the skill, the
two subagents and the safety guard are generated into Kiro's own folders, and Kiro runs them with your own sign-in.

## Set up

1. Install Kiro (IDE and/or `kiro-cli`, CLI 2.0 or later) and sign in:
   - Browser sign-in: `kiro-cli login` (the IDE signs in on first launch).
   - Headless / CI: set `KIRO_API_KEY` in your own environment. API keys work only on Kiro Pro, Pro+, Pro Max and Power
     plans; admin-managed accounts need an admin to enable them. A browser sign-in takes precedence over the key.
     `kiro-cli whoami` shows which one is active.
2. Install Dev Agent into a workspace (or `--scope global` for every workspace):
   ```
   node scripts/install.mjs --provider kiro --dest <workspace>
   ```
   This writes, under `<workspace>/.kiro/` (or `~/.kiro/`):

   | File | Used by | Purpose |
   |---|---|---|
   | `steering/dev-agent.md` | IDE and CLI | the solve-ticket flow, `inclusion: manual` so it stays out of ordinary chats |
   | `agents/repo-builder.json`, `repo-reviewer.json` | CLI custom agents | the subagents, with the guard and usage hooks |
   | `hooks/dev-agent-guard.kiro.hook` | IDE | safety guard before shell, read and write tools |
   | `hooks/dev-agent-usage.kiro.hook` | IDE | counts one request per agent run |

   Files Dev Agent did not write are saved as `.bak` first. Run the installer again after editing the skill or agents.
3. Check: `node scripts/doctor.mjs --cwd <workspace>`. Kiro checks only ever produce `ok`, `warn` or `info`, so they never
   make an Antigravity setup "not ready".
4. Start: in the IDE, add `#dev-agent` to the chat and describe the ticket. In the CLI, load the steering file or start
   the custom agent (`kiro-cli chat`, then pick the agent; confirm the exact option with `kiro-cli chat --help`).

The generated agents pre-approve only read-only tools (`fs_read`, `grep`, `glob`). Kiro asks before writing or running
commands. To run unattended, widen `allowedTools` in the agent file yourself.

## Environment variables

| Variable | Meaning |
|---|---|
| `KIRO_API_KEY` | Kiro's own headless sign-in. Dev Agent only checks whether it is set; it never reads, logs or stores the value. |
| `DEV_AGENT_RUNS_DIR` | Where `runs/<ticket>/usage.json` and `usage.log.jsonl` are written (default: `runs/` in this folder). |

## Session usage: how it works

Every provider session is one record in `runs/<ticket>/usage.json`, keyed `provider:sessionId`. A record is replaced,
never added to, so one session can never leak into another. Every update is also appended to
`runs/<ticket>/usage.log.jsonl` (one JSON line each) for debugging and audit.

- Claude sessions are measured in **tokens** (unchanged).
- Kiro sessions are measured in **credits**, which are not tokens and not money. Dev Agent never converts between them and
  never prices Kiro sessions.
- A Kiro session records its surface (`ide` or `cli`), session id, request count, and the model if the hook payload names it.
- Credits come in three labelled kinds: `measured` (read from an official Kiro output), `user-reported` (you typed the
  figure you read in Kiro) and `unavailable`. Unavailable is stored as `null`, never `0`.

```
node scripts/usage.mjs show --ticket NOVA-7        # sessions and totals, tokens and credits apart
node scripts/usage.mjs history                     # one line per ticket
node scripts/usage.mjs credits --ticket NOVA-7 --session <id> --credits 4.2
npm run scorecard -- --run-dir runs/NOVA-7         # delivery quality plus a "Credits (Kiro)" section
```

The Kiro stop hook also prints one line when it runs, for example
`dev-agent usage: kiro ide, session abc: 3 request(s), credits unavailable (...)`. Whether Kiro shows hook stderr in
its UI is not documented; the numbers are always in the files above.

## Known limitations (read before trusting a number)

- **Exact credits are not available automatically.** Kiro's documentation describes credits in the IDE chat panel, the
  `/usage` command, the web portal and the enterprise dashboard, and no way to read them from a hook. Dev Agent does not
  use undocumented files or endpoints (for example Kiro's private session files), so credits start as *unavailable*.
  Read them in Kiro and record them with `usage.mjs credits` if you need them in the report.
- **No token counts.** Kiro CLI does not report token usage, so Kiro sessions never show tokens.
- **No remaining-credit figure.** Dev Agent has no official source for it and shows none.
- **Credits in the report may be incomplete.** The report says how many sessions have no figure.
- **Session ids.** If Kiro's hook payload carries no session id, one is derived (surface, folder, day) and flagged
  `derived`; two Kiro sessions in the same folder on the same day would then share a record.
- **Request count is the number of times the stop hook ran**, not a count of model calls.
- **Hook field names are unverified.** Kiro's hook schema differs between CLI 2.x and V3, and the IDE hook payload is not
  fully documented. The tool names (`execute_bash`, `fs_read`, ...), the exit-code-2 block convention, the `.kiro.hook`
  fields and whether the IDE passes the event on stdin are built from the docs and unit-tested, but **not yet confirmed
  against a live Kiro**. Until you have, the guard may not fire in Kiro.

## Confirm against your Kiro (one probe run)

```
node scripts/install.mjs --provider kiro --dest <workspace> --probe on
```

Use Kiro for a short task (IDE and, if you use it, CLI). The probe appends every raw hook event to
`dev-agent-dump.jsonl` in your temp folder (set `DEV_AGENT_DUMP` to change it). Check that: the guard's tool names and
fields match `providers/tools.mjs`, a blocked call is actually blocked, the payload has a session id, and whether any
credit figure appears. Run the installer again without `--probe` to remove the probe.

## Files added or changed for Kiro

New: `providers/kiro.mjs`, `hooks/kiro-usage.mjs`, `scripts/usage.mjs`, `docs/KIRO.md` and their tests.
Changed: `providers/usage.mjs` (credit sessions, usage log), `providers/tools.mjs` (Kiro tool mapping),
`hooks/guard.mjs` (judges every path in a multi-file Kiro read), `scripts/install.mjs` (`--provider kiro`),
`scripts/doctor.mjs`, `scripts/setup.mjs` (hint only), `scripts/scorecard.mjs`, `package.json`, `README.md`.
