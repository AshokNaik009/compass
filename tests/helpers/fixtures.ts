import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { makeTmpRepo, type TmpRepo } from './tmp.js';

/** Build a minimal MERN-shaped repo with a known component structure. */
export function buildExpressTiny(): TmpRepo {
  const r = makeTmpRepo('compass-fx-express-');
  r.write('package.json', JSON.stringify({ name: 'express-tiny', version: '0.0.0' }, null, 2));
  r.write('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }, null, 2));

  // API layer (C1) — imports from services
  r.write('src/api/users.ts', `
import { Router } from 'express';
import { UserService } from '../services/user';
import { authMiddleware } from '../middleware/auth';

export const userRouter = Router();
userRouter.get('/', authMiddleware, async (req, res) => {
  const svc = new UserService();
  res.json(await svc.list());
});
`);
  r.write('src/middleware/auth.ts', `
export function authMiddleware(req: any, res: any, next: any) { next(); }
`);

  // Services (C2) — imports from repositories
  r.write('src/services/user.ts', `
import { UserRepo } from '../repositories/user';
export class UserService {
  private repo = new UserRepo();
  list() { return this.repo.findAll(); }
}
`);

  // Repositories (C3)
  r.write('src/repositories/user.ts', `
export class UserRepo {
  async findAll() { return []; }
}
`);

  // Utils (C4) — leaf
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
