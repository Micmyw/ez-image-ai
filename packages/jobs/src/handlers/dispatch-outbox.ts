import { OutboxDeliveryPendingError, type OutboxDependencies } from "../contracts";

const SAFE_DELIVERY_ERROR_CODES = new Set([
	"WORKFLOWS_DISPATCH_REJECTED",
	"WORKFLOWS_DISPATCH_UNCONFIRMED",
	"WORKFLOWS_DISPATCH_CONFIG_INVALID",
]);

function deliveryErrorCode(error: unknown): string {
	if (!(error instanceof Error)) return "DELIVERY_FAILED";
	if (SAFE_DELIVERY_ERROR_CODES.has(error.message)) return error.message;
	if (
		error.message === "WORKFLOWS_DISPATCH_URL is invalid" ||
		error.message === "WORKFLOWS_DISPATCH_SECRET must contain at least 32 characters"
	)
		return "WORKFLOWS_DISPATCH_CONFIG_INVALID";
	return "DELIVERY_FAILED";
}

export async function dispatchOutbox(
	input: { workerId: string; limit?: number; leaseSeconds?: number },
	dependencies: OutboxDependencies,
): Promise<{ claimed: number; delivered: number }> {
	const events = await dependencies.store.claimBatch({
		workerId: input.workerId,
		limit: Math.min(Math.max(input.limit ?? 25, 1), 100),
		leaseSeconds: Math.min(Math.max(input.leaseSeconds ?? 60, 10), 300),
	});
	let delivered = 0;
	for (const event of events) {
		try {
			await dependencies.deliver(event);
			await dependencies.store.complete(event.id, input.workerId, event.leaseToken);
			delivered += 1;
		} catch (error) {
			const now = dependencies.now?.() ?? new Date();
			if (error instanceof OutboxDeliveryPendingError) {
				if (!dependencies.store.defer) throw error;
				await dependencies.store.defer({
					id: event.id,
					workerId: input.workerId,
					leaseToken: event.leaseToken,
					retryAt: new Date(now.getTime() + 30_000),
				});
				continue;
			}
			const seconds = Math.min(3_600, 2 ** Math.min(event.attempts, 10));
			await dependencies.store.release({
				id: event.id,
				workerId: input.workerId,
				leaseToken: event.leaseToken,
				errorCode: deliveryErrorCode(error),
				retryAt: new Date(now.getTime() + seconds * 1_000),
			});
		}
	}
	return { claimed: events.length, delivered };
}
