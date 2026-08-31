import {
	applyStripeRefundRepair,
	approveStripeRefundRepair,
} from "./procedures/admin-stripe-refund-repairs";
import { cancelPurchaseSubscription } from "./procedures/cancel-subscription";
import { createCheckoutLink } from "./procedures/create-checkout-link";
import { createCustomerPortalLink } from "./procedures/create-customer-portal-link";
import { getCheckoutReturnState } from "./procedures/get-checkout-return-state";
import { getProviderAvailability } from "./procedures/get-provider-availability";
import { listPurchases } from "./procedures/list-purchases";

export const paymentsRouter = {
	approveStripeRefundRepair,
	applyStripeRefundRepair,
	cancelPurchaseSubscription,
	createCheckoutLink,
	createCustomerPortalLink,
	listPurchases,
	getCheckoutReturnState,
	getProviderAvailability,
};
