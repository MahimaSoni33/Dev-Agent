# Dev-Agent speed and autonomy (version 0.4)

Design rule: remove waiting and repeated work, keep every check. Every tier keeps the independent reviewer, and every
agent uses the host's full model unless `rules.models` says otherwise.

Why simple tickets were slow, what changed, what was measured, and what is still open.

## 1. Where the time went (measured, not assumed)

Source: the real run of `/solve-ticket 162` (NOVA-162, one-file tooltip change, Claude Sonnet), read from its
Claude Code transcript with `scripts/metrics.mjs`.

| | LLM calls | New input tokens | Cache-read tokens | Notes |
|---|---|---|---|---|
| Conductor | 36 | 61k | 2.9M | 5 wake-ups and 1 agent listing spent waiting for subagents |
| `repo-builder` | 31 | 54k | 1.1M | baseline lint/build/test, then the same again; one `find /` for a skill file took 121 s |
| `Explore` | 9 | 40k | 0.2M | reading code the conductor could have grepped |
| `repo-reviewer` | 13 | 73k | 0.3M | 32% of all new input tokens, for a one-file diff |
| **Total** | **89** | **227k** | **4.5M** | 95 tool calls, 3 subagents, 4 human stops, 883 s active (8,624 s wall) |

Of the 883 s of active time only about 256 s was tool execution. **The rest is LLM latency, so cutting LLM calls and
subagent round trips is what makes a task faster.** The causes:

1. **One flow for every task.** `Size: small` was written into the plan and then ignored: the same triage, plan gate,
   builder, reviewer and commit gate ran. Four of five repos were assessed and marked "No".
2. **Verification ran twice, serially.** Baseline for every command, then every command again (lint 47 s + 26 s,
   build 37 s + 36 s). The baseline was never reused, although `worktree.mjs` already returns the base sha.
3. **A reviewer agent for every diff**, which re-reads instructions and re-runs checks the builder just ran.
4. **Instruction hunting.** `detect.mjs` only found task skills at `.claude/skills/*task*`, so the builder searched
   the disk.
5. **Polling** for subagent results.
6. **No metrics.** The usage hook recorded tokens only, so there was no way to compare two runs.

## 2. What changed

| Change | File | Effect |
|---|---|---|
| Task triage, no LLM call: simple / medium / complex, plus "needs a human" signals (security, deleting data, contracts, vague criteria) | `scripts/triage.mjs`, `SKILL.md` "Execution tiers" | Picks the flow and the models. Sensitive wording is never fast-pathed. The tier can be raised, never lowered. |
| Plan gate becomes conditional: `rules.planGate` is `auto` by default, `always` keeps the old behaviour | `SKILL.md` step 6, `config.mjs` | No approval stop for simple and medium tasks that have no trigger |
| Short path for simple tasks: brief ticket review, one repo, compact plan, no Explore subagent, one combined summary-and-commit question | `SKILL.md` steps 3, 4, 5, 8 | Fewer calls and one human stop instead of two |
| Verify runs once, in parallel; baseline only for commands that fail, on a throwaway checkout of the base sha, cached by sha + command | `scripts/verify.mjs` | A clean change pays for no baseline at all; later tickets on the same base pay none either |
| **Verify and review overlap**: the builder stops after implementing (`mode: implement`); the conductor then runs `verify.mjs`, `diffcheck.mjs` and the `repo-reviewer` agent in one message; one fix round (`mode: fix`) follows if needed | `SKILL.md` step 7, `repo-builder.md`, `repo-reviewer.md` | The reviewer reads while lint/build/test run. Every tier is still independently reviewed |
| `diffcheck.mjs` runs before the reviewer on every tier (free: secrets, build output, leftovers, reformat-only edits, size) | `scripts/diffcheck.mjs` | The reviewer spends its effort on logic, not mechanics |
| Prefetch: worktrees are created in the same message that writes the plan (or while the developer reads it) | `SKILL.md` step 5 | One sequential step less |
| `SKILL.md` rewritten more tightly (17.1 KB to 15.8 KB, with the new features in) | `SKILL.md` | Less read on each conductor turn |
| Optional model tiering: `rules.models` (`simple`, `medium`, `complex`, `reviewer`); empty by default | `config.mjs` | Opt-in saving, not a default quality trade |
| Task skills found under `.claude/skills` and `.agents/skills`; builder told never to search outside the worktree | `detect.mjs`, `repo-builder.md` | No disk-wide searches |
| No polling; independent calls go out in one message; long context files digested once into `RUN/context.md` | `SKILL.md` | Fewer conductor turns |
| Run metrics: active vs wall time, LLM calls, tool calls, subagents, human stops, tokens | `scripts/metrics.mjs` (`npm run metrics -- <session.jsonl> ...`) | The before/after comparison below |

