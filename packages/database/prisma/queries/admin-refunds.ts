import { Prisma } from "#prisma-runtime-client";

import {
	normalizeSubscriptionPaymentEvidence,
	objectRecord,
	stripeMinorToMicros,
} from "../../shared/admin-payment-facts";
import { adminScopeAllowsOwner, type AdminScope } from "../../shared/admin-scope";
import { db } from "../client";
import { AdminAccessError } from "./admin-access";
import { runSerializable, type MediaTransactionClient } from "./media/types";

type ReadClient = Prisma.TransactionClient;

export interface AdminRefundPayment {
	orderNo: string;
	productKind: "PLAN" | "CREDIT_PACK" | "IMAGE_PASS";
	ownerType: "USER" | "ORGANIZATION";
	ownerId: string;
	provider: string;
	paymentKey: string;
	providerPaymentId: string;
	providerOrderId: string | null;
	providerInvoiceId: string | null;
	providerChargeId: string | null;
	providerPaymentIntentId: string | null;
	providerSubscriptionId: string | null;
	subscriptionId: string | null;
	purchaseId: string | null;
	checkoutIntentId: string | null;
	priceId: string | null;
	providerEnvironment: string;
	amountMicros: bigint;
	refundedAmountMicros: bigint;
	currency: string;
	paidAt: Date;
	creditsRequested: bigint;
	cancellationPolicyRequired: boolean;
}

function assertScope(scope: AdminScope, owner: { ownerType: string; ownerId: string }) {
	if (!adminScopeAllowsOwner(scope, owner))
		throw new AdminAccessError("ADMIN_SCOPE_FORBIDDEN", 403);
}

function ownerFilter(scope: AdminScope): Prisma.CreditPackFulfillmentWhereInput {
	return scope.kind === "platform"
		? {}
		: scope.kind === "organization"
			? { ownerType: "ORGANIZATION", ownerId: scope.organizationId }
			: { ownerType: "USER", ownerId: scope.userId };
}

