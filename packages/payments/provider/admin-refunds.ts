import {
	adminRefundErrorCode,
	claimAdminRefundReconciliation,
	claimAdminRefundRequest,
	db,
	microsToStripeMinor,
	objectRecord,
	readAdminRefundPayment,
	readAdminRefundRequest,
	runSerializable,
	type AdminRefundPayment,
	type AdminScope,
	type Prisma,
} from "@repo/database";
import { AdminAccessError } from "@repo/database/admin-access";

import { createPayPalAdminRefundAdapter } from "./admin-refunds-paypal";
import { createStripeAdminRefundAdapter } from "./admin-refunds-stripe";
import {
	assertRefundObservation,
	type AdminRefundAdapter,
	type AdminRefundObservation,
	type AdminRefundRequestRecord,
} from "./admin-refunds-types";
import { createWaffoAdminRefundAdapter } from "./admin-refunds-waffo";
import { tryApplyImagePassAdjustment } from "./image-pass-reducer";
import { applyProviderRefundFact } from "./refund-reducer";
import { terminateRefundedSubscription } from "./refund-termination";
import { getPaymentProvider } from "./runtime-registry";
import { getStripeClient } from "./stripe";
import { normalizeStripeSubscription } from "./stripe/normalization";
import { applyStripeBillingFact } from "./stripe/reducer";
import {
	confirmSubscriptionCancellation,
	requestSubscriptionCancellation,
} from "./subscription-cancellation";

type DatabaseClient = Parameters<typeof runSerializable>[0];

export interface AdminRefundDependencies {
	client?: DatabaseClient;
	environment?: Record<string, string | undefined>;
	adapter?: (provider: string) => AdminRefundAdapter;
	getProvider?: typeof getPaymentProvider;
	cancel?: (payment: AdminRefundPayment, request: AdminRefundRequestRecord) => Promise<void>;
}

/** Stable per immutable provider payment, shared across every UI/API key. */
export async function adminProviderRefundRequestId(paymentKey: string): Promise<string> {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`ezpic-admin-refund-v1:${paymentKey}`),
	);
	return `ezr-${Array.from(new Uint8Array(bytes))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 32)}`;
}

function adapterFor(provider: string, dependencies: AdminRefundDependencies) {
	if (dependencies.adapter) {
		const adapter = dependencies.adapter(provider);
		if (adapter.name !== provider) throw new Error("ADMIN_REFUND_PROVIDER_MISMATCH");
		return adapter;
	}
	if (provider === "paypal") return createPayPalAdminRefundAdapter(dependencies.environment);
	if (provider === "waffo") return createWaffoAdminRefundAdapter(dependencies.environment);
	if (provider === "stripe") return createStripeAdminRefundAdapter();
	throw new Error("ADMIN_REFUND_PROVIDER_UNSUPPORTED");
}

export async function refundAdminOrder(
	input: {
		scope: AdminScope;
		orderNo: string;
		actorId: string;
		reason?: string;
		cancelSubscription?: boolean;
		deductCredits?: number;
	},
	dependencies: AdminRefundDependencies = {},
) {
	if (input.deductCredits !== undefined)
		throw new AdminAccessError("ADMIN_REFUND_CREDITS_POLICY_FIXED");
	const client = dependencies.client ?? db;
	const payment = await refundPrecondition(() =>
		readAdminRefundPayment(input.scope, input.orderNo, client),
	);
	const existing = await client.adminRefundRequest.findUnique({
		where: { paymentKey: payment.paymentKey },
	});
	if (existing)
		return reconcileAdminRefund(
			{ scope: input.scope, requestId: existing.id, actorId: input.actorId },
			dependencies,
		);
	const adapter = await refundPrecondition(async () => adapterFor(payment.provider, dependencies));
	// Fail unsupported, incorrectly configured or mismatched payments before the
	// durable submission claim. No user-selected amount/currency reaches the PSP.
	await refundPrecondition(() => adapter.verifyPayment(payment));
	const claim = await claimAdminRefundRequest(
		{
			...input,
			providerRequestId: await adminProviderRefundRequestId(payment.paymentKey),
		},
		client,
	);
	if (!claim.claimed) return readAdminRefundResult(claim.request);
	let observation: AdminRefundObservation;
	try {
		observation = await adapter.submit(claim.payment, claim.request);
	} catch (error) {
		observation = { status: "UNKNOWN", error: adminRefundErrorCode(error) };
	}
	return recordAndCancel(input.scope, claim.payment, claim.request, observation, dependencies);
}

/** Only read-only setup invokes this wrapper, before any submission claim. */
async function refundPrecondition<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof AdminAccessError) throw error;
		throw new AdminAccessError(adminRefundErrorCode(error), 409);
	}
}