Unchanged, on purpose: the commit still needs the developer's approval (hook-enforced), nothing is pushed, the guard
hooks apply to every agent, and a config with `"planGate": "always"` behaves as before.

## 3. Benchmark

**Measured (real runs of the new scripts):**

| Check | Before | After |
|---|---|---|
| Verification of 4 test commands in this repo (baseline + after, serial, vs one parallel pass) | 42.2 s | **14.0 s** (3.0x), 0 baseline runs |
| Triage of the real NOVA-162 ticket text | n/a (full flow) | **simple**, repo `agent-panel`, `diffcheck+agent`, host model (after a word-matching bug found by this very test was fixed: "config" had matched "configured" and made it look like a two-repo task) |
| Conductor prompt size (`SKILL.md`) | 11.7 KB | 15.8 KB (grew, but 1.3 KB smaller than the first 0.4 draft) |

**Estimate for a NOVA-162-sized ticket, from the measured breakdown above. Not measured end to end:**

| | Before (measured) | After (estimated) | Why |
|---|---|---|---|
| LLM calls | 89 | about 65 | no Explore (-9), no polling (-6), no duplicate verification (about -5), reviewer a little shorter (-3) |
| New input tokens | 227k | about 170k | Explore 40k saved, reviewer no longer re-runs checks |
| Human stops | 4 (2 questions + 2 messages) | 1 | the plan gate is automatic; commit and summary are one question |
| Wall-clock for checks and review | about 215 s verify, then the reviewer in sequence | verify and review overlap, about 90 s | parallel commands, no baseline when clean |

The estimate assumes the model follows the new SKILL.md. Code quality and task success rate are **not** measured
here: that needs several real tickets run on both versions.

## 4. How to reproduce the end-to-end comparison

1. Pick 3 or more tickets of different sizes. Run each once with `rules.planGate: "always"` and `rules.tier:
   "complex"` (the old behaviour) and once with the defaults, on the same base commit.
2. `npm run metrics -- <old-session>.jsonl <new-session>.jsonl` (transcripts are in
   `~/.claude/projects/<project>/`; subagent logs are picked up automatically).
3. Compare active time, LLM calls, new input tokens, human stops, and review the two diffs by hand for quality.

## 5. Remaining limitations

- Triage is keyword-based. It is deliberately conservative (unclear means medium), but it can still call a task
  simple that is not. The conductor may raise the tier, and `rules.tier` forces one.
- A fix round costs one extra builder start, because verification moved out of the builder's first pass. Tasks that
  fail verification on the first try pay that; clean ones save the time.
- Parallel verification assumes the commands can share a working tree. Use `--serial` otherwise.
- The "new failure" test compares failure lines with numbers removed. A different error on the same line shape
  can read as pre-existing; the builder still sees the tail of the output.
- `rules.models` aliases (`haiku`, `sonnet`) are Claude Code's. Other hosts ignore a model they do not know.
- Antigravity: the installer generates from the same `SKILL.md`, but the new flow has not been run in the real IDE.
- The Nova Aid example config still says `"planGate": "always"`; change it to `"auto"` to get the faster flow.