export async function readAdminRefundPayment(
	scope: AdminScope,
	orderNo: string,
	client: ReadClient = db,
): Promise<AdminRefundPayment> {
	const separator = orderNo.indexOf(":");
	const kind = orderNo.slice(0, separator);
	const id = orderNo.slice(separator + 1);
	if (separator < 1 || !id || id.length > 150) throw new AdminAccessError("ADMIN_ORDER_INVALID");
	if (kind === "pack") {
		const pack = await client.creditPackFulfillment.findFirst({
			where: { id, ...ownerFilter(scope) },
			include: { checkoutIntent: true, billingPlan: true },
		});
		if (!pack) throw new AdminAccessError("ADMIN_ORDER_NOT_FOUND", 404);
		assertScope(scope, pack);
		const environment = await oneTimePaymentEnvironment(
			pack.provider,
			pack.providerPaymentId,
			client,
		);
		return {
			orderNo: `pack:${pack.id}`,
			productKind: "CREDIT_PACK",
			ownerType: pack.ownerType as "USER" | "ORGANIZATION",
			ownerId: pack.ownerId,
			provider: pack.provider,
			paymentKey: `${pack.provider}:${pack.providerPaymentId}`,
			providerPaymentId: pack.providerPaymentId,
			providerOrderId: pack.providerOrderId,
			providerInvoiceId: null,
			providerChargeId: null,
			providerPaymentIntentId: null,
			providerSubscriptionId: null,
			subscriptionId: null,
			purchaseId: pack.purchaseId,
			checkoutIntentId: pack.checkoutIntentId,
			priceId: pack.billingPlan.providerPriceId,
			providerEnvironment: environment,
			amountMicros: pack.paidAmountMicros,
			refundedAmountMicros: pack.refundedAmountMicros,
			currency: pack.currency,
			paidAt: pack.paidAt,
			creditsRequested: pack.grantedCredits - pack.refundedCredits,
			cancellationPolicyRequired: false,
		};
	}
	if (kind === "image-pass") {
		if (scope.kind === "organization") throw new AdminAccessError("ADMIN_ORDER_NOT_FOUND", 404);
		const pass = await client.imagePassGrant.findFirst({
			where: { id, ...(scope.kind === "user" ? { ownerId: scope.userId } : {}) },
			include: { adjustments: true, checkoutIntent: { include: { billingPlan: true } } },
		});
		if (!pass) throw new AdminAccessError("ADMIN_ORDER_NOT_FOUND", 404);
		assertScope(scope, { ownerType: "USER", ownerId: pass.ownerId });
		// A dispute is not permission to refund withdrawn money a second time.
		if (pass.adjustments.some((adjustment) => adjustment.kind !== "REFUND"))
			throw new Error("ADMIN_ORDER_DISPUTED");
		const environment = await oneTimePaymentEnvironment(
			pass.provider,
			pass.providerPaymentId,
			client,
		);
		return {
			orderNo: `image-pass:${pass.id}`,
			productKind: "IMAGE_PASS",
			ownerType: "USER",
			ownerId: pass.ownerId,
			provider: pass.provider,
			paymentKey: `${pass.provider}:${pass.providerPaymentId}`,
			providerPaymentId: pass.providerPaymentId,
			providerOrderId: pass.providerOrderId,
			providerInvoiceId: null,
			providerChargeId: null,
			providerPaymentIntentId: null,
			providerSubscriptionId: null,
			subscriptionId: null,
			purchaseId: pass.purchaseId,
			checkoutIntentId: pass.checkoutIntentId,
			priceId: pass.checkoutIntent.billingPlan.providerPriceId,
			providerEnvironment: environment,
			amountMicros: pass.paidAmountMicros,
			refundedAmountMicros: pass.adjustments.reduce(
				(sum, adjustment) => sum + adjustment.amountMicros,
				0n,
			),
			currency: pass.currency,
			paidAt: pass.paidAt,
			creditsRequested: 0n,
			cancellationPolicyRequired: false,
		};
	}
	if (kind !== "plan") throw new AdminAccessError("ADMIN_ORDER_INVALID");
	const owner = ownerFilter(scope) as Prisma.SubscriptionWhereInput;
	const period = await client.billingPeriod.findFirst({
		where: { id, subscription: owner },
		include: { subscription: { include: { plan: true } } },
	});
	if (!period?.providerInvoicePaymentId) throw new AdminAccessError("ADMIN_ORDER_NOT_FOUND", 404);
	const subscription = period.subscription;
	assertScope(scope, subscription);
	const periods = await client.billingPeriod.findMany({
		where: {
			subscriptionId: subscription.id,
			providerInvoicePaymentId: period.providerInvoicePaymentId,
		},
		orderBy: [{ startsAt: "asc" }, { id: "asc" }],
	});
	const events = await client.paymentEvent.findMany({
		where: {
			provider: subscription.provider,
			status: "PROCESSED",
			OR: [
				{ providerSubscriptionId: subscription.providerSubscriptionId },
				...(period.providerInvoiceId
					? [{ envelope: { path: ["data", "object", "id"], equals: period.providerInvoiceId } }]
					: []),
			],
		},
		orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
		// Bounded per subscription; refuse incomplete old evidence rather than guess.
		take: 1_000,
	});
	const evidence = normalizeSubscriptionPaymentEvidence(
		periods.map((row) => ({
			...row,
			provider: subscription.provider,
			providerSubscriptionId: subscription.providerSubscriptionId,
		})),
		events,
	);
	if (evidence.evidence !== "verified") throw new Error(`ADMIN_${evidence.reason}`);
	const root = periods[0]!;
	if (
		subscription.provider !== "stripe" &&
		periods.some((row) => row.refundedAmount !== root.refundedAmount)
	)
		throw new Error("ADMIN_PAYMENT_PROJECTION_CONFLICT");
	const latest = await client.billingPeriod.findFirst({
		where: { subscriptionId: subscription.id, paidAmount: { gt: 0n } },
		orderBy: [{ endsAt: "desc" }, { startsAt: "desc" }, { id: "desc" }],
	});
	const checkout = await client.paymentCheckoutIntent.findFirst({
		where: {
			provider: subscription.provider,
			ownerType: subscription.ownerType,
			ownerId: subscription.ownerId,
			productKind: "PLAN",
			OR: [
				{ providerSessionId: subscription.providerSubscriptionId },
				{ providerOrderId: subscription.providerSubscriptionId },
			],
		},
	});
	return {
		orderNo: `plan:${periods[0]!.id}`,
		productKind: "PLAN",
		ownerType: subscription.ownerType as "USER" | "ORGANIZATION",
		ownerId: subscription.ownerId,
		provider: subscription.provider,
		paymentKey: `${subscription.provider}:${evidence.providerPaymentId}`,
		providerPaymentId: evidence.providerPaymentId,
		providerOrderId: subscription.providerSubscriptionId,
		providerInvoiceId: period.providerInvoiceId,
		providerChargeId: period.providerChargeId,
		providerPaymentIntentId: period.providerPaymentIntentId,
		providerSubscriptionId: subscription.providerSubscriptionId,
		subscriptionId: subscription.id,
		purchaseId: subscription.purchaseId,
		checkoutIntentId: checkout?.id ?? null,
		priceId: subscription.plan.providerPriceId,
		providerEnvironment: evidence.providerEnvironment,
		amountMicros: evidence.amountMicros,
		refundedAmountMicros:
			subscription.provider === "stripe"
				? stripeMinorToMicros(root.refundedAmount, evidence.currency)
				: root.refundedAmount,
		currency: evidence.currency,
		paidAt: evidence.paidAt,
		creditsRequested: periods.reduce(
			(sum, row) => sum + row.creditAmount - row.refundedCredits,
			0n,
		),
		cancellationPolicyRequired:
			["paypal", "waffo"].includes(subscription.provider) &&
			latest?.providerInvoicePaymentId === period.providerInvoicePaymentId,
	};
}

