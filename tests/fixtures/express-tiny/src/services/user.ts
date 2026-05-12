import { UserRepo } from '../repositories/user.js';

export class UserService {
  private repo = new UserRepo();
  list() { return this.repo.findAll(); }
}
