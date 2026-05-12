import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { makeTmpRepo, type TmpRepo } from './tmp.js';

/** Build a minimal MERN-shaped repo with a known component structure. */
export function buildExpressTiny(): TmpRepo {
  const r = makeTmpRepo('compass-fx-express-');
  r.write('package.json', JSON.stringify({ name: 'express-tiny', version: '0.0.0' }, null, 2));
  r.write('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }, null, 2));
  r.write('.compassignore', `node_modules/\ndist/\n*.test.ts\n`);

  // API layer (C1)
  r.write('src/api/users.ts', `
import { UserService } from '../services/user.js';
import { authMiddleware } from '../utils/auth.js';
export const userRoutes = {
  list: async () => { authMiddleware(); return new UserService().list(); },
};
`);
  r.write('src/api/billing.ts', `
import { BillingService } from '../services/billing.js';
export const billingRoutes = {
  charge: (amt: number) => new BillingService().charge(amt),
};
`);

  // Services (C2)
  r.write('src/services/user.ts', `
import { UserRepo } from '../repositories/user.js';
export class UserService {
  private repo = new UserRepo();
  list() { return this.repo.findAll(); }
}
`);
  r.write('src/services/billing.ts', `
import { BillingRepo } from '../repositories/billing.js';
export class BillingService {
  private repo = new BillingRepo();
  charge(amt: number) { return this.repo.record(amt); }
}
`);

  // Repositories (C3)
  r.write('src/repositories/user.ts', `
export class UserRepo {
  async findAll() { return []; }
}
`);
  r.write('src/repositories/billing.ts', `
export class BillingRepo {
  async record(amt: number) { return { amt }; }
}
`);

  // Utils (C4)
  r.write('src/utils/auth.ts', `
import { log } from './logger.js';
export function authMiddleware() { log('auth'); }
`);
  r.write('src/utils/logger.ts', `export const log = (s: string) => console.log(s);`);
  return r;
}

/** Init a git repo, stage everything, commit. Returns the HEAD SHA. */
export function gitInit(root: string, message = 'initial'): string {
  execSync('git init -q', { cwd: root });
  execSync('git config user.email "t@t.t"', { cwd: root });
  execSync('git config user.name "t"', { cwd: root });
  execSync('git add -A', { cwd: root });
  execSync(`git commit -q -m "${message}"`, { cwd: root });
  return execSync('git rev-parse HEAD', { cwd: root }).toString().trim();
}

export function gitCommit(root: string, message: string): string {
  execSync('git add -A', { cwd: root });
  execSync(`git commit -q -m "${message}"`, { cwd: root });
  return execSync('git rev-parse HEAD', { cwd: root }).toString().trim();
}

export const fixtureDir = join(__dirname, '..', 'fixtures');
