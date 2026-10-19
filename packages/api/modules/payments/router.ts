import {
	getAdminCheckoutReview,
	resolveAdminCheckoutReview,
} from "./procedures/admin-checkout-review";
import { listAdminPaymentAttributionProcedure } from "./procedures/admin-payment-attribution";
import {
	applyStripeRefundRepair,
	approveStripeRefundRepair,
} from "./procedures/admin-stripe-refund-repairs";
import { cancelPurchaseSubscription } from "./procedures/cancel-subscription";
import { capturePayPalCreditPackCheckout } from "./procedures/capture-paypal-credit-pack-checkout";
import { capturePayPalImagePassCheckout } from "./procedures/capture-paypal-image-pass-checkout";
import { createCheckoutLink } from "./procedures/create-checkout-link";
import { createCreditPackCheckout } from "./procedures/create-credit-pack-checkout";
import { createCustomerPortalLink } from "./procedures/create-customer-portal-link";
import { createImagePassCheckout } from "./procedures/create-image-pass-checkout";
import { getCheckoutReturnState } from "./procedures/get-checkout-return-state";
import { getCreditPackCheckoutState } from "./procedures/get-credit-pack-checkout-state";
import { getCreditPackProviderAvailability } from "./procedures/get-credit-pack-provider-availability";
import { getImagePassCheckoutState } from "./procedures/get-image-pass-checkout-state";
import { getProviderAvailability } from "./procedures/get-provider-availability";
import { listPurchases } from "./procedures/list-purchases";
import {
	getPendingSubscriptionCheckout,
	refreshPendingSubscriptionCheckout,
	cancelPendingSubscriptionCheckout,
	resumePendingSubscriptionCheckout,
} from "./procedures/pending-subscription-checkout";

export const paymentsRouter = {
	listAdminPaymentAttribution: listAdminPaymentAttributionProcedure,
	getAdminCheckoutReview,
	resolveAdminCheckoutReview,
	getPendingSubscriptionCheckout,
	refreshPendingSubscriptionCheckout,
	cancelPendingSubscriptionCheckout,
	resumePendingSubscriptionCheckout,
	approveStripeRefundRepair,
	applyStripeRefundRepair,
	cancelPurchaseSubscription,
	capturePayPalCreditPackCheckout,
	capturePayPalImagePassCheckout,
	createImagePassCheckout,
	getImagePassCheckoutState,
	createCheckoutLink,
	createCreditPackCheckout,
	createCustomerPortalLink,
	listPurchases,
	getCheckoutReturnState,
	getCreditPackCheckoutState,
	getCreditPackProviderAvailability,
	getProviderAvailability,
};
