import type { PaymentProviderName } from "../types";

export interface VerifiedPaymentEvent {
	providerEventId: string;
	normalizedTransactionId?: string;
	envelope: Record<string, unknown>;
}

type PaymentWebhookVerifier = (
	rawBody: string,
	headers: Headers,
) => Promise<VerifiedPaymentEvent> | VerifiedPaymentEvent;

interface PaymentWebhookDependencies {
	verifiers: Record<PaymentProviderName, PaymentWebhookVerifier>;
	persist(input: {
		provider: PaymentProviderName;
		providerEventId: string;
		normalizedTransactionId?: string;
		verifiedAt: Date;
		receivedAt: Date;
		envelope: Record<string, unknown>;
	}): Promise<{ replayed: boolean }>;
}

const signatureHeaders: Record<PaymentProviderName, string> = {
	stripe: "stripe-signature",
	paypal: "paypal-transmission-sig",
	waffo: "x-waffo-signature",
};

export function createPaymentWebhookHandler(dependencies: PaymentWebhookDependencies) {
	return async (request: Request): Promise<Response> => {
		const candidates = (
			Object.entries(signatureHeaders) as Array<[PaymentProviderName, string]>
		).filter(([, header]) => Boolean(request.headers.get(header)?.trim()));
		if (candidates.length !== 1) return new Response("Invalid request.", { status: 400 });

		const provider = candidates[0]![0];
		const rawBody = await request.text();
		let verified: VerifiedPaymentEvent;
		try {
			verified = await dependencies.verifiers[provider](rawBody, request.headers);
		} catch {
			return new Response("Invalid request.", { status: 400 });
		}

		try {
			const now = new Date();
			await dependencies.persist({
				provider,
				providerEventId: verified.providerEventId,
				normalizedTransactionId: verified.normalizedTransactionId,
				verifiedAt: now,
				receivedAt: now,
				envelope: verified.envelope,
			});
			return new Response(null, { status: 204 });
		} catch {
			return new Response("Webhook persistence failed.", { status: 500 });
		}
	};
}
