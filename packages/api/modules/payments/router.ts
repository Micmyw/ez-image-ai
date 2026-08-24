import {
	applyStripeRefundRepair,
	approveStripeRefundRepair,
} from "./procedures/admin-stripe-refund-repairs";
import { createCheckoutLink } from "./procedures/create-checkout-link";
import { createCustomerPortalLink } from "./procedures/create-customer-portal-link";
import { getCheckoutReturnState } from "./procedures/get-checkout-return-state";
import { listPurchases } from "./procedures/list-purchases";

export const paymentsRouter = {
	approveStripeRefundRepair,
	applyStripeRefundRepair,
	createCheckoutLink,
	createCustomerPortalLink,
	listPurchases,
	getCheckoutReturnState,
};
