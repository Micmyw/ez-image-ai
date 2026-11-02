import { createHash } from "node:crypto";

import {
	checkoutDiagnosticSchema,
	type CheckoutDiagnostic,
} from "../../shared/checkout-diagnostics";
import { db } from "../client";

export * from "../../shared/checkout-diagnostics";

const action = "PAYMENT_CHECKOUT_DIAGNOSTIC";
const targetType = "PAYMENT_CHECKOUT_INTENT";

export async function recordCheckoutDiagnostic(
	input: { intentId: string; actorUserId: string; diagnostic: CheckoutDiagnostic },
	client: Pick<typeof db, "auditLog"> = db,
) {
	const diagnostic = checkoutDiagnosticSchema.parse(input.diagnostic);
	// Browser observations are first-seen receipts, bounded to eight rows per
	// checkout even across refreshes, retries, StrictMode and duplicate beacons.
	const eventKey =
		diagnostic.source === "browser"
			? diagnostic.event
			: `${diagnostic.attemptId}:${diagnostic.operation}:${diagnostic.phase}`;
	const id = `checkout-diag:${createHash("sha256")
		.update(JSON.stringify([input.intentId, diagnostic.source, eventKey]))
		.digest("hex")}`;
	await client.auditLog.upsert({
		where: { id },
		create: {
			id,
			actorUserId: input.actorUserId,
			action,
			targetType,
			targetId: input.intentId,
			metadata: diagnostic,
		},
		update: {},
	});
}

// API authorization is required; no payer details, token or approval URL is read.
export async function listCheckoutDiagnostics(
	input: { since: Date; limit: number; reference?: string },
	client: Pick<typeof db, "paymentCheckoutIntent" | "auditLog"> = db,
) {
	const limit = Math.max(1, Math.min(20, Math.trunc(input.limit)));
	const intents = await client.paymentCheckoutIntent.findMany({
		where: {
			productKind: { in: ["CREDIT_PACK", "IMAGE_PASS"] },
			...(input.reference ? { id: input.reference } : { createdAt: { gte: input.since } }),
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: limit + 1,
		select: {
			id: true,
			ownerId: true,
			ownerType: true,
			provider: true,
			productKind: true,
			planKey: true,
			status: true,
			createdAt: true,
			expiresAt: true,
		},
	});
	const rows = [];
	// Bounded sequential reads avoid exhausting request-owned edge connections.
	for (const intent of intents.slice(0, limit)) {
		const logs = await client.auditLog.findMany({
			where: { action, targetType, targetId: intent.id },
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: 101,
			select: { id: true, createdAt: true, metadata: true },
		});
		const events = logs
			.slice(0, 100)
			.flatMap((row) => {
				const parsed = checkoutDiagnosticSchema.safeParse(row.metadata);
				return parsed.success
					? [{ id: row.id, receivedAt: row.createdAt.toISOString(), diagnostic: parsed.data }]
					: [];
			})
			.reverse();
		rows.push({
			...intent,
			events,
			eventsTruncated: logs.length > 100,
			unreadableEvents: logs.slice(0, 100).length - events.length,
		});
	}
	return { rows, truncated: intents.length > limit };
}
