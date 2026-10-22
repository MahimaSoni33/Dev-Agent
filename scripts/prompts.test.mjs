import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const skill = read('skills/solve-ticket/SKILL.md');
const builder = read('agents/repo-builder.md');
const reviewer = read('agents/repo-reviewer.md');

test('every prompt file has frontmatter with name and description', () => {
  for (const text of [skill, builder, reviewer]) {
    const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(fm, 'frontmatter missing');
    assert.match(fm[1], /^name: \S+/m);
    assert.match(fm[1], /^description: .+/m);
  }
});

test('skill has the query rewriter and Jira story reviewer steps in order', () => {
  const rewriter = skill.indexOf('Query rewriter');
  const reviewStep = skill.indexOf('Jira story reviewer');
  const plan = skill.indexOf('## 5. Write the plan');
  assert.ok(rewriter > 0 && reviewStep > rewriter && plan > reviewStep);
  for (const word of ['vague', 'Ambiguities', 'Inspection needs', 'acceptance criteria']) {
    assert.ok(skill.includes(word), `missing: ${word}`);
  }
});

test('minimal-change rules reach the skill, builder and reviewer', () => {
  assert.match(skill, /Minimal change/);
  assert.match(builder, /## Code standards/);
  assert.match(reviewer, /Minimal and clean/);
});

test('step numbers in the skill are sequential', () => {
  const nums = [...skill.matchAll(/^## (\d+)\./gm)].map((m) => Number(m[1]));
  assert.deepEqual(nums, nums.map((_, i) => i + 1));
});