async function oneTimePaymentEnvironment(provider: string, paymentId: string, client: ReadClient) {
	const events = await client.paymentEvent.findMany({
		where: {
			provider,
			status: "PROCESSED",
			OR: [
				{ envelope: { path: ["resource", "id"], equals: paymentId } },
				{ envelope: { path: ["data", "paymentId"], equals: paymentId } },
				{ envelope: { path: ["data", "payment", "paymentId"], equals: paymentId } },
			],
		},
		take: 100,
	});
	const environments = new Set(
		events.flatMap((event) => {
			const envelope = objectRecord(event.envelope);
			const isPayment =
				(provider === "paypal" && envelope.event_type === "PAYMENT.CAPTURE.COMPLETED") ||
				(provider === "waffo" && envelope.eventType === "order.completed");
			return isPayment && event.verifiedAt && event.providerEnvironment
				? [event.providerEnvironment]
				: [];
		}),
	);
	if (environments.size !== 1) throw new Error("ADMIN_VERIFIED_PAYMENT_ENVIRONMENT_MISSING");
	return [...environments][0]!;
}

export async function listAdminRefundablePayments(
	scope: AdminScope,
	input: { limit?: number; cursor?: string; reference?: string },
	client: ReadClient = db,
) {
	const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
	let cursorDate = new Date("9999-01-01T00:00:00.000Z");
	let cursorOrder = "";
	if (input.cursor) {
		const parsed = /^([^|]+)\|(.+)$/.exec(input.cursor);
		if (!parsed || !Number.isFinite(new Date(parsed[1]!).getTime()))
			throw new AdminAccessError("ADMIN_ORDERS_CURSOR_INVALID");
		cursorDate = new Date(parsed[1]!);
		cursorOrder = parsed[2]!;
	}
	const filter =
		scope.kind === "platform"
			? Prisma.sql`TRUE`
			: scope.kind === "user"
				? Prisma.sql`"ownerType" = 'USER' AND "ownerId" = ${scope.userId}`
				: Prisma.sql`"ownerType" = 'ORGANIZATION' AND "ownerId" = ${scope.organizationId}`;
	const rows = await client.$queryRaw<
		Array<{
			orderNo: string;
			productKind: string;
			ownerType: string;
			ownerId: string;
			provider: string;
			createdAt: Date;
		}>
	>(Prisma.sql`
		WITH plan_roots AS (
			SELECT DISTINCT ON (s."provider", p."providerInvoicePaymentId")
				'plan:' || p."id" AS "orderNo", 'PLAN' AS "productKind",
				s."ownerType"::text AS "ownerType", s."ownerId", s."provider", p."createdAt"
			FROM "billing_period" p JOIN "subscription" s ON s."id" = p."subscriptionId"
			WHERE p."paidAmount" > 0 AND p."providerInvoicePaymentId" IS NOT NULL
			ORDER BY s."provider", p."providerInvoicePaymentId", p."startsAt", p."id"
		), payments AS (
			SELECT * FROM plan_roots
			UNION ALL SELECT 'pack:' || "id", 'CREDIT_PACK', "ownerType"::text, "ownerId", "provider", "fulfilledAt" FROM "credit_pack_fulfillment"
			UNION ALL SELECT 'image-pass:' || "id", 'IMAGE_PASS', 'USER', "ownerId", "provider", "createdAt" FROM "image_pass_grant"
		)
		SELECT * FROM payments WHERE (${filter})
			AND (${input.reference ?? null}::text IS NULL OR "orderNo" = ${input.reference ?? null}
				OR substring("orderNo" FROM position(':' IN "orderNo") + 1) = ${input.reference ?? null})
			AND ("createdAt" < ${cursorDate} OR ("createdAt" = ${cursorDate} AND "orderNo" > ${cursorOrder}))
		ORDER BY "createdAt" DESC, "orderNo" ASC LIMIT ${limit + 1}`);
	const items = [];
	for (const row of rows.slice(0, limit)) {
		const base = {
			orderNo: row.orderNo,
			productKind: row.productKind,
			ownerType: row.ownerType,
			ownerId: row.ownerId,
			provider: row.provider,
		};
		try {
			const payment = await readAdminRefundPayment(scope, row.orderNo, client);
			const request = await client.adminRefundRequest.findUnique({
				where: { paymentKey: payment.paymentKey },
			});
			const remaining = payment.amountMicros - payment.refundedAmountMicros;
			items.push({
				...base,
				amountMicros: payment.amountMicros.toString(),
				currency: payment.currency,
				paidAt: payment.paidAt.toISOString(),
				refundedAmountMicros: payment.refundedAmountMicros.toString(),
				remainingAmountMicros: remaining.toString(),
				refundRequestId: request?.id ?? null,
				refundStatus: request?.status ?? null,
				canRefund:
					!request && remaining > 0n && ["paypal", "waffo", "stripe"].includes(payment.provider),
				blockedReason: request
					? "ADMIN_REFUND_ALREADY_REQUESTED"
					: remaining <= 0n
						? "ADMIN_ORDER_ALREADY_REFUNDED"
						: null,
				cancellationPolicyRequired: payment.cancellationPolicyRequired,
				hasSubscription: payment.subscriptionId !== null,
				canCancelSubscription:
					payment.subscriptionId !== null &&
					["paypal", "waffo", "stripe"].includes(payment.provider),
			});
		} catch (error) {
			items.push({
				...base,
				amountMicros: null,
				currency: null,
				paidAt: null,
				refundedAmountMicros: null,
				remainingAmountMicros: null,
				refundRequestId: null,
				refundStatus: null,
				canRefund: false,
				blockedReason: adminRefundErrorCode(error),
				cancellationPolicyRequired: false,
				hasSubscription: row.productKind === "PLAN",
				canCancelSubscription: false,
			});
		}
	}
	const last = rows[Math.min(limit, rows.length) - 1];
	return {
		items,
		nextCursor:
			rows.length > limit && last ? `${last.createdAt.toISOString()}|${last.orderNo}` : null,
	};
}

