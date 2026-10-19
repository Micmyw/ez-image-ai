import { IMAGE_SKU_KEYS_BY_PRODUCT } from "@repo/config";
import { isImagePassOfferSnapshot } from "@repo/config/image-pass";
import { IMAGE_PASS_AMOUNT_MICROS, isImagePassBillingPlan } from "@repo/config/image-pass.server";

import type { Prisma } from "../../generated/client";

export type GenerationFundingSource = "CREDITS" | "IMAGE_PASS";
type ImagePassReadClient = Pick<Prisma.TransactionClient, "$queryRaw">;
export interface GenerationFundingReservation {
	id: string;
	amount: bigint;
	status: "ACTIVE" | "SETTLED" | "RELEASED";
	fundingSource: GenerationFundingSource;
}
export async function getGenerationFundingReservation(
	jobId: string,
	tx: Prisma.TransactionClient,
	knownCreditReservation?: { id: string; amount: bigint; status: string } | null,
): Promise<GenerationFundingReservation | null> {
	const credit =
		knownCreditReservation === undefined
			? await tx.creditReservation.findUnique({
					where: { jobId },
					select: { id: true, amount: true, status: true },
				})
			: knownCreditReservation;
	if (credit) {
		if (!["ACTIVE", "SETTLED", "RELEASED"].includes(credit.status))
			throw new Error("GENERATION_FUNDING_CONFLICT");
		return {
			...credit,
			status: credit.status as GenerationFundingReservation["status"],
			fundingSource: "CREDITS",
		};
	}
	const [pass] = await tx.$queryRaw<
		GenerationFundingReservation[]
	>`SELECT r."id",1::bigint AS "amount",r."status",'IMAGE_PASS'::text AS "fundingSource" FROM "image_pass_reservation" r JOIN "generation_job" job ON job."id"=r."jobId" WHERE r."jobId"=${jobId} AND job."fundingSource"='IMAGE_PASS' AND job."creditsReserved"=0 AND job."ownerId"=r."ownerId"`;
	return pass ?? null;
}
export async function assertImagePassAvailable(
	input: { ownerId: string; productKey: string; skuKey: unknown; requestedOutputCount?: unknown },
	tx: ImagePassReadClient,
): Promise<void> {
	assertImagePassSelection({ ...input, requestedOutputCount: input.requestedOutputCount ?? 1 });
	const [unit] = await tx.$queryRaw<
		Array<{ id: string }>
	>`SELECT unit."id" FROM "image_pass_unit" unit JOIN "image_pass_grant" g ON g."id"=unit."grantId" WHERE g."ownerId"=${input.ownerId} AND g."status"='ACTIVE' AND unit."status"='AVAILABLE' AND (g."offerSnapshot"->'allowedSkuKeys') ? ${String(input.skuKey)} LIMIT 1`;
	if (!unit) throw new Error("IMAGE_PASS_INSUFFICIENT");
}
export async function reserveImagePassForJobInTransaction(
	input: { ownerId: string; jobId: string },
	tx: Prisma.TransactionClient,
) {
	await lockImagePassOwner(input.ownerId, tx);
	const [job] = await tx.$queryRaw<
		Array<{
			ownerId: string;
			ownerType: string;
			fundingSource: string;
			creditsReserved: bigint;
			productKey: string;
			pricingSnapshot: unknown;
			status: string;
		}>
	>`SELECT "ownerId","ownerType","fundingSource","creditsReserved","productKey","pricingSnapshot","status" FROM "generation_job" WHERE "id"=${input.jobId} FOR UPDATE`;
	if (!job || job.ownerType !== "USER" || job.ownerId !== input.ownerId)
		throw new Error("IMAGE_PASS_OWNER_INVALID");
	if (
		job.fundingSource !== "IMAGE_PASS" ||
		job.creditsReserved !== 0n ||
		generationFundingSource(job.pricingSnapshot) !== "IMAGE_PASS"
	)
		throw new Error("GENERATION_FUNDING_CONFLICT");
	const snapshot = record(job.pricingSnapshot);
	const policy = record(snapshot?.settlementPolicy);
	assertImagePassSelection({
		productKey: job.productKey,
		skuKey: snapshot?.skuKey,
		requestedOutputCount: policy?.requestedOutputCount,
	});
	const replay = await getGenerationFundingReservation(input.jobId, tx, null);
	if (replay) return replay;
	if (!["RESERVED", "DISPATCH_QUEUED"].includes(job.status))
		throw new Error("IMAGE_PASS_UNAVAILABLE");
	const [unit] = await tx.$queryRaw<
		Array<{ id: string; grantId: string }>
	>`SELECT unit."id",unit."grantId" FROM "image_pass_unit" unit JOIN "image_pass_grant" g ON g."id"=unit."grantId" WHERE g."ownerId"=${input.ownerId} AND g."status"='ACTIVE' AND unit."status"='AVAILABLE' AND (g."offerSnapshot"->'allowedSkuKeys') ? ${String(snapshot?.skuKey)} ORDER BY g."paidAt",g."id",unit."ordinal" LIMIT 1 FOR UPDATE OF unit,g`;
	if (!unit) throw new Error("IMAGE_PASS_INSUFFICIENT");
	const id = crypto.randomUUID();
	await tx.$executeRaw`UPDATE "image_pass_unit" SET "status"='RESERVED' WHERE "id"=${unit.id} AND "status"='AVAILABLE'`;
	await tx.$executeRaw`INSERT INTO "image_pass_reservation" ("id","unitId","jobId","ownerId") VALUES (${id},${unit.id},${input.jobId},${input.ownerId})`;
	await writeImagePassLedger(
		{
			grantId: unit.grantId,
			unitId: unit.id,
			jobId: input.jobId,
			operation: "RESERVE",
			referenceKey: `image-pass:${input.jobId}:reserve`,
		},
		tx,
	);
	return { id, amount: 1n, status: "ACTIVE" as const, fundingSource: "IMAGE_PASS" as const };
}
/** The settlement caller first verifies current moderation evidence under media-verification locks. */
export async function finalizeImagePassReservationInTransaction(
	input: { ownerId: string; jobId: string; hasUsableOutput: boolean },
	tx: Prisma.TransactionClient,
): Promise<{ status: "SETTLED" | "RELEASED"; replayed: boolean }> {
	await lockImagePassOwner(input.ownerId, tx);
	const [reservation] = await tx.$queryRaw<
		Array<{
			id: string;
			unitId: string;
			grantId: string;
			status: "ACTIVE" | "SETTLED" | "RELEASED";
			grantStatus: string;
			ownerId: string;
			jobOwner: string;
			ownerType: string;
			fundingSource: string;
			creditsReserved: bigint;
			jobStatus: string;
			failureCode: string | null;
		}>
	>`SELECT r."id",r."unitId",unit."grantId",r."status",g."status" AS "grantStatus",r."ownerId",job."ownerId" AS "jobOwner",job."ownerType",job."fundingSource",job."creditsReserved",job."status" AS "jobStatus",job."failureCode" FROM "image_pass_reservation" r JOIN "image_pass_unit" unit ON unit."id"=r."unitId" JOIN "image_pass_grant" g ON g."id"=unit."grantId" JOIN "generation_job" job ON job."id"=r."jobId" WHERE r."jobId"=${input.jobId} FOR UPDATE OF r,unit,g,job`;
	if (
		!reservation ||
		reservation.ownerId !== input.ownerId ||
		reservation.jobOwner !== input.ownerId ||
		reservation.ownerType !== "USER"
	)
		throw new Error("IMAGE_PASS_OWNER_INVALID");
	if (reservation.fundingSource !== "IMAGE_PASS" || reservation.creditsReserved !== 0n)
		throw new Error("GENERATION_FUNDING_CONFLICT");
	if (reservation.status !== "ACTIVE") {
		if (reservation.status === "RELEASED" && input.hasUsableOutput)
			throw new Error("IMAGE_PASS_FINALIZATION_CONFLICT");
		return { status: reservation.status, replayed: true };
	}
	if (!["FINALIZING", "CANCELED"].includes(reservation.jobStatus))
		throw new Error("IMAGE_PASS_OUTCOME_UNCERTAIN");
	const [outputs] = await tx.$queryRaw<
		Array<{ total: bigint; ready: bigint; readyState: bigint; pending: bigint }>
	>`SELECT COUNT(*) AS "total",COUNT(*) FILTER (WHERE asset."status"='READY') AS "readyState",COUNT(*) FILTER (WHERE asset."ownerType"='USER' AND asset."ownerId"=${input.ownerId} AND asset."kind"='OUTPUT' AND asset."status"='READY' AND asset."deletedAt" IS NULL AND (asset."deleteAfter" IS NULL OR asset."deleteAfter">CURRENT_TIMESTAMP) AND asset."verificationValidUntil">CURRENT_TIMESTAMP AND asset."finalizedAt" IS NOT NULL AND asset."byteSize">0 AND asset."mimeType" LIKE 'image/%' AND asset."checksum"=binding."assetChecksum") AS "ready",COUNT(*) FILTER (WHERE asset."status" IN ('UPLOADING','VERIFYING')) AS "pending" FROM "generation_job_asset" binding JOIN "media_asset" asset ON asset."id"=binding."assetId" WHERE binding."jobId"=${input.jobId} AND binding."role"='OUTPUT'`;
	if (input.hasUsableOutput) {
		if (outputs?.total !== 1n) throw new Error("IMAGE_PASS_OUTPUT_COUNT_INVALID");
		if (outputs.ready !== 1n) throw new Error("IMAGE_PASS_OUTPUT_NOT_USABLE");
	} else {
		const [attempts] = await tx.$queryRaw<
			Array<{ uncertain: boolean; succeeded: boolean }>
		>`SELECT EXISTS(SELECT 1 FROM "generation_attempt" WHERE "jobId"=${input.jobId} AND ("uncertainSubmission" OR "status" IN ('SUBMISSION_UNCERTAIN','SUBMITTED','RUNNING','NEEDS_RECONCILIATION'))) AS "uncertain",EXISTS(SELECT 1 FROM "generation_attempt" WHERE "jobId"=${input.jobId} AND "status"='SUCCEEDED') AS "succeeded"`;
		if (
			(outputs?.readyState ?? 0n) > 0n ||
			(outputs?.pending ?? 0n) > 0n ||
			attempts?.uncertain ||
			(attempts?.succeeded &&
				outputs?.total === 0n &&
				reservation.failureCode !== "IMAGE_PASS_OUTPUT_CARDINALITY_INVALID")
		)
			throw new Error("IMAGE_PASS_OUTCOME_UNCERTAIN");
	}
	const status = input.hasUsableOutput ? "SETTLED" : "RELEASED";
	const unitStatus = input.hasUsableOutput
		? "CONSUMED"
		: reservation.grantStatus === "ACTIVE"
			? "AVAILABLE"
			: "REVOKED";
	await tx.$executeRaw`UPDATE "image_pass_reservation" SET "status"=${status},"finalizedAt"=CURRENT_TIMESTAMP WHERE "id"=${reservation.id} AND "status"='ACTIVE'`;
	await tx.$executeRaw`UPDATE "image_pass_unit" SET "status"=${unitStatus} WHERE "id"=${reservation.unitId} AND "status"='RESERVED'`;
	await writeImagePassLedger(
		{
			grantId: reservation.grantId,
			unitId: reservation.unitId,
			jobId: input.jobId,
			operation: input.hasUsableOutput ? "CONSUME" : "RELEASE",
			referenceKey: `image-pass:${input.jobId}:finalize`,
			metadata: { unitStatus },
		},
		tx,
	);
	return { status, replayed: false };
}
export async function revokeImagePassPurchaseInTransaction(
	input: {
		provider: "paypal";
		providerPaymentId: string;
		providerAdjustmentId: string;
		amountMicros: bigint;
		currency: string;
		occurredAt: Date;
		kind: "REFUND" | "DISPUTE";
	},
	tx: Prisma.TransactionClient,
): Promise<{ replayed: boolean }> {
	if (
		input.provider !== "paypal" ||
		!input.providerPaymentId ||
		!input.providerAdjustmentId ||
		input.amountMicros <= 0n ||
		input.amountMicros > IMAGE_PASS_AMOUNT_MICROS ||
		input.currency !== "USD" ||
		!["REFUND", "DISPUTE"].includes(input.kind) ||
		!Number.isFinite(input.occurredAt.getTime())
	)
		throw new Error("IMAGE_PASS_ADJUSTMENT_INVALID");
	await lockImagePassPayment(input.providerPaymentId, tx);
	const grant = await getImagePassPurchaseByProviderPayment(input, tx);
	if (!grant) throw new Error("PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISSING");
	await lockImagePassOwner(grant.ownerId, tx);
	const [existing] = await tx.$queryRaw<
		Array<{ grantId: string; kind: string; amountMicros: bigint; currency: string }>
	>`SELECT "grantId","kind","amountMicros","currency" FROM "image_pass_adjustment" WHERE "provider"='paypal' AND "providerAdjustmentId"=${input.providerAdjustmentId}`;
	if (existing) {
		if (
			existing.grantId !== grant.id ||
			existing.kind !== input.kind ||
			existing.amountMicros !== input.amountMicros ||
			existing.currency !== input.currency
		)
			throw new Error("IMAGE_PASS_ADJUSTMENT_BINDING_CONFLICT");
		return { replayed: true };
	}
	await tx.$executeRaw`INSERT INTO "image_pass_adjustment" ("id","grantId","provider","providerAdjustmentId","kind","amountMicros","currency","occurredAt") VALUES (${crypto.randomUUID()},${grant.id},'paypal',${input.providerAdjustmentId},${input.kind},${input.amountMicros},'USD',${input.occurredAt})`;
	await tx.$executeRaw`UPDATE "image_pass_grant" SET "status"='FROZEN' WHERE "id"=${grant.id}`;
	const units = await tx.$queryRaw<
		Array<{ id: string }>
	>`UPDATE "image_pass_unit" SET "status"='REVOKED' WHERE "grantId"=${grant.id} AND "status"='AVAILABLE' RETURNING "id"`;
	for (const unit of units)
		await writeImagePassLedger(
			{
				grantId: grant.id,
				unitId: unit.id,
				operation: "REVOKE",
				referenceKey: `image-pass:${input.providerAdjustmentId}:revoke:${unit.id}`,
				metadata: { kind: input.kind },
			},
			tx,
		);
	await writeImagePassLedger(
		{
			grantId: grant.id,
			operation: "FREEZE",
			referenceKey: `image-pass:${input.providerAdjustmentId}:freeze`,
			metadata: { kind: input.kind },
		},
		tx,
	);
	return { replayed: false };
}
export interface FulfillImagePassPurchaseInput {
	checkoutIntentId: string;
	provider: "paypal";
	providerPaymentId: string;
	providerOrderId: string;
	amountMicros: bigint;
	currency: string;
	occurredAt: Date;
	paymentEventId?: string;
}
export async function fulfillImagePassPurchaseInTransaction(
	input: FulfillImagePassPurchaseInput,
	tx: Prisma.TransactionClient,
): Promise<{ created: boolean; grantId: string }> {
	if (
		input.provider !== "paypal" ||
		input.amountMicros !== IMAGE_PASS_AMOUNT_MICROS ||
		input.currency !== "USD" ||
		!input.providerPaymentId ||
		!input.providerOrderId ||
		!Number.isFinite(input.occurredAt.getTime())
	)
		throw new Error("IMAGE_PASS_PAYMENT_INVALID");
	await lockImagePassPayment(input.providerPaymentId, tx);
	const existing = await tx.$queryRaw<
		Array<{
			id: string;
			checkoutIntentId: string;
			providerOrderId: string;
			providerPaymentId: string;
			paidAmountMicros: bigint;
			currency: string;
		}>
	>`
		SELECT "id","checkoutIntentId","providerOrderId","providerPaymentId","paidAmountMicros","currency" FROM "image_pass_grant"
		WHERE "provider"='paypal' AND ("providerPaymentId"=${input.providerPaymentId} OR "providerOrderId"=${input.providerOrderId} OR "checkoutIntentId"=${input.checkoutIntentId})`;
	if (existing.length) {
		const grant = existing[0]!;
		if (
			existing.length !== 1 ||
			grant.checkoutIntentId !== input.checkoutIntentId ||
			grant.providerOrderId !== input.providerOrderId ||
			grant.providerPaymentId !== input.providerPaymentId ||
			grant.paidAmountMicros !== input.amountMicros ||
			grant.currency !== input.currency
		)
			throw new Error("IMAGE_PASS_PAYMENT_BINDING_CONFLICT");
		return { created: false, grantId: grant.id };
	}
	const [intent] = await tx.$queryRaw<
		Array<{
			id: string;
			ownerType: string;
			ownerId: string;
			submittedByUserId: string;
			provider: string;
			providerOrderId: string | null;
			productKind: string;
			status: string;
			interval: string;
			planKey: string;
			imagePassOfferSnapshot: unknown;
			attribution: unknown;
			planProvider: string;
			providerPriceId: string;
			planProductKind: string;
			planName: string;
			priceMicros: bigint;
			currency: string;
			creditsPerPeriod: bigint;
			metadata: unknown;
		}>
	>`
		SELECT intent.*,plan."provider" AS "planProvider",plan."providerPriceId",plan."productKind"::text AS "planProductKind",plan."name" AS "planName",plan."priceMicros",plan."currency",plan."creditsPerPeriod",plan."metadata"
		FROM "payment_checkout_intent" intent JOIN "billing_plan" plan ON plan."id"=intent."billingPlanId"
		WHERE intent."id"=${input.checkoutIntentId} FOR UPDATE OF intent`;
	if (!intent) throw new Error("PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISSING");
	if (
		intent.provider !== "paypal" ||
		intent.ownerType !== "USER" ||
		intent.ownerId !== intent.submittedByUserId ||
		intent.productKind !== "IMAGE_PASS" ||
		intent.interval !== "one-time" ||
		intent.planKey !== "image-pass-3" ||
		intent.providerOrderId !== input.providerOrderId ||
		intent.status !== "PROVIDER_PENDING" ||
		!isImagePassOfferSnapshot(intent.imagePassOfferSnapshot) ||
		!isImagePassBillingPlan({
			provider: intent.planProvider,
			providerPriceId: intent.providerPriceId,
			productKind: intent.planProductKind,
			name: intent.planName,
			priceMicros: intent.priceMicros,
			currency: intent.currency,
			creditsPerPeriod: intent.creditsPerPeriod,
			metadata: intent.metadata,
		})
	)
		throw new Error("IMAGE_PASS_PAYMENT_BINDING_CONFLICT");
	await lockImagePassOwner(intent.ownerId, tx);
	const duplicate = await tx.$queryRaw<
		Array<{ id: string }>
	>`SELECT "id" FROM "image_pass_grant" WHERE "checkoutIntentId"=${input.checkoutIntentId}`;
	if (duplicate.length) throw new Error("IMAGE_PASS_PAYMENT_BINDING_CONFLICT");
	const grantId = crypto.randomUUID();
	const purchaseId = crypto.randomUUID();
	await tx.$executeRaw`INSERT INTO "purchase" ("id","provider","type","productKind","customerId","priceId","status","userId","createdAt","updatedAt","attribution") VALUES (${purchaseId},'paypal','ONE_TIME','IMAGE_PASS',${`paypal:image-pass:${input.providerPaymentId}`},${intent.providerPriceId},'completed',${intent.ownerId},CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,${JSON.stringify(intent.attribution ?? null)}::jsonb)`;
	await tx.$executeRaw`INSERT INTO "image_pass_grant" ("id","checkoutIntentId","purchaseId","ownerId","provider","providerOrderId","providerPaymentId","paidAmountMicros","currency","offerSnapshot","paidAt") VALUES (${grantId},${input.checkoutIntentId},${purchaseId},${intent.ownerId},'paypal',${input.providerOrderId},${input.providerPaymentId},${input.amountMicros},'USD',${JSON.stringify(intent.imagePassOfferSnapshot)}::jsonb,${input.occurredAt})`;
	for (let ordinal = 1; ordinal <= 3; ordinal++) {
		const unitId = crypto.randomUUID();
		await tx.$executeRaw`INSERT INTO "image_pass_unit" ("id","grantId","ordinal") VALUES (${unitId},${grantId},${ordinal})`;
		await writeImagePassLedger(
			{
				grantId,
				unitId,
				operation: "GRANT",
				referenceKey: `image-pass:${grantId}:grant:${ordinal}`,
				metadata: { paymentEventId: input.paymentEventId ?? null },
			},
			tx,
		);
	}
	await tx.$executeRaw`UPDATE "payment_checkout_intent" SET "status"='COMPLETED',"activeScopeKey"=NULL,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=${input.checkoutIntentId} AND "status"='PROVIDER_PENDING'`;
	return { created: true, grantId };
}
export async function getImagePassBalance(
	input: { ownerId: string },
	tx: Prisma.TransactionClient,
) {
	const [row] = await tx.$queryRaw<
		Array<{ available: bigint; reserved: bigint; consumed: bigint; revoked: bigint }>
	>`
		SELECT COUNT(*) FILTER (WHERE unit."status"='AVAILABLE' AND g."status"='ACTIVE') AS "available",
		COUNT(*) FILTER (WHERE unit."status"='RESERVED') AS "reserved",COUNT(*) FILTER (WHERE unit."status"='CONSUMED') AS "consumed",COUNT(*) FILTER (WHERE unit."status"='REVOKED') AS "revoked"
		FROM "image_pass_unit" unit JOIN "image_pass_grant" g ON g."id"=unit."grantId" WHERE g."ownerId"=${input.ownerId}`;
	return {
		available: Number(row?.available ?? 0),
		reserved: Number(row?.reserved ?? 0),
		consumed: Number(row?.consumed ?? 0),
		revoked: Number(row?.revoked ?? 0),
	};
}

