import { createHash } from "node:crypto";

import {
	ingestPaymentEvent,
	ingestPaymentEventInTransaction,
	runSerializable,
	type Prisma,
} from "@repo/database";

import type { ProviderEventPage, ProviderEventWindow } from "./event-source";

type Client = Parameters<typeof ingestPaymentEvent>[1];
const DAY = 86_400_000;

export function paymentReconciliationScope(
	provider: "paypal" | "waffo",
	env: Record<string, string | undefined> = process.env,
): string {
	const values =
		provider === "paypal"
			? [env.PAYPAL_ENVIRONMENT, env.PAYPAL_CLIENT_ID, env.PAYPAL_WEBHOOK_ID]
			: [env.WAFFO_ENVIRONMENT, env.WAFFO_MERCHANT_ID, env.WAFFO_STORE_ID];
	if (values.some((value) => !value)) throw new Error("PAYMENT_RECONCILIATION_SCOPE_MISSING");
	return `${provider}:${createHash("sha256").update(JSON.stringify(values)).digest("hex")}`;
}

// Each page is persisted with its cursor in one transaction. A timeout never
// advances the watermark, and every recovered event follows the normal Outbox.
export async function reconcileProviderPaymentEvents(
	input: { provider: "paypal" | "waffo"; scope: string; now?: Date; maxPages?: number },
	client: Client,
	readPage: (window: ProviderEventWindow) => Promise<ProviderEventPage>,
) {
	const clock = () => input.now ?? new Date();
	const now = clock();
	const leaseToken = crypto.randomUUID();
	const lease = await runSerializable(client, async (tx) => {
		await tx.paymentReconciliationCheckpoint.upsert({
			where: { id: input.scope },
			create: {
				id: input.scope,
				provider: input.provider,
				windowStart: new Date(now.getTime() - 29 * DAY),
			},
			update: {},
		});
		const claimed = await tx.paymentReconciliationCheckpoint.updateMany({
			where: { id: input.scope, OR: [{ leasedUntil: null }, { leasedUntil: { lte: now } }] },
			data: { leaseToken, leasedUntil: new Date(now.getTime() + 120_000) },
		});
		if (!claimed.count) return null;
		const checkpoint = await tx.paymentReconciliationCheckpoint.findUniqueOrThrow({
			where: { id: input.scope },
		});
		if (checkpoint.provider !== input.provider)
			throw new Error("PAYMENT_RECONCILIATION_SCOPE_MISMATCH");
		return tx.paymentReconciliationCheckpoint.update({
			where: { id: input.scope },
			data: { windowEnd: checkpoint.windowEnd ?? new Date(now.getTime() - 60_000) },
		});
	});
	if (!lease) return { skipped: true, completed: false, recovered: 0 };
	let recovered = 0;
	let cursor = lease.cursor;
	try {
		if (lease.windowStart < new Date(now.getTime() - 30 * DAY))
			throw new Error("PAYMENT_RECONCILIATION_HISTORY_GAP");
		for (let page = 0; page < Math.min(Math.max(input.maxPages ?? 2, 1), 5); page++) {
			const result = await readPage({
				since: lease.windowStart,
				until: lease.windowEnd!,
				cursor,
				limit: 50,
			});
			if (result.nextCursor !== null && result.nextCursor === cursor)
				throw new Error("PAYMENT_RECONCILIATION_CURSOR_STALLED");
			const completed = result.nextCursor === null;
			recovered += await runSerializable(client, async (tx) => {
				await tx.$queryRaw`SELECT "id" FROM "payment_reconciliation_checkpoint" WHERE "id" = ${input.scope} FOR UPDATE`;
				const fence = await tx.paymentReconciliationCheckpoint.findUniqueOrThrow({
					where: { id: input.scope },
				});
				if (fence.leaseToken !== leaseToken || !fence.leasedUntil || fence.leasedUntil <= clock())
					throw new Error("PAYMENT_RECONCILIATION_LEASE_LOST");
				let inserted = 0;
				for (const event of result.events) {
					const saved = await ingestPaymentEventInTransaction(
						{
							...event,
							provider: input.provider,
							providerEnvironment:
								process.env[
									input.provider === "paypal" ? "PAYPAL_ENVIRONMENT" : "WAFFO_ENVIRONMENT"
								],
							verifiedAt: clock(),
							envelope: event.envelope as Prisma.InputJsonValue,
						},
						tx,
					);
					if (!saved.replayed) inserted++;
				}
				await tx.paymentReconciliationCheckpoint.update({
					where: { id: input.scope },
					data: {
						cursor: result.nextCursor,
						lastError: null,
						...(completed
							? {
									windowStart: new Date(lease.windowEnd!.getTime() - DAY),
									windowEnd: null,
									lastCompletedAt: clock(),
									leaseToken: null,
									leasedUntil: null,
								}
							: {}),
					},
				});
				return inserted;
			});
			if (completed) return { skipped: false, completed: true, recovered };
			cursor = result.nextCursor;
		}
		const continuationKey = `payment-backfill:${input.scope}:${createHash("sha256")
			.update(
				JSON.stringify([lease.windowStart.toISOString(), lease.windowEnd!.toISOString(), cursor]),
			)
			.digest("hex")}`;
		return { skipped: false, completed: false, recovered, continuationKey };
	} catch (error) {
		await client.paymentReconciliationCheckpoint.updateMany({
			where: { id: input.scope, leaseToken },
			data: {
				lastError:
					error instanceof Error && error.message === "PAYMENT_RECONCILIATION_HISTORY_GAP"
						? error.message
						: "PAYMENT_RECONCILIATION_FAILED",
			},
		});
		throw error;
	} finally {
		await client.paymentReconciliationCheckpoint.updateMany({
			where: { id: input.scope, leaseToken },
			data: { leaseToken: null, leasedUntil: null },
		});
	}
}
