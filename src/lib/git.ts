import { execSync } from 'node:child_process';

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

export function currentCommit(root: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function changedFilesSince(root: string, sha: string): string[] {
  try {
    const out = execSync(`git diff --name-only ${sha}..HEAD`, {
      cwd: root,
      encoding: 'utf8',
    });
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

export function uncommittedFiles(root: string): string[] {
  try {
    const out = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' });
    return out
      .split('\n')
      .map((l) => l.trim().replace(/^.. /, ''))
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}
