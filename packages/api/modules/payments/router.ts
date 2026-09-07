import {
	applyStripeRefundRepair,
	approveStripeRefundRepair,
} from "./procedures/admin-stripe-refund-repairs";
import { cancelPurchaseSubscription } from "./procedures/cancel-subscription";
import { capturePayPalCreditPackCheckout } from "./procedures/capture-paypal-credit-pack-checkout";
import { createCheckoutLink } from "./procedures/create-checkout-link";
import { createCreditPackCheckout } from "./procedures/create-credit-pack-checkout";
import { createCustomerPortalLink } from "./procedures/create-customer-portal-link";
import { getCheckoutReturnState } from "./procedures/get-checkout-return-state";
import { getCreditPackCheckoutState } from "./procedures/get-credit-pack-checkout-state";
import { getCreditPackProviderAvailability } from "./procedures/get-credit-pack-provider-availability";
import { getProviderAvailability } from "./procedures/get-provider-availability";
import { listPurchases } from "./procedures/list-purchases";

export const paymentsRouter = {
	approveStripeRefundRepair,
	applyStripeRefundRepair,
	cancelPurchaseSubscription,
	capturePayPalCreditPackCheckout,
	createCheckoutLink,
	createCreditPackCheckout,
	createCustomerPortalLink,
	listPurchases,
	getCheckoutReturnState,
	getCreditPackCheckoutState,
	getCreditPackProviderAvailability,
	getProviderAvailability,
};
