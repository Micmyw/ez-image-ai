import { z } from "zod";

export const checkoutBrowserEventSchema = z.enum([
	"link_received",
	"redirect_requested",
	"redirect_failed",
	"return_unmarked",
	"return_approved",
	"return_canceled",
	"return_conflicting",
	"capture_request_failed",
]);

export const checkoutDiagnosticErrorSchema = z
	.object({
		kind: z.enum(["provider_response", "timeout", "transport", "internal", "unknown"]),
		code: z
			.string()
			.regex(/^[A-Z][A-Z0-9_]{0,95}$/)
			.optional(),
		httpStatus: z.number().int().min(100).max(599).optional(),
		providerIssue: z
			.string()
			.regex(/^[A-Z][A-Z0-9_]{0,95}$/)
			.optional(),
		debugId: z
			.string()
			.regex(/^[a-zA-Z0-9-]{1,64}$/)
			.optional(),
	})
	.strict();

export const checkoutDiagnosticSchema = z.discriminatedUnion("source", [
	z
		.object({
			version: z.literal(1),
			source: z.literal("browser"),
			event: checkoutBrowserEventSchema,
		})
		.strict(),
	z
		.object({
			version: z.literal(1),
			source: z.literal("server"),
			operation: z.enum(["create", "bind", "recovery", "capture", "ingest"]),
			phase: z.enum(["started", "succeeded", "failed", "unconfirmed"]),
			attemptId: z.uuid(),
			durationMs: z.number().int().min(0).max(86_400_000).optional(),
			error: checkoutDiagnosticErrorSchema.optional(),
		})
		.strict(),
]);

export type CheckoutDiagnostic = z.infer<typeof checkoutDiagnosticSchema>;
export type CheckoutServerDiagnostic = Extract<CheckoutDiagnostic, { source: "server" }>;

export const checkoutDiagnosticOutcomeSchema = z.enum([
	"COMPLETED",
	"PAYMENT_RECORDED",
	"CAPTURE_CONFIRMED",
	"UNCONFIRMED",
]);

// Operational observations never settle an order. Browser flags, missing events,
// expiry and provider errors cannot establish customer abandonment or liability.
export function checkoutDiagnosticOutcome(
	status: string,
	events: CheckoutDiagnostic[],
): z.infer<typeof checkoutDiagnosticOutcomeSchema> {
	if (status === "COMPLETED") return "COMPLETED";
	const succeeded = (operation: CheckoutServerDiagnostic["operation"]) =>
		events.some(
			(event) =>
				event.source === "server" && event.operation === operation && event.phase === "succeeded",
		);
	if (succeeded("ingest")) return "PAYMENT_RECORDED";
	if (succeeded("capture")) return "CAPTURE_CONFIRMED";
	return "UNCONFIRMED";
}