export async function claimAdminRefundRequest(
	input: {
		scope: AdminScope;
		orderNo: string;
		actorId: string;
		reason?: string;
		cancelSubscription?: boolean;
		providerRequestId: string;
	},
	client: MediaTransactionClient = db,
) {
	return runSerializable(client, async (tx) => {
		const payment = await readAdminRefundPayment(input.scope, input.orderNo, tx);
		await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-refund:${payment.paymentKey}`}, 0))::text AS "locked"`;
		const existing = await tx.adminRefundRequest.findUnique({
			where: { paymentKey: payment.paymentKey },
		});
		if (existing) {
			assertScope(input.scope, existing);
			return { request: existing, payment, claimed: false };
		}
		const remaining = payment.amountMicros - payment.refundedAmountMicros;
		if (remaining <= 0n) throw new AdminAccessError("ADMIN_ORDER_ALREADY_REFUNDED", 409);
		const request = await tx.adminRefundRequest.create({
			data: {
				paymentKey: payment.paymentKey,
				orderNo: payment.orderNo,
				ownerType: payment.ownerType,
				ownerId: payment.ownerId,
				provider: payment.provider,
				providerEnvironment: payment.providerEnvironment,
				productKind: payment.productKind,
				providerPaymentId: payment.providerPaymentId,
				providerOrderId: payment.providerOrderId,
				subscriptionId: payment.subscriptionId,
				amountMicros: remaining,
				currency: payment.currency,
				status: "PROCESSING",
				providerRequestId: input.providerRequestId,
				reason: input.reason?.trim() || null,
				cancelSubscription: input.cancelSubscription ?? false,
				requestedBy: input.actorId,
				processingToken: crypto.randomUUID(),
				processingLeasedUntil: new Date(Date.now() + 60_000),
				result: {
					policyRequired: payment.cancellationPolicyRequired,
					creditsRequested: payment.creditsRequested.toString(),
				},
			},
		});
		await tx.auditLog.create({
			data: {
				action: "ADMIN_ORDER_REFUND_REQUESTED",
				targetType: "ADMIN_REFUND_REQUEST",
				targetId: request.id,
				after: {
					orderNo: payment.orderNo,
					amountMicros: remaining.toString(),
					currency: payment.currency,
				},
				metadata: {
					actorId: input.actorId,
					ownerType: payment.ownerType,
					ownerId: payment.ownerId,
				},
			},
		});
		return { request, payment, claimed: true };
	});
}