export async function reconcileAdminRefund(
	input: { scope: AdminScope; requestId: string; actorId: string },
	dependencies: AdminRefundDependencies = {},
) {
	const client = dependencies.client ?? db;
	const current = await readAdminRefundRequest(input.scope, input.requestId, client);
	if (current.status === "SUCCEEDED") {
		const payment = await readAdminRefundPayment(input.scope, current.orderNo, client);
		return completeCancellation(payment, current, dependencies);
	}
	const claim = await claimAdminRefundReconciliation(input.scope, input.requestId, client);
	if (!claim.claimed) return readAdminRefundResult(claim.request);
	const payment = await readAdminRefundPayment(input.scope, claim.request.orderNo, client);
	let observation: AdminRefundObservation;
	try {
		observation = await adapterFor(payment.provider, dependencies).inspect(payment, claim.request);
	} catch (error) {
		observation = { status: "UNKNOWN", error: adminRefundErrorCode(error) };
	}
	return recordAndCancel(input.scope, payment, claim.request, observation, dependencies);
}

async function recordAndCancel(
	scope: AdminScope,
	payment: AdminRefundPayment,
	request: AdminRefundRequestRecord,
	observation: AdminRefundObservation,
	dependencies: AdminRefundDependencies,
) {
	const client = dependencies.client ?? db;
	try {
		assertRefundObservation(observation, request);
		await runSerializable(client, async (tx) => {
			await tx.$queryRaw`SELECT "id" FROM "admin_refund_request" WHERE "id" = ${request.id} FOR UPDATE`;
			const locked = await readAdminRefundRequest(scope, request.id, tx);
			if (locked.status === "SUCCEEDED") return;
			if (!request.processingToken || locked.processingToken !== request.processingToken)
				throw new Error("ADMIN_REFUND_LEASE_LOST");
			if (observation.status !== "SUCCEEDED") {
				await tx.adminRefundRequest.update({
					where: { id: request.id },
					data: {
						status: observation.status,
						...(observation.providerRefundId
							? { providerRefundId: observation.providerRefundId }
							: {}),
						lastError: observation.error ?? null,
						...(observation.status === "PROCESSING"
							? { providerAcceptedAt: locked.providerAcceptedAt ?? new Date() }
							: {}),
						processingToken: null,
						processingLeasedUntil: null,
					},
				});
				return;
			}
			// The verified provider fact, existing entitlement reducer, ledger and
			// command result commit together. A webhook replay uses the same refund
			// identity and therefore cannot revoke credits a second time.
			if (payment.provider === "stripe") {
				if (!payment.providerChargeId) throw new Error("STRIPE_REFUND_PAYMENT_UNSUPPORTED");
				await applyStripeBillingFact(
					{
						kind: "REFUND",
						providerRefundId: observation.providerRefundId,
						providerChargeId: payment.providerChargeId,
						providerPaymentIntentId: payment.providerPaymentIntentId,
						amount: microsToStripeMinor(observation.amountMicros, observation.currency),
						currency: observation.currency,
						status: "SUCCEEDED",
						providerCreatedAt: observation.occurredAt,
						context: {
							origin: "RECONCILIATION",
							changeAt: new Date(),
							changeId: `admin-refund:${request.id}`,
						},
					},
					tx,
				);
			} else if (payment.provider === "paypal" || payment.provider === "waffo") {
				const fact = {
					provider: payment.provider,
					providerEventId: `admin-refund:${request.id}`,
					providerRefundId: observation.providerRefundId,
					providerPaymentId: payment.providerPaymentId,
					...(payment.providerSubscriptionId
						? { providerSubscriptionId: payment.providerSubscriptionId }
						: {}),
					amountMicros: observation.amountMicros,
					currency: observation.currency,
					occurredAt: observation.occurredAt,
				} as const;
				if (payment.productKind === "IMAGE_PASS") {
					if (!(await tryApplyImagePassAdjustment(fact, tx)))
						throw new Error("ADMIN_REFUND_IMAGE_PASS_BINDING_MISSING");
				} else {
					await applyProviderRefundFact(fact, tx, {
						providerEnvironment: request.providerEnvironment,
					});
				}
			} else throw new Error("ADMIN_REFUND_PROVIDER_UNSUPPORTED");
			const credits = await refundCreditResult(payment, request, observation.providerRefundId, tx);
			const subscription = request.subscriptionId
				? await tx.subscription.findUnique({ where: { id: request.subscriptionId } })
				: null;
			const policyRequired = Boolean(
				subscription?.refundTerminationRequestedAt &&
				subscription.refundTerminationPaymentId === payment.paymentKey,
			);
			const result = {
				policyRequired,
				creditsRequested: credits.requested,
				creditsRevoked: credits.revoked,
				debtIncurred: credits.debtIncurred,
				cancellationStatus:
					policyRequired || (request.cancelSubscription && payment.subscriptionId)
						? "PENDING"
						: "NOT_REQUESTED",
				cancellationError: null,
			};
			await tx.adminRefundRequest.update({
				where: { id: request.id },
				data: {
					status: "SUCCEEDED",
					providerRefundId: observation.providerRefundId,
					providerAcceptedAt: locked.providerAcceptedAt ?? new Date(),
					completedAt: new Date(),
					lastError: null,
					processingToken: null,
					processingLeasedUntil: null,
					result,
				},
			});
			await tx.auditLog.create({
				data: {
					action: "ADMIN_ORDER_REFUND_CONFIRMED",
					targetType: "ADMIN_REFUND_REQUEST",
					targetId: request.id,
					after: {
						providerRefundId: observation.providerRefundId,
						amountMicros: observation.amountMicros.toString(),
						currency: observation.currency,
						...result,
					},
					metadata: {
						actorId: request.requestedBy,
						ownerType: request.ownerType,
						ownerId: request.ownerId,
						evidence: "AUTHENTICATED_PROVIDER_RETRIEVAL",
					},
				},
			});
		});
	} catch (error) {
		// An accepted request is never reopened for submission. Keep the remote ID
		// if known so an operator can retrieve and retry just the local transaction.
		await client.adminRefundRequest.updateMany({
			where: {
				id: request.id,
				processingToken: request.processingToken,
				status: { not: "SUCCEEDED" },
			},
			data: {
				status: "UNKNOWN",
				...(observation.providerRefundId ? { providerRefundId: observation.providerRefundId } : {}),
				lastError: adminRefundErrorCode(error),
				processingToken: null,
				processingLeasedUntil: null,
			},
		});
	}
	const current = await readAdminRefundRequest(scope, request.id, client);
	return current.status === "SUCCEEDED"
		? completeCancellation(payment, current, dependencies)
		: readAdminRefundResult(current);
}

