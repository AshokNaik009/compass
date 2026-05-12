import { UserService } from '../services/user.js';
import { authMiddleware } from '../utils/auth.js';

export const userRoutes = {
  list: async () => {
    authMiddleware();
    return new UserService().list();
  },
};
