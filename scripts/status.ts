#!/usr/bin/env -S npx tsx
import { existsSync, statSync } from 'node:fs';
import { relative, join } from 'node:path';
import { loadState } from '../src/lib/state.ts';
import { walk, hashFile } from '../src/lib/walk.ts';
import { statePath } from '../src/lib/paths.ts';

const root = process.cwd();
const sPath = statePath(root);

if (!existsSync(sPath)) {
  console.log('no analysis yet — run /compass-scan');
  process.exit(0);
}

const s = loadState(sPath);
if (!s) {
  console.log('state.json is malformed; run /compass-scan to start over');
  process.exit(0);
}

if (s.phase !== 'done') {
  console.log(`last run did not finish (phase=${s.phase}) — run /compass-recover`);
  if (s.last_error) console.log(`  last_error: ${s.last_error}`);
  process.exit(0);
}

const currentFiles = walk(root);
const currentByRel = new Map<string, string>();
for (const abs of currentFiles) currentByRel.set(relative(root, abs), abs);

const changed: string[] = [];
const added: string[] = [];
const deleted: string[] = [];

for (const [rel, entry] of Object.entries(s.files)) {
  if (!currentByRel.has(rel)) {
    deleted.push(rel);
    continue;
  }
  const abs = currentByRel.get(rel)!;
  if (hashFile(abs) !== entry.sha256) changed.push(rel);
}
for (const rel of currentByRel.keys()) {
  if (!s.files[rel]) added.push(rel);
}

const staleSet = new Set<string>();
for (const rel of changed) {
  const cid = s.files[rel]?.component_id;
  if (cid) staleSet.add(cid);
}
for (const rel of deleted) {
  const cid = s.files[rel]?.component_id;
  if (cid) staleSet.add(cid);
}

const total = changed.length + added.length + deleted.length;
console.log(`[compass] last run: ${s.last_run_at ?? 'unknown'} depth=${s.depth} phase=${s.phase}`);
console.log(`[compass] components: ${s.stats.components_post_llm}`);

if (total === 0) {
  console.log('working tree up to date — no stale components');
  process.exit(0);
}

for (const f of changed) console.log(`changed: ${f} (component=${s.files[f]?.component_id ?? '?'})`);
for (const f of added) console.log(`new:     ${f}`);
for (const f of deleted) console.log(`deleted: ${f} (component=${s.files[f]?.component_id ?? '?'})`);

const staleCount = staleSet.size;
const compWord = staleCount === 1 ? '1 component' : `${staleCount} components`;
console.log(`STALE: ${compWord} affected by ${total} changed files`);
console.log('suggestion: run /compass-refresh');

// Hint: this script is read-only — no lock, no state mutation.
void join;
void statSync;
