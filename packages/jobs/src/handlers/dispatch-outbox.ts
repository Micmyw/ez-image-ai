import type { OutboxDependencies } from "../contracts";

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
		} catch {
			const now = dependencies.now?.() ?? new Date();
			const seconds = Math.min(3_600, 2 ** Math.min(event.attempts, 10));
			await dependencies.store.release({
				id: event.id,
				workerId: input.workerId,
				leaseToken: event.leaseToken,
				errorCode: "DELIVERY_FAILED",
				retryAt: new Date(now.getTime() + seconds * 1_000),
			});
		}
	}
	return { claimed: events.length, delivered };
}
