import { createHash } from "node:crypto";

import { SEEAPI_INPUT_DELEGATION_CODES, SEEAPI_INPUT_DELEGATION_REASON } from "@repo/config";

import { readInitialSubscriptionPaymentEvidence } from "../../../shared/admin-analytics-payment-evidence";
import { createCreditGrant, refundCreditGrant } from "./credits";
import { runSerializable, type MediaDatabaseClient, type MediaTransactionClient } from "./types";

const POLICY = "technical-failure-subscription-bonus-v1";
const OFFER = "SUBSCRIPTION_COMPENSATION_OFFERED";
const GRANTED = "SUBSCRIPTION_COMPENSATION_GRANTED";
const DISMISSED = "SUBSCRIPTION_COMPENSATION_DISMISSED";
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

function receiptId(ownerId: string, kind: string) {
	return `comp_${createHash("sha256")
		.update(JSON.stringify([POLICY, ownerId, kind]))
		.digest("hex")}`;
}

function object(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

async function databaseNow(client: MediaDatabaseClient) {
	const [row] = await client.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
	if (!row) throw new Error("DATABASE_CLOCK_UNAVAILABLE");
	return row.now;
}

export interface SubscriptionCompensationOffer {
	id: string;
	bonusPercent: 10;
	expiresAt: string;
	dismissed: boolean;
}

/** Append-only receipts give this campaign one lifetime identity per account. */
export async function getSubscriptionCompensationOffer(
	ownerId: string,
	client: MediaDatabaseClient,
): Promise<SubscriptionCompensationOffer | null> {
	const [offer, granted, dismissed, now] = await Promise.all([
		client.auditLog.findUnique({ where: { id: receiptId(ownerId, "offer") } }),
		client.auditLog.findUnique({ where: { id: receiptId(ownerId, "grant") } }),
		client.auditLog.findUnique({ where: { id: receiptId(ownerId, "dismiss") } }),
		databaseNow(client),
	]);
	const metadata = object(offer?.metadata);
	const expiresAt = new Date(typeof metadata?.expiresAt === "string" ? metadata.expiresAt : "");
	if (offer?.action !== OFFER || metadata?.policy !== POLICY || granted || !(expiresAt > now))
		return null;
	if (await hasSubscriptionHistory(ownerId, client)) return null;
	return {
		id: offer.id,
		bonusPercent: 10,
		expiresAt: expiresAt.toISOString(),
		dismissed: !!dismissed,
	};
}

async function hasSubscriptionHistory(
	ownerId: string,
	client: MediaDatabaseClient,
	except?: {
		subscriptionId: string;
		purchaseId: string | null;
	},
) {
	return (
		!!(await client.subscription.findFirst({
			where: {
				ownerType: "USER",
				ownerId,
				...(except ? { id: { not: except.subscriptionId } } : {}),
			},
			select: { id: true },
		})) ||
		!!(await client.purchase.findFirst({
			where: {
				userId: ownerId,
				organizationId: null,
				type: "SUBSCRIPTION",
				productKind: "PLAN",
				...(except?.purchaseId ? { id: { not: except.purchaseId } } : {}),
			},
			select: { id: true },
		}))
	);
}

/** Client errors never establish eligibility; read the owned, authenticated detector evidence. */
export async function claimSubscriptionCompensationOffer(
	input: { ownerId: string; assetId: string },
	client: MediaTransactionClient,
): Promise<SubscriptionCompensationOffer | null> {
	if (process.env.MEDIA_TECHNICAL_FAILURE_SUBSCRIPTION_BONUS_ENABLED !== "true") return null;
	return runSerializable(client, async (tx) => {
		const user = await tx.user.findUnique({
			where: { id: input.ownerId },
			select: { isAnonymous: true },
		});
		if (!user || user.isAnonymous || (await hasSubscriptionHistory(input.ownerId, tx))) return null;
		const previous = await tx.auditLog.findUnique({
			where: { id: receiptId(input.ownerId, "offer") },
		});
		if (previous) return getSubscriptionCompensationOffer(input.ownerId, tx);
		// An already open/uncertain checkout predates this offer. Do not advertise
		// a gift that its frozen payment attempt has not acquired.
		if (
			await tx.paymentCheckoutIntent.findFirst({
				where: {
					ownerType: "USER",
					ownerId: input.ownerId,
					productKind: "PLAN",
					status: { in: ["CREATED", "PROVIDER_CREATING", "PROVIDER_PENDING", "REVIEW"] },
				},
				select: { id: true },
			})
		)
			return null;
		const asset = await tx.mediaAsset.findFirst({
			where: {
				id: input.assetId,
				ownerType: "USER",
				ownerId: input.ownerId,
				kind: "INPUT",
				retentionClass: "ACCOUNT",
				verificationEngine: "legacy",
				deletedAt: null,
				mimeType: { in: ["image/jpeg", "image/png", "image/webp"] },
			},
		});
		if (!asset?.checksum || !asset.verificationProviderTaskId) return null;
		const evidence = await tx.assetModerationResult.findFirst({
			where: {
				assetId: asset.id,
				assetChecksum: asset.checksum,
				evidenceKind: "INPUT",
				provider: "seeapi",
				providerTaskId: asset.verificationProviderTaskId,
				verificationGeneration: asset.verificationGeneration,
				attemptNumber: asset.verificationAttemptCount,
				OR: [
					{ status: "ERROR" },
					{ status: "BYPASSED", reasonCode: SEEAPI_INPUT_DELEGATION_REASON },
				],
			},
			orderBy: { createdAt: "desc" },
		});
		const envelope = object(evidence?.rawEnvelope);
		const details = object(envelope?.evidence);
		const failure = object(details?.seeapiFailure);
		const now = await databaseNow(tx);
		if (
			!evidence ||
			now.getTime() - evidence.createdAt.getTime() > WEEK_MS ||
			envelope?.decision !== "ERROR" ||
			details?.requestId !== asset.verificationProviderTaskId ||
			failure?.taskId !== asset.verificationProviderTaskId ||
			failure?.status !== "failed" ||
			!SEEAPI_INPUT_DELEGATION_CODES.some((code) => code === failure.code) ||
			!Array.isArray(details.models) ||
			details.models.length !== 1 ||
			details.models[0] !== "nsfw-filter-2" ||
			(await tx.assetModerationResult.findFirst({
				where: { assetId: asset.id, status: { in: ["REJECTED", "REVIEW"] } },
			}))
		)
			return null;
		await tx.auditLog.upsert({
			where: { id: receiptId(input.ownerId, "offer") },
			create: {
				id: receiptId(input.ownerId, "offer"),
				action: OFFER,
				actorUserId: input.ownerId,
				targetType: "USER",
				targetId: input.ownerId,
				createdAt: now,
				metadata: {
					policy: POLICY,
					bonusPercent: 10,
					expiresAt: new Date(now.getTime() + WEEK_MS).toISOString(),
					assetId: asset.id,
					evidenceId: evidence.id,
					allocation: "first-month-only",
				},
			},
			update: {},
		});
		return getSubscriptionCompensationOffer(input.ownerId, tx);
	});
}

export async function dismissSubscriptionCompensationOffer(
	ownerId: string,
	client: MediaDatabaseClient,
) {
	if (!(await client.auditLog.findUnique({ where: { id: receiptId(ownerId, "offer") } }))) return;
	await client.auditLog.upsert({
		where: { id: receiptId(ownerId, "dismiss") },
		create: {
			id: receiptId(ownerId, "dismiss"),
			action: DISMISSED,
			actorUserId: ownerId,
			targetType: "USER",
			targetId: ownerId,
			metadata: { policy: POLICY },
		},
		update: {},
	});
}

/** Invoked only inside the authenticated payment reducer's subscription/payment transaction.
 * This separate gift never changes a BillingPlan, paid period, PSP price or revenue. */
export async function grantSubscriptionCompensation(
	input: { subscriptionId: string; periodId: string; accountId: string },
	client: MediaDatabaseClient,
) {
	const subscription = await client.subscription.findUnique({
		where: { id: input.subscriptionId },
	});
	if (subscription?.ownerType !== "USER" || !["paypal", "waffo"].includes(subscription.provider))
		return;
	const ownerId = subscription.ownerId;
	const offer = await client.auditLog.findUnique({ where: { id: receiptId(ownerId, "offer") } });
	const policy = object(offer?.metadata);
	if (
		offer?.action !== OFFER ||
		policy?.policy !== POLICY ||
		policy.bonusPercent !== 10 ||
		(await client.auditLog.findUnique({ where: { id: receiptId(ownerId, "grant") } }))
	)
		return;
	const initial = readInitialSubscriptionPaymentEvidence(subscription.initialPaymentEvidence);
	const binding = initial
		? await client.auditLog.findUnique({
				where: {
					id: receiptId(ownerId, `checkout:${initial.checkoutIntentId}`),
				},
			})
		: null;
	if (
		binding?.action !== "SUBSCRIPTION_COMPENSATION_CHECKOUT_BOUND" ||
		object(binding.metadata)?.offerId !== offer.id
	)
		return;
	const period = await client.billingPeriod.findUnique({ where: { id: input.periodId } });
	if (
		!initial?.providerPaymentId ||
		!period ||
		period.subscriptionId !== subscription.id ||
		period.startsAt.toISOString() !== initial.periodStart ||
		period.providerInvoicePaymentId !== `${subscription.provider}:${initial.providerPaymentId}` ||
		period.paidAmount <= 0n ||
		period.refundedAmount !== 0n ||
		period.status !== "ACTIVE" ||
		period.endsAt <= (await databaseNow(client)) ||
		(await hasSubscriptionHistory(ownerId, client, {
			subscriptionId: subscription.id,
			purchaseId: subscription.purchaseId,
		}))
	)
		return;
	const checkout = await client.paymentCheckoutIntent.findUnique({
		where: { id: initial.checkoutIntentId },
	});
	if (
		!checkout ||
		checkout.ownerType !== "USER" ||
		checkout.ownerId !== ownerId ||
		checkout.productKind !== "PLAN"
	)
		return;
	const amount = period.creditAmount / 10n;
	if (amount <= 0n) return;
	const grantReferenceKey = `${receiptId(ownerId, "grant")}:credits`;
	const metadata = {
		policy: POLICY,
		offerId: offer.id,
		subscriptionId: subscription.id,
		billingPeriodId: period.id,
		providerPaymentId: period.providerInvoicePaymentId,
		amount: amount.toString(),
		grantReferenceKey,
		accountId: input.accountId,
	};
	await createCreditGrant(
		{
			accountId: input.accountId,
			amount,
			referenceKey: grantReferenceKey,
			expiresAt: period.endsAt,
			metadata,
		},
		client,
	);
	await client.auditLog.create({
		data: {
			id: receiptId(ownerId, "grant"),
			action: GRANTED,
			targetType: "USER",
			targetId: ownerId,
			metadata,
		},
	});
}

/** Freeze entitlement on a fresh checkout using database time. Never retrofit a
 * replayed/uncertain PSP attempt, and never compare application/PSP clocks. */
export async function bindSubscriptionCompensationCheckout(
	input: {
		id: string;
		ownerType: string;
		ownerId: string;
		provider: string;
		productKind: string;
	},
	client: MediaDatabaseClient,
) {
	if (
		input.ownerType !== "USER" ||
		input.productKind !== "PLAN" ||
		!["paypal", "waffo"].includes(input.provider)
	)
		return;
	const offer = await client.auditLog.findUnique({
		where: { id: receiptId(input.ownerId, "offer") },
	});
	const data = object(offer?.metadata);
	if (
		offer?.action !== OFFER ||
		data?.policy !== POLICY ||
		data.bonusPercent !== 10 ||
		typeof data.expiresAt !== "string"
	)
		return;
	const now = await databaseNow(client);
	if (
		!(new Date(data.expiresAt) > now) ||
		(await client.auditLog.findUnique({ where: { id: receiptId(input.ownerId, "grant") } }))
	)
		return;
	await client.auditLog.create({
		data: {
			id: receiptId(input.ownerId, `checkout:${input.id}`),
			action: "SUBSCRIPTION_COMPENSATION_CHECKOUT_BOUND",
			targetType: "PAYMENT_CHECKOUT_INTENT",
			targetId: input.id,
			createdAt: now,
			metadata: {
				policy: POLICY,
				offerId: offer.id,
				expiresAt: data.expiresAt,
				checkoutIntentId: input.id,
			},
		},
	});
}

/** Any verified refund/reversal of the qualifying payment revokes its one-time gift once. */
export async function revokeSubscriptionCompensation(
	input: { ownerId: string; paymentKey: string; accountId: string },
	client: MediaDatabaseClient,
) {
	const receipt = await client.auditLog.findUnique({
		where: { id: receiptId(input.ownerId, "grant") },
	});
	const data = object(receipt?.metadata);
	if (
		receipt?.action !== GRANTED ||
		data?.policy !== POLICY ||
		data.providerPaymentId !== input.paymentKey ||
		data.accountId !== input.accountId ||
		typeof data.grantReferenceKey !== "string" ||
		typeof data.amount !== "string" ||
		!/^\d+$/.test(data.amount)
	)
		return;
	await refundCreditGrant(
		{
			accountId: input.accountId,
			amount: BigInt(data.amount),
			grantReferenceKey: data.grantReferenceKey,
			referenceKey: `${data.grantReferenceKey}:revoked`,
			metadata: { policy: POLICY, providerPaymentId: input.paymentKey },
		},
		client,
	);
}
