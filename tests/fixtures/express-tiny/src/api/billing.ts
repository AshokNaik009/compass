import { BillingService } from '../services/billing.js';

export const billingRoutes = {
  charge: (amt: number) => new BillingService().charge(amt),
};
