import { BillingRepo } from '../repositories/billing.js';

export class BillingService {
  private repo = new BillingRepo();
  charge(amt: number) { return this.repo.create({ amt }); }
}