export interface ImagePassPurchase {
	id: string;
	checkoutIntentId: string;
	providerOrderId: string;
	ownerId: string;
	status: "ACTIVE" | "FROZEN";
}
export async function getImagePassPurchaseByProviderPayment(
	input: { provider: "paypal"; providerPaymentId: string },
	tx: Prisma.TransactionClient,
): Promise<ImagePassPurchase | null> {
	const [row] = await tx.$queryRaw<
		ImagePassPurchase[]
	>`SELECT "id","checkoutIntentId","providerOrderId","ownerId","status" FROM "image_pass_grant" WHERE "provider"=${input.provider} AND "providerPaymentId"=${input.providerPaymentId}`;
	return row ?? null;
}
export async function getImagePassPurchaseForCheckoutIntent(
	input: { checkoutIntentId: string; ownerType: "USER"; ownerId: string },
	tx: Prisma.TransactionClient,
): Promise<ImagePassPurchase | null> {
	if (input.ownerType !== "USER") throw new Error("IMAGE_PASS_OWNER_INVALID");
	const [row] = await tx.$queryRaw<
		ImagePassPurchase[]
	>`SELECT "id","checkoutIntentId","providerOrderId","ownerId","status" FROM "image_pass_grant" WHERE "checkoutIntentId"=${input.checkoutIntentId} AND "ownerId"=${input.ownerId}`;
	return row ?? null;
}