export async function readAdminRefundRequest(
	scope: AdminScope,
	requestId: string,
	client: ReadClient = db,
) {
	const request = await client.adminRefundRequest.findFirst({
		where: { id: requestId, ...(ownerFilter(scope) as Prisma.AdminRefundRequestWhereInput) },
	});
	if (!request) throw new AdminAccessError("ADMIN_REFUND_REQUEST_NOT_FOUND", 404);
	assertScope(scope, request);
	return request;
}

export async function claimAdminRefundReconciliation(
	scope: AdminScope,
	requestId: string,
	client: MediaTransactionClient = db,
) {
	return runSerializable(client, async (tx) => {
		const request = await readAdminRefundRequest(scope, requestId, tx);
		await tx.$queryRaw`SELECT "id" FROM "admin_refund_request" WHERE "id" = ${request.id} FOR UPDATE`;
		const current = await readAdminRefundRequest(scope, requestId, tx);
		if (
			current.status === "SUCCEEDED" ||
			current.status === "FAILED" ||
			(current.processingLeasedUntil && current.processingLeasedUntil > new Date())
		) {
			return { request: current, claimed: false };
		}
		const claimed = await tx.adminRefundRequest.update({
			where: { id: current.id },
			data: {
				processingToken: crypto.randomUUID(),
				processingLeasedUntil: new Date(Date.now() + 60_000),
			},
		});
		return { request: claimed, claimed: true };
	});
}

export function adminRefundErrorCode(error: unknown): string {
	return error instanceof Error &&
		/^(ADMIN|PAYMENT|PAYPAL|WAFFO|STRIPE|REFUND|SUBSCRIPTION)_[A-Z_]+$/.test(error.message)
		? error.message
		: "ADMIN_REFUND_PROVIDER_UNAVAILABLE";
}