async function refundCreditResult(
	payment: AdminRefundPayment,
	request: AdminRefundRequestRecord,
	providerRefundId: string,
	tx: Prisma.TransactionClient,
) {
	let referencePrefix = `stripe-refund:${providerRefundId}:`;
	if (payment.provider !== "stripe") {
		if (payment.productKind === "CREDIT_PACK") {
			const adjustment = await tx.creditPackAdjustment.findUnique({
				where: {
					provider_providerAdjustmentId: {
						provider: payment.provider,
						providerAdjustmentId: providerRefundId,
					},
				},
			});
			referencePrefix = `credit-pack-adjustment:${adjustment?.id}:refund:v1`;
		} else {
			const adjustment = await tx.subscriptionPaymentAdjustment.findUnique({
				where: {
					provider_providerAdjustmentId: {
						provider: payment.provider,
						providerAdjustmentId: providerRefundId,
					},
				},
			});
			referencePrefix = `provider-refund:${adjustment?.id}:`;
		}
	}
	const entries =
		payment.productKind === "IMAGE_PASS"
			? []
			: await tx.creditLedgerEntry.findMany({
					where: { type: "REFUND", referenceKey: { startsWith: referencePrefix } },
				});
	let revoked = 0n;
	let debt = 0n;
	for (const entry of entries) {
		const metadata = objectRecord(entry.metadata);
		revoked +=
			BigInt(storedCreditAmount(metadata.consumedUnused)) +
			BigInt(storedCreditAmount(metadata.revokedReserved));
		debt += BigInt(storedCreditAmount(metadata.debtIncurred));
	}
	return {
		requested: storedCreditAmount(objectRecord(request.result).creditsRequested),
		revoked: revoked.toString(),
		debtIncurred: debt.toString(),
	};
}

function storedCreditAmount(value: unknown): string {
	if (value === null || value === undefined) return "0";
	if (typeof value === "string" && /^\d+$/.test(value)) return value;
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
		return value.toString();
	throw new Error("ADMIN_REFUND_LEDGER_AMOUNT_INVALID");
}

