export interface CheckoutErrorDetails {
	kind: "provider_response" | "timeout" | "transport" | "internal" | "unknown";
	code?: string;
	httpStatus?: number;
	providerIssue?: string;
	debugId?: string;
}

const internalCodes = new Set([
	"PAYPAL_CAPTURE_CORRELATION_INVALID",
	"PAYPAL_CAPTURE_UNAVAILABLE",
	"PAYPAL_CHECKOUT_AMOUNT_INVALID",
	"PAYPAL_CHECKOUT_DESCRIPTION_MISSING",
	"PAYPAL_CHECKOUT_RESPONSE_INVALID",
	"PAYPAL_ORDER_ID_MISSING",
	"PAYMENT_CHECKOUT_INTENT_BINDING_CONFLICT",
	"PAYMENT_CHECKOUT_INTENT_CONFLICT",
	"PAYMENT_CHECKOUT_INTENT_ORDER_BINDING_CONFLICT",
	"PAYMENT_CHECKOUT_INTENT_PROVIDER_CREATE_CONFLICT",
	"PAYMENT_CHECKOUT_INTENT_REPLAY_UNSAFE",
]);
const transportCodes = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"ENOTFOUND",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_SOCKET",
]);

// Keep diagnostic fields separate from raw provider bodies, URLs and messages.
export class CheckoutProviderResponseError extends Error {
	readonly diagnostic: CheckoutErrorDetails;
	constructor(code: string, response: { status: number; body: unknown; debugId?: string | null }) {
		super(code);
		const body = record(response.body);
		const details = Array.isArray(body?.details) ? body.details : [];
		const issue = safeCode(record(details[0])?.issue) ?? safeCode(body?.name);
		const debugId = response.debugId ?? body?.debug_id;
		this.diagnostic = {
			kind: "provider_response",
			...(safeCode(code) ? { code } : {}),
			...(Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
				? { httpStatus: response.status }
				: {}),
			...(issue ? { providerIssue: issue } : {}),
			...(typeof debugId === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(debugId) ? { debugId } : {}),
		};
	}
}

export function checkoutErrorDetails(error: unknown): CheckoutErrorDetails {
	if (error instanceof CheckoutProviderResponseError) return error.diagnostic;
	if (error instanceof Error) {
		if (error.name === "TimeoutError" || error.name === "AbortError") return { kind: "timeout" };
		const details = record(error);
		const databaseCode = details?.code;
		if (
			error.name === "PrismaClientKnownRequestError" &&
			typeof databaseCode === "string" &&
			/^P\d{4}$/.test(databaseCode)
		)
			return { kind: "internal", code: databaseCode };
		const transportCode = record(error.cause)?.code;
		if (typeof transportCode === "string" && transportCodes.has(transportCode))
			return { kind: "transport", code: transportCode };
		// Only our fixed codes are eligible, never arbitrary messages or stacks.
		if (internalCodes.has(error.message)) return { kind: "internal", code: error.message };
	}
	return { kind: "unknown" };
}

function safeCode(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,95}$/.test(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
