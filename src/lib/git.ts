import { execFileSync, execSync } from 'node:child_process';

export function isGitRepo(root: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function revParseHEAD(root: string): string | null {
  if (!isGitRepo(root)) return null;
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    if (/^[0-9a-f]{40}$/.test(out)) return out;
    return null;
  } catch {
    // empty repo — HEAD doesn't resolve yet
    return null;
  }
}

function shaExists(root: string, sha: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', sha], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Names of files that differ between base..head (or HEAD..working-tree when
 * head === 'WORKDIR').
 *
 * For renames, returns BOTH old and new paths so the refresh classifier can
 * see the delete + add (SPEC §6.2 — UNSAFE on deleted file).
 */
export function diffNames(root: string, base: string, head: string): string[] {
  if (!isGitRepo(root)) {
    throw new Error(`diffNames: ${root} is not a git repository (caller should check isGitRepo first)`);
  }
  if (base === head) return [];

  if (head !== 'WORKDIR' && !shaExists(root, base)) {
    // unreachable base SHA (force-push, etc.) — caller falls back to hash diff
    return [];
  }

  const args = ['diff', '--name-only', '--no-renames'];
  if (head === 'WORKDIR') {
    args.push(base);
  } else {
    args.push(`${base}..${head}`);
  }
  try {
    const out = execFileSync('git', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    const names = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('.git/'));
    return Array.from(new Set(names)).sort();
  } catch {
    return [];
  }
}