async function completeCancellation(
	payment: AdminRefundPayment,
	request: AdminRefundRequestRecord,
	dependencies: AdminRefundDependencies,
) {
	const client = dependencies.client ?? db;
	const stored = objectRecord(request.result);
	if (stored.cancellationStatus === "NOT_REQUESTED" || stored.cancellationStatus === "SUCCEEDED")
		return readAdminRefundResult(request);
	if (!payment.subscriptionId) return readAdminRefundResult(request);
	let cancellationError: string | null = null;
	const getProvider = dependencies.getProvider ?? getPaymentProvider;
	try {
		const subscription = await client.subscription.findUniqueOrThrow({
			where: { id: payment.subscriptionId },
		});
		if (dependencies.cancel) await dependencies.cancel(payment, request);
		else if (stored.policyRequired === true || subscription.refundTerminationRequestedAt) {
			await terminateRefundedSubscription({ subscriptionId: payment.subscriptionId }, client, {
				getProvider,
				environment: dependencies.environment ?? process.env,
			});
		} else if (request.cancelSubscription && payment.provider === "stripe") {
			const stripe = getStripeClient();
			await getProvider("stripe")!.cancelSubscription!(payment.providerSubscriptionId!);
			const subscription = await stripe.subscriptions.retrieve(payment.providerSubscriptionId!);
			if (subscription.status !== "canceled")
				throw new Error("ADMIN_REFUND_CANCELLATION_UNCONFIRMED");
			await runSerializable(client, (tx) =>
				applyStripeBillingFact(
					normalizeStripeSubscription(subscription, {
						origin: "RECONCILIATION",
						changeAt: new Date(),
						changeId: `admin-refund-cancellation:${request.id}`,
					}),
					tx,
				),
			);
		} else if (request.cancelSubscription && payment.purchaseId) {
			await requestSubscriptionCancellation(
				{
					purchaseId: payment.purchaseId,
					ownerType: payment.ownerType,
					ownerId: payment.ownerId,
				},
				client,
			);
			await confirmSubscriptionCancellation({ subscriptionId: payment.subscriptionId }, client, {
				getProvider,
				environment: dependencies.environment ?? process.env,
			});
		} else throw new Error("ADMIN_REFUND_CANCELLATION_UNSUPPORTED");
	} catch (error) {
		cancellationError = adminRefundErrorCode(error);
	}
	const updated = await runSerializable(client, async (tx) => {
		await tx.$queryRaw`SELECT "id" FROM "admin_refund_request" WHERE "id" = ${request.id} FOR UPDATE`;
		const current = await tx.adminRefundRequest.findUniqueOrThrow({ where: { id: request.id } });
		const subscription = await tx.subscription.findUniqueOrThrow({
			where: { id: payment.subscriptionId! },
		});
		// The existing cancellation helpers can deliberately return without work
		// when refund termination owns this subscription. Only persisted provider
		// confirmation, including another concurrent attempt, establishes success.
		const confirmed =
			payment.provider === "stripe"
				? subscription.status === "CANCELED"
				: subscription.refundTerminationRequestedAt
					? Boolean(subscription.refundTerminatedAt)
					: Boolean(subscription.renewalDisabledAt);
		return tx.adminRefundRequest.update({
			where: { id: current.id },
			data: {
				result: {
					...objectRecord(current.result),
					cancellationStatus: confirmed ? "SUCCEEDED" : "FAILED",
					cancellationError: confirmed
						? null
						: (cancellationError ?? "ADMIN_REFUND_CANCELLATION_UNCONFIRMED"),
				} as Prisma.InputJsonObject,
			},
		});
	});
	return readAdminRefundResult(updated);
}

export function readAdminRefundResult(request: AdminRefundRequestRecord) {
	const result = objectRecord(request.result);
	const status: "PROCESSING" | "UNKNOWN" | "SUCCEEDED" | "FAILED" =
		request.status === "SUCCEEDED" || request.status === "FAILED" || request.status === "UNKNOWN"
			? request.status
			: "PROCESSING";
	const cancellationStatus = ["NOT_REQUESTED", "PENDING", "SUCCEEDED", "FAILED"].includes(
		String(result.cancellationStatus),
	)
		? (result.cancellationStatus as "NOT_REQUESTED" | "PENDING" | "SUCCEEDED" | "FAILED")
		: result.policyRequired || request.cancelSubscription
			? ("PENDING" as const)
			: ("NOT_REQUESTED" as const);
	return {
		orderNo: request.orderNo,
		requestId: request.id,
		status,
		amountMicros: request.amountMicros.toString(),
		currency: request.currency,
		credits: {
			requested: storedCreditAmount(result.creditsRequested),
			revoked: storedCreditAmount(result.creditsRevoked),
			debtIncurred: storedCreditAmount(result.debtIncurred),
		},
		cancellation: {
			policyRequired: result.policyRequired === true,
			status: cancellationStatus,
			error: typeof result.cancellationError === "string" ? result.cancellationError : null,
		},
		error: request.lastError,
	};
}
