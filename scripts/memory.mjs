// Project memory: short lessons the agent keeps between runs (conventions, decisions, recurring findings).
//   node memory.mjs add    --root <project root> --kind convention|decision|finding|failure --text "..." [--repo id] [--key PROJ-1]
//   node memory.mjs recall --root <project root> --query "ticket words" [--repo id] [--limit 8]
//   node memory.mjs list   --root <project root>
//   node memory.mjs forget --root <project root> --id <id>
// Stored as JSON lines in <root>/.dev-agent/memory.jsonl. Plain text only: secrets are refused, so the file is safe to commit.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "./runstate.mjs";

export const KINDS = ["convention", "decision", "finding", "failure"];
const MAX_ENTRIES = 200;
const MAX_TEXT = 240;
const STOP = new Set("the and for with that this from have has had not are was were but use used using into when then than add new fix make get can should must will would could its our your all any".split(" "));
const SECRET = /(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|secret|api[_-]?key|token|bearer)\b\s*[:=]\s*\S{6,}|\b[A-Za-z0-9+/_-]{40,}\b)/i;

const fileOf = (root) => path.join(root, ".dev-agent", "memory.jsonl");
const words = (s) => [...new Set(s.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g)?.filter((w) => !STOP.has(w)) ?? [])];
const idOf = (text) => crypto.createHash("sha1").update(text.toLowerCase().replace(/\W+/g, " ").trim()).digest("hex").slice(0, 8);

export function load(root) {
  try {
    return fs.readFileSync(fileOf(root), "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return []; // a damaged line is skipped, never fatal
      }
    });
  } catch {
    return [];
  }
}

function save(root, entries) {
  const file = fileOf(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
  fs.renameSync(tmp, file);
}

// Same lesson again strengthens the existing entry instead of adding a duplicate
export function add(root, { kind, text, repo = null, key = null }) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  text = String(text ?? "").replace(/\s+/g, " ").trim();
  if (text.length < 8) throw new Error("A lesson needs at least a short sentence");
  if (text.length > MAX_TEXT) throw new Error(`A lesson is at most ${MAX_TEXT} characters; shorten it`);
  if (SECRET.test(text)) throw new Error("Refused: the text looks like a secret or a token. Memory is plain text and may be committed.");
  const entries = load(root);
  const id = idOf(text);
  const hit = entries.find((e) => e.id === id);
  if (hit) {
    hit.seen += 1;
    hit.last = new Date().toISOString().slice(0, 10);
  } else {
    entries.push({ id, kind, repo, text, key, seen: 1, last: new Date().toISOString().slice(0, 10) });
  }
  // Over the cap, the least reinforced and oldest entries go first
  entries.sort((a, b) => b.seen - a.seen || b.last.localeCompare(a.last));
  save(root, entries.slice(0, MAX_ENTRIES));
  return { id, reinforced: Boolean(hit), total: Math.min(entries.length, MAX_ENTRIES) };
}

export function recall(root, { query = "", repo = null, limit = 8 }) {
  const q = new Set(words(query));
  // A lesson tied to another repo never applies here, however many words match
  const scored = load(root).filter((e) => !(repo && e.repo && e.repo !== repo)).map((e) => {
    const overlap = words(e.text).filter((w) => q.has(w)).length;
    const repoHit = repo && e.repo === repo ? 2 : 0;
    // A convention applies broadly, so it keeps a small base score even with no word overlap
    const score = overlap * 3 + repoHit + Math.min(e.seen, 5) * 0.5 + (e.kind === "convention" ? 1 : 0);
    return { e, score, relevant: overlap > 0 || repoHit > 0 || e.kind === "convention" };
  });
  return scored.filter((s) => s.relevant && s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.e);
}

export const render = (entries) => entries.map((e) => `- [${e.kind}${e.repo ? `:${e.repo}` : ""}] ${e.text}`).join("\n");

export function forget(root, id) {
  const entries = load(root);
  const rest = entries.filter((e) => e.id !== id);
  if (rest.length === entries.length) throw new Error(`No lesson with id ${id}`);
  save(root, rest);
  return { removed: id };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [cmd, ...rest] = process.argv.slice(2);
    const o = parseArgs(rest);
    if (typeof o.root !== "string") throw new Error("Usage: memory.mjs add|recall|list|forget --root <project root> ...");
    const root = path.resolve(o.root);
    if (cmd === "add") console.log(JSON.stringify(add(root, { kind: o.kind, text: o.text, repo: o.repo ?? null, key: o.key ?? null })));
    else if (cmd === "recall") console.log(render(recall(root, { query: String(o.query ?? ""), repo: o.repo ?? null, limit: Number(o.limit ?? 8) })));
    else if (cmd === "list") console.log(JSON.stringify(load(root), null, 2));
    else if (cmd === "forget") console.log(JSON.stringify(forget(root, o.id)));
    else throw new Error(`Unknown command: ${cmd}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
