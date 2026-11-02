// Safety rules for the developer agent. Pure functions, so they can be tested without Claude Code.
// Each check returns null when allowed, or a short reason string when the action must be blocked.

const SAFE_ENV_FILES = /^\.env\.(example|sample|template)$/i;

export function isSecretFile(filePath) {
  const base = String(filePath).replace(/\\/g, "/").split("/").pop();
  return /^\.env(\..+)?$/i.test(base) && !SAFE_ENV_FILES.test(base);
}

// Splits a shell line into simple commands so "cd x && git push" is still caught
function segments(command) {
  return String(command)
    .split(/&&|\|\||;|\||\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Leading VAR=value assignments of a command, for example `NOVA_COMMIT_OK=1 git commit`
const ENV_PREFIX = /^((?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+)/;

// Drops leading VAR=value assignments and a `git -C path` / `git -c k=v` prefix
function normalise(segment) {
  return segment
    .replace(ENV_PREFIX, "")
    .replace(/^git(?:\s+(?:-C|-c)\s+(?:"[^"]*"|'[^']*'|\S+))+/, "git");
}

const GIT_RULES = [
  [/^git\s+push\b/, "git push is not allowed. The developer pushes and opens PRs."],
  [/^git\s+merge\b/, "git merge is not allowed. The developer merges."],
  [/^git\s+stash\b/, "git stash could hide the developer's uncommitted work. Ask the developer instead."],
  [/^git\s+reset\s+.*--hard\b/, "git reset --hard would discard work. Ask the developer instead."],
  [/^git\s+clean\s+.*-[a-z]*f/, "git clean -f would delete files. Ask the developer instead."],
  [/^git\s+checkout\s+(?:.*\s)?--\s/, "Discarding changes with git checkout -- is not allowed. Ask the developer instead."],
  [/^git\s+restore\b(?!.*--staged)/, "git restore would discard changes. Ask the developer instead."],
  // Worktrees are created and removed only by scripts/worktree.mjs, which applies the same branch rules
  [/^git\s+worktree\s+(remove|prune|move)\b/, "Worktrees are removed only with scripts/worktree.mjs, and only when the developer asks."],
];

const GH_RULES = [
  [/^gh\s+pr\s+(create|merge|close|edit|comment|review|ready)\b/, "Opening or changing PRs is not allowed. The developer does it."],
  [/^gh\s+(issue|release)\s+(create|edit|comment|close|delete)\b/, "Changing GitHub issues or releases is not allowed."],
  [/^gh\s+api\b.*(-X|--method)\s*=?\s*(POST|PUT|PATCH|DELETE)\b/i, "Write calls through gh api are not allowed."],
];

function leadingEnv(segment) {
  const match = ENV_PREFIX.exec(segment);
  const out = {};
  if (!match) return out;
  for (const assignment of match[1].trim().split(/\s+/)) {
    const i = assignment.indexOf("=");
    out[assignment.slice(0, i)] = assignment.slice(i + 1);
  }
  return out;
}

function commitApproved(env) {
  return env.NOVA_DEV_ALLOW_COMMIT === "1" || env.NOVA_COMMIT_OK === "1";
}

function checkGit(seg, env) {
  for (const [re, reason] of GIT_RULES) {
    if (re.test(seg)) return reason;
  }

  if (/^git\s+commit\b/.test(seg) && !commitApproved(env)) {
    return "git commit is blocked until the developer approves it. After they approve, prefix the command with NOVA_COMMIT_OK=1. Otherwise give them the commit message.";
  }

  if (/^git\s+add\b/.test(seg) && /\s(-A|--all|-u|--update|\.)(\s|$)/.test(seg)) {
    return "Stage files explicitly by name (no git add -A, -u or .).";
  }

  if (/\s--no-verify\b|\s--no-gpg-sign\b/.test(seg)) {
    return "Skipping hooks or signing is not allowed.";
  }

  const createsBranch =
    /^git\s+(checkout|switch)\s+(?:.*\s)?(-b|-B|-c|-C)\b/.test(seg) ||
    /^git\s+branch\s+(?!-)\S/.test(seg) ||
    /^git\s+worktree\s+add\s+(?:.*\s)?(-b|-B)\b/.test(seg);
  if (createsBranch && !/--no-track\b/.test(seg)) {
    return "New branches must be created with --no-track from an updated base (git checkout --no-track -b <name>).";
  }
  return null;
}

// Any token that points at a real .env file (not .env.example) is blocked
function checkSecretTokens(seg) {
  const tokens = seg.split(/[\s"'=<>]+/).filter(Boolean);
  const hit = tokens.find((t) => isSecretFile(t));
  return hit ? `Secret file ${hit} must not be read or copied. Use .env.example, or ask the developer.` : null;
}

export function checkCommand(command, env = {}) {
  for (const raw of segments(command)) {
    const seg = normalise(raw);
    if (/^git\b/.test(seg)) {
      const reason = checkGit(seg, { ...env, ...leadingEnv(raw) });
      if (reason) return reason;
    }
    if (/^gh\b/.test(seg)) {
      for (const [re, reason] of GH_RULES) {
        if (re.test(seg)) return reason;
      }
    }
    const secret = checkSecretTokens(seg);
    if (secret) return secret;
  }
  return null;
}

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Grep", "Glob"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function checkFileTool(toolName, input = {}) {
  if (!FILE_TOOLS.has(toolName)) return null;

  const targets = [input.file_path, input.notebook_path, input.path, input.glob, input.pattern].filter(
    (v) => typeof v === "string" && v,
  );

  for (const target of targets) {
    if (isSecretFile(target) || /(^|[\\/])\.env(\.\*|\*)/.test(target)) {
      return `Secret file ${target} must not be read or changed. Use .env.example, or ask the developer.`;
    }
  }

  if (WRITE_TOOLS.has(toolName)) {
    const filePath = String(input.file_path ?? input.notebook_path ?? "");
    if (/(^|[\\/])(node_modules|\.git)[\\/]/.test(filePath)) {
      return "Editing node_modules or .git is not allowed.";
    }
  }
  return null;
}

// Entry used by the hook runner
export function check(toolName, toolInput = {}, env = {}) {
  if (toolName === "Bash" || toolName === "PowerShell") {
    return checkCommand(toolInput.command ?? "", env);
  }
  return checkFileTool(toolName, toolInput);
}
