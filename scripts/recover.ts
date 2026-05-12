#!/usr/bin/env -S npx tsx
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadState } from '../src/lib/state.ts';
import { statePath, lockPath, printCostLine } from '../src/lib/paths.ts';
import { acquireLock, releaseLock } from '../src/lib/lock.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const root = process.cwd();

const sPath = statePath(root);
const start = Date.now();

const initial = loadState(sPath);
if (!initial) {
  console.log('[compass] recover: no state.json — run /compass-scan');
  process.exit(0);
}
if (initial.phase === 'done') {
  console.log('[compass] recover: nothing to recover (phase=done)');
  process.exit(0);
}

// Lock guard: refuse only if a LIVE foreign holder still owns the lock.
const lock = acquireLock(lockPath(root));
if (!lock.acquired) {
  throw new Error(`[compass] recover refused — ${lock.reason}`);
}
// We're about to drive child scripts that each acquire their own lock.
releaseLock(lockPath(root));

function runScript(file: string, args: string[] = []) {
  execFileSync('npx', ['tsx', `${__dirname}/${file}`, ...args], { cwd: root, stdio: 'inherit' });
}

const phase = initial.phase;
console.log(`[compass] recover: resuming from phase=${phase}`);

switch (phase) {
  case 'walking':
  case 'failed':
    runScript('scan-walk.ts');
    runScript('scan-parse.ts');
    runScript('scan-cluster.ts');
    runScript('scan-propose.ts');
    runScript('scan-critique.ts');
    runScript('scan-render.ts');
    break;
  case 'parsing':
    runScript('scan-parse.ts');
    runScript('scan-cluster.ts');
    runScript('scan-propose.ts');
    runScript('scan-critique.ts');
    runScript('scan-render.ts');
    break;
  case 'clustering':
    runScript('scan-cluster.ts');
    runScript('scan-propose.ts');
    runScript('scan-critique.ts');
    runScript('scan-render.ts');
    break;
  case 'proposing':
    runScript('scan-propose.ts');
    runScript('scan-critique.ts');
    runScript('scan-render.ts');
    break;
  case 'critiquing':
    runScript('scan-critique.ts');
    runScript('scan-render.ts');
    break;
  case 'rendering':
    runScript('scan-render.ts');
    break;
  default:
    throw new Error(`[compass] recover: unknown phase ${phase}`);
}

const final = loadState(sPath);
console.log(`[compass] recovered to phase=${final?.phase} in ${Date.now() - start}ms`);
printCostLine(
  'recover',
  final?.stats.tokens_in_total ?? 0,
  final?.stats.tokens_out_total ?? 0,
  Date.now() - start,
);