async function lockImagePassPayment(
	providerPaymentId: string,
	tx: Prisma.TransactionClient,
): Promise<void> {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`image-pass-payment:paypal:${providerPaymentId}`},0))`;
}
async function lockImagePassOwner(ownerId: string, tx: Prisma.TransactionClient): Promise<void> {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`image-pass-owner:${ownerId}`},0))`;
}
async function writeImagePassLedger(
	input: {
		grantId: string;
		unitId?: string;
		jobId?: string;
		operation: string;
		referenceKey: string;
		metadata?: Record<string, unknown>;
	},
	tx: Prisma.TransactionClient,
): Promise<void> {
	await tx.$executeRaw`INSERT INTO "image_pass_ledger_entry" ("id","grantId","unitId","jobId","operation","referenceKey","metadata") VALUES (${crypto.randomUUID()},${input.grantId},${input.unitId ?? null},${input.jobId ?? null},${input.operation},${input.referenceKey},${JSON.stringify(input.metadata ?? {})}::jsonb)`;
}
export function generationFundingSource(snapshot: unknown): GenerationFundingSource {
	const value = record(snapshot)?.fundingSource;
	if (value === undefined) return "CREDITS";
	if (value !== "CREDITS" && value !== "IMAGE_PASS") throw new Error("GENERATION_FUNDING_CONFLICT");
	return value;
}
export function assertImagePassSelection(input: {
	productKey: string;
	skuKey: unknown;
	requestedOutputCount: unknown;
}): void {
	if (input.requestedOutputCount !== 1) throw new Error("IMAGE_PASS_OUTPUT_COUNT_INVALID");
	const skus = IMAGE_SKU_KEYS_BY_PRODUCT[
		input.productKey as keyof typeof IMAGE_SKU_KEYS_BY_PRODUCT
	] as readonly string[] | undefined;
	if (typeof input.skuKey !== "string" || !skus?.includes(input.skuKey))
		throw new Error("IMAGE_PASS_SELECTION_INVALID");
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
