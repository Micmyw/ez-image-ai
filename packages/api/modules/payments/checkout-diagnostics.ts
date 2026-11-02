import { randomUUID } from "node:crypto";

import {
	recordCheckoutDiagnostic,
	type CheckoutDiagnostic,
	type CheckoutServerDiagnostic,
} from "@repo/database";
import { logger } from "@repo/logs";
import { checkoutErrorDetails } from "@repo/payments/checkout-diagnostics";

export async function recordCheckoutDiagnosticSafely(input: {
	intentId: string;
	actorUserId: string;
	diagnostic: CheckoutDiagnostic;
}): Promise<boolean> {
	try {
		await recordCheckoutDiagnostic(input);
		return true;
	} catch {
		// A diagnostic failure must never make a successful financial operation
		// look failed or cause a provider retry. Await within the request lifetime.
		logger.error(
			{ intentId: input.intentId, diagnostic: input.diagnostic },
			"Checkout diagnostic persistence failed",
		);
		return false;
	}
}

export async function observeCheckoutOperation<T>(
	input: {
		intentId: string;
		actorUserId: string;
		operation: CheckoutServerDiagnostic["operation"];
	},
	run: () => Promise<T>,
	resultPhase: (result: T) => "succeeded" | "unconfirmed" = () => "succeeded",
): Promise<T> {
	const { operation, ...identity } = input;
	const base = {
		version: 1 as const,
		source: "server" as const,
		operation,
		attemptId: randomUUID(),
	};
	await recordCheckoutDiagnosticSafely({ ...identity, diagnostic: { ...base, phase: "started" } });
	const started = performance.now();
	const durationMs = () =>
		Math.min(86_400_000, Math.max(0, Math.round(performance.now() - started)));
	try {
		const result = await run();
		await recordCheckoutDiagnosticSafely({
			...identity,
			diagnostic: { ...base, phase: resultPhase(result), durationMs: durationMs() },
		});
		return result;
	} catch (error) {
		await recordCheckoutDiagnosticSafely({
			...identity,
			diagnostic: {
				...base,
				phase: "failed",
				durationMs: durationMs(),
				error: checkoutErrorDetails(error),
			},
		});
		throw error;
	}
}
