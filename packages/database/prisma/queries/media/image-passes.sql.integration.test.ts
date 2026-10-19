import { getImagePassOfferSnapshot } from "@repo/config/image-pass";
import { IMAGE_PASS_PAYPAL_SKU } from "@repo/config/image-pass.server";
import { Pool, types } from "pg";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

import {
	fulfillImagePassPurchaseInTransaction,
	getImagePassBalance,
	reserveImagePassForJobInTransaction,
	finalizeImagePassReservationInTransaction,
	revokeImagePassPurchaseInTransaction,
} from "./image-passes";
vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		throw new Error("explicit test transport required");
	},
}));
vi.mock("./credits", () => ({
	reserveCreditsInTransaction: async () => {
		throw new Error("ordinary credits must not fund image-pass admission");
	},
}));
import { createGenerationJobTransaction } from "./jobs";
import { fingerprintGenerationQuoteSecurityPayload } from "./quotes";

types.setTypeParser(20, BigInt);
const url = process.env.IMAGE_PASS_TEST_DATABASE_URL;
const target = url ? new URL(url) : null;
const enabled =
	!!target &&
	target.hostname === "127.0.0.1" &&
	["55439", "55441"].includes(target.port) &&
	target.pathname === "/image_pass_test" &&
	target.username === "ai_media_test";
if (url && !enabled) throw new Error("ISOLATED_IMAGE_PASS_DATABASE_REQUIRED");
const pool = enabled ? new Pool({ connectionString: url, max: 8 }) : null;

/** Only the Prisma transport is adapted; these tests execute the production SQL against PostgreSQL. */
export async function sqlTransaction<T>(
	operation: (tx: any) => Promise<T>,
	options?: { isolationLevel?: string },
): Promise<T> {
	if (!pool) throw new Error("ISOLATED_IMAGE_PASS_DATABASE_REQUIRED");
	const c = await pool.connect();
	const query = async (parts: TemplateStringsArray, ...values: unknown[]) =>
		c.query(
			parts.reduce((text, part, i) => text + (i ? `$${i}` : "") + part, ""),
			values,
		);
	const tx = {
		$queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
			(await query(parts, ...values)).rows,
		$executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
			(await query(parts, ...values)).rowCount,
		generationQuote: {
			findUnique: async ({ where }: any) =>
				(await c.query(`SELECT * FROM generation_quote WHERE id=$1`, [where.id])).rows[0] ?? null,
		},
		generationJob: {
			findUnique: async ({ where }: any) => {
				const key = where.ownerType_ownerId_idempotencyKey;
				const row = (
					await c.query(
						`SELECT * FROM generation_job WHERE "ownerType"=$1 AND "ownerId"=$2 AND "idempotencyKey"=$3`,
						[key.ownerType, key.ownerId, key.idempotencyKey],
					)
				).rows[0];
				return row ? { ...row, reservation: null, editSession: null } : null;
			},
			count: async ({ where }: any) =>
				Number(
					(
						await c.query(
							`SELECT count(*) FROM generation_job WHERE "ownerType"=$1 AND "ownerId"=$2 AND status=ANY($3::"GenerationJobStatus"[])`,
							[where.ownerType, where.ownerId, where.status.in],
						)
					).rows[0].count,
				),
			create: async ({ data }: any) => {
				const value: Record<string, unknown> = {
					id: crypto.randomUUID(),
					...data,
					updatedAt: new Date(),
				};
				const keys = Object.keys(value);
				return (
					await c.query(
						`INSERT INTO generation_job (${keys.map((key) => `"${key}"`).join(",")}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(",")}) RETURNING *`,
						keys.map((key) =>
							["inputSnapshot", "pricingSnapshot"].includes(key)
								? JSON.stringify(value[key])
								: value[key],
						),
					)
				).rows[0];
			},
		},
		runtimeConfigOverride: {
			findMany: async ({ where }: any) =>
				(
					await c.query(
						`SELECT "configKey" FROM runtime_config_override WHERE active AND value='false'::jsonb AND "configKey"=ANY($1::text[])`,
						[where.configKey.in],
					)
				).rows,
		},
		subscription: {
			findMany: async ({ where }: any) => {
				const now = where.OR?.[0]?.currentPeriodStart?.lte ?? new Date();
				const rows = (
					await c.query(
						`SELECT s.*, jsonb_build_object('metadata',p.metadata,'name',p.name,'productKind',p."productKind") AS plan
					FROM subscription s JOIN billing_plan p ON p.id=s."planId"
					WHERE s."ownerType"=$1 AND s."ownerId"=$2 AND s."refundTerminationRequestedAt" IS NULL
					AND ((s.status IN ('ACTIVE','CANCELED') AND s."currentPeriodStart"<=$3 AND s."currentPeriodEnd">$3
					AND EXISTS (SELECT 1 FROM billing_period b WHERE b."subscriptionId"=s.id AND b."startsAt"<=$3 AND b."endsAt">$3 AND b."paidAmount">0 AND b."refundedAmount"<b."paidAmount" AND b.status<>'VOID'))
					OR (s.status='PAST_DUE' AND s."graceEndsAt">$3 AND EXISTS (SELECT 1 FROM billing_period b WHERE b."subscriptionId"=s.id AND b."startsAt"<=$3 AND b."paidAmount">0 AND b.status<>'VOID')))
					ORDER BY s."updatedAt" DESC,s.id DESC`,
						[where.ownerType, where.ownerId, now],
					)
				).rows;
				for (const row of rows)
					row.periods = (
						await c.query(
							`SELECT "paidAmount","refundedAmount","providerInvoiceId" FROM billing_period WHERE "subscriptionId"=$1 AND "startsAt"<=$2 AND "paidAmount">0 AND status<>'VOID' ORDER BY "startsAt" DESC LIMIT 1`,
							[row.id, now],
						)
					).rows;
				return rows;
			},
		},
		billingPeriod: { fields: { paidAmount: "paidAmount" } },
		creditAccount: {
			findUnique: async ({ where }: any) =>
				(
					await c.query(`SELECT * FROM credit_account WHERE "ownerType"=$1 AND "ownerId"=$2`, [
						where.ownerType_ownerId.ownerType,
						where.ownerType_ownerId.ownerId,
					])
				).rows[0] ?? null,
		},
		generationJobAsset: {
			findMany: async ({ where }: any) =>
				(
					await c.query(`SELECT * FROM generation_job_asset WHERE "jobId"=$1 AND role=$2`, [
						where.jobId,
						where.role,
					])
				).rows,
		},
		storageUsageReservation: {
			aggregate: async ({ where }: any) => ({
				_sum: {
					bytes: (
						await c.query(
							`SELECT SUM(bytes) AS total FROM storage_usage_reservation WHERE "ownerType"=$1 AND "ownerId"=$2 AND status=ANY($3::"StorageReservationStatus"[])`,
							[where.ownerType, where.ownerId, where.status.in],
						)
					).rows[0].total,
				},
			}),
		},
		outboxEvent: {
			create: async ({ data }: any) => {
				await c.query(
					`INSERT INTO outbox_event (id,"eventType","aggregateType","aggregateId","dedupeKey",payload) VALUES ($1,$2,$3,$4,$5,$6)`,
					[
						crypto.randomUUID(),
						data.eventType,
						data.aggregateType,
						data.aggregateId,
						data.dedupeKey,
						JSON.stringify(data.payload),
					],
				);
				return {};
			},
			findMany: async ({ where }: any) => {
				const q = where.AND[0];
				return (
					await c.query(
						`SELECT id FROM outbox_event WHERE "aggregateType"=$1 AND "aggregateId"=$2 AND "eventType"=ANY($3::text[]) AND status IN ('PENDING','LEASED')`,
						[q.aggregateType, q.aggregateId, q.eventType.in],
					)
				).rows;
			},
		},
	};
	if (
		options?.isolationLevel &&
		!["ReadCommitted", "Serializable"].includes(options.isolationLevel)
	)
		throw new Error("UNSUPPORTED_TEST_TRANSACTION_ISOLATION");
	await c.query(
		options?.isolationLevel === "Serializable"
			? "BEGIN ISOLATION LEVEL SERIALIZABLE"
			: "BEGIN ISOLATION LEVEL READ COMMITTED",
	);
	try {
		const value = await operation(tx);
		await c.query("COMMIT");
		return value;
	} catch (error) {
		await c.query("ROLLBACK");
		throw error;
	} finally {
		c.release();
	}
}

async function paymentFixture(existingOwnerId?: string) {
	const suffix = crypto.randomUUID();
	const ownerId = existingOwnerId ?? `image-pass-owner-${suffix}`;
	let billingPlanId = `image-pass-plan-${suffix}`;
	const checkoutIntentId = `image-pass-checkout-${suffix}`;
	const providerOrderId = `order-${suffix}`;
	const providerPaymentId = `capture-${suffix}`;
	const snapshot = getImagePassOfferSnapshot();
	if (!existingOwnerId)
		await pool!.query(
			`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'pass fixture',$2,true,NOW(),NOW())`,
			[ownerId, `${suffix}@test.invalid`],
		);
	const plan = await pool!.query(
		`INSERT INTO billing_plan (id,provider,"providerPriceId","productKind",name,"creditsPerPeriod","priceMicros",currency,metadata,"updatedAt") VALUES ($1,'paypal',$2,'IMAGE_PASS','image-pass-3',0,1000000,'USD',$3,NOW()) ON CONFLICT (provider,"providerPriceId") DO UPDATE SET metadata=EXCLUDED.metadata RETURNING id`,
		[billingPlanId, IMAGE_PASS_PAYPAL_SKU, JSON.stringify({ imagePassOfferSnapshot: snapshot })],
	);
	billingPlanId = plan.rows[0].id;
	await pool!.query(
		`INSERT INTO payment_checkout_intent (id,provider,"ownerType","ownerId","submittedByUserId","productKind","billingPlanId","planKey",interval,"idempotencyKey","providerOrderId",status,"imagePassOfferSnapshot","updatedAt") VALUES ($1,'paypal','USER',$2,$2,'IMAGE_PASS',$3,'image-pass-3','one-time',$1,$4,'PROVIDER_PENDING',$5,NOW())`,
		[checkoutIntentId, ownerId, billingPlanId, providerOrderId, JSON.stringify(snapshot)],
	);
	return {
		ownerId,
		billingPlanId,
		checkoutIntentId,
		provider: "paypal" as const,
		providerOrderId,
		providerPaymentId,
		amountMicros: 1_000_000n,
		currency: "USD",
		occurredAt: new Date(),
	};
}

async function jobFixture(ownerId: string, status = "RESERVED") {
	const id = `pass-job-${crypto.randomUUID()}`;
	const snapshot = {
		fundingSource: "IMAGE_PASS",
		skuKey: "nano-banana-pro-4k",
		settlementPolicy: { unitCredits: "25", requestedOutputCount: 1, maxCharge: "25" },
	};
	await pool!.query(
		`INSERT INTO generation_quote (id,"ownerType","ownerId","submittedByUserId","productKey","catalogVersion","pricingVersion",credits,"costMicros","inputSnapshot","pricingSnapshot","expiresAt") VALUES ($1,'USER',$2,$2,'image-nano-banana-pro','2026-09-14.1','2026-09-13.2',25,120000,'{}',$3,NOW()+INTERVAL '1 hour')`,
		[`${id}-quote`, ownerId, JSON.stringify(snapshot)],
	);
	await pool!.query(
		`INSERT INTO generation_job (id,"ownerType","ownerId","submittedByUserId","quoteId","idempotencyKey","productKey","catalogVersion","pricingVersion","creditsReserved","fundingSource","inputSnapshot","pricingSnapshot",status,"updatedAt") VALUES ($1,'USER',$2,$2,$3,$1,'image-nano-banana-pro','2026-09-14.1','2026-09-13.2',0,'IMAGE_PASS','{}',$4,$5,NOW())`,
		[id, ownerId, `${id}-quote`, JSON.stringify(snapshot), status],
	);
	return id;
}

async function readyOutput(
	jobId: string,
	ownerId: string,
	validUntil = new Date(Date.now() + 3_600_000),
) {
	const id = `pass-output-${crypto.randomUUID()}`;
	const checksum = "a".repeat(64);
	await pool!.query(
		`INSERT INTO media_asset (id,"ownerType","ownerId",kind,status,"objectKey","mimeType","byteSize",checksum,"finalizedAt","verificationGeneration","verificationAttemptCount","verificationProvider","verificationRuleVersion","verificationPolicyVersion","verificationProviderTaskId","verificationValidUntil","updatedAt") VALUES ($1,'USER',$2,'OUTPUT','VERIFYING',$1,'image/png',100,$3,NOW(),1,1,'seeapi','image-pass-test-rule','image-pass-test-policy',$1,$4,NOW())`,
		[id, ownerId, checksum, validUntil],
	);
	await pool!.query(
		`INSERT INTO asset_moderation_result (id,"assetId","assetChecksum","verificationGeneration","attemptNumber","evidenceKind",provider,"providerTaskId","ruleVersion","policyVersion",status,"reasonCode",categories,"rawEnvelope","validUntil") VALUES ($1,$1,$2,1,1,'OUTPUT','seeapi',$1,'image-pass-test-rule','image-pass-test-policy','APPROVED','NO_POLICY_MATCH','{}','{}',$3)`,
		[id, checksum, validUntil],
	);
	await pool!.query(`UPDATE media_asset SET status='READY' WHERE id=$1`, [id]);
	await pool!.query(
		`INSERT INTO generation_job_asset (id,"jobId","assetId","assetChecksum",role) VALUES ($1,$2,$1,$3,'OUTPUT')`,
		[id, jobId, checksum],
	);
	return id;
}

describe.skipIf(!enabled)("image-pass real PostgreSQL ledger", () => {
	beforeAll(async () => {
		await pool!.query("SELECT 1");
	});
	afterAll(async () => {
		await pool?.end();
	});
	it("fulfills one verified dollar as exactly three independent units and no ordinary credits", async () => {
		const f = await paymentFixture();
		const result = await sqlTransaction((tx) => fulfillImagePassPurchaseInTransaction(f, tx));
		expect(result.created).toBe(true);
		expect(await sqlTransaction((tx) => getImagePassBalance({ ownerId: f.ownerId }, tx))).toEqual({
			available: 3,
			reserved: 0,
			consumed: 0,
			revoked: 0,
		});
		const credits = await pool!.query(
			`SELECT count(*) FROM credit_account WHERE "ownerType"='USER' AND "ownerId"=$1`,
			[f.ownerId],
		);
		expect(credits.rows[0].count).toBe(0n);
	});
	it("keeps all new financial tables private even if an unrelated role receives DML grants", async () => {
		const tables = [
			"image_pass_grant",
			"image_pass_unit",
			"image_pass_reservation",
			"image_pass_ledger_entry",
			"image_pass_adjustment",
		];
		const protection = await pool!.query(
			`SELECT relname,relrowsecurity FROM pg_class WHERE relname=ANY($1::text[])`,
			[tables],
		);
		expect(protection.rows).toHaveLength(5);
		expect(protection.rows.every((row) => row.relrowsecurity)).toBe(true);
		const c = await pool!.connect();
		const role = `image_pass_rls_${crypto.randomUUID().replaceAll("-", "")}`;
		try {
			await c.query("BEGIN");
			await c.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
			await c.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
			await c.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${tables.join(",")} TO "${role}"`);
			await c.query(`SET LOCAL ROLE "${role}"`);
			for (const table of tables)
				expect((await c.query(`SELECT count(*) FROM ${table}`)).rows[0].count).toBe(0n);
			await expect(
				c.query(
					`INSERT INTO image_pass_unit (id,"grantId",ordinal) VALUES ('blocked','blocked',1)`,
				),
			).rejects.toThrow(/row-level security/);
		} finally {
			await c.query("ROLLBACK");
			c.release();
		}
	});
	it("never grants twice across duplicate captures", async () => {
		const f = await paymentFixture();
		const results = await Promise.all([
			sqlTransaction((tx) => fulfillImagePassPurchaseInTransaction(f, tx)),
			sqlTransaction((tx) =>
				fulfillImagePassPurchaseInTransaction({ ...f, paymentEventId: "duplicate-event" }, tx),
			),
		]);
		expect(results.filter((result) => result.created)).toHaveLength(1);
		expect(
			(await sqlTransaction((tx) => getImagePassBalance({ ownerId: f.ownerId }, tx))).available,
		).toBe(3);
	});
	it("allows the same owner to buy again as a separate verified capture", async () => {
		const first = await paymentFixture();
		const second = await paymentFixture(first.ownerId);
		await sqlTransaction((tx) => fulfillImagePassPurchaseInTransaction(first, tx));
		await sqlTransaction((tx) => fulfillImagePassPurchaseInTransaction(second, tx));
		expect(
			await sqlTransaction((tx) => getImagePassBalance({ ownerId: first.ownerId }, tx)),
		).toEqual({ available: 6, reserved: 0, consumed: 0, revoked: 0 });
	});
	it("preserves the paid ledger while allowing account and purchase deletion", async () => {
		const f = await paymentFixture();
		await sqlTransaction((tx) => fulfillImagePassPurchaseInTransaction(f, tx));
		await pool!.query(`DELETE FROM "user" WHERE id=$1`, [f.ownerId]);
		const grant = await pool!.query(
			`SELECT "purchaseId", "ownerId" FROM image_pass_grant WHERE "providerPaymentId"=$1`,
			[f.providerPaymentId],
		);
		expect(grant.rows).toEqual([{ purchaseId: null, ownerId: f.ownerId }]);
		const ledger = await pool!.query(
			`SELECT count(*) FROM image_pass_ledger_entry l JOIN image_pass_grant g ON g.id=l."grantId" WHERE g."providerPaymentId"=$1`,
			[f.providerPaymentId],
		);
		expect(ledger.rows[0].count).toBe(3n);
	});
	it.each([{ amountMicros: 999999n }, { currency: "EUR" }])(
		"rejects a capture whose paid amount or currency differs",
		async (change) => {
			const f = await paymentFixture();
			await expect(
				sqlTransaction((tx) => fulfillImagePassPurchaseInTransaction({ ...f, ...change }, tx)),
			).rejects.toThrow("IMAGE_PASS_PAYMENT_INVALID");
			expect(
				(await sqlTransaction((tx) => getImagePassBalance({ ownerId: f.ownerId }, tx))).available,
			).toBe(0);
		},
	);
	it("atomically admits only three of four concurrent jobs, without a credit reservation", async () => {
		const f = await paymentFixture();
		await sqlTransaction((tx) => fulfillImagePassPurchaseInTransaction(f, tx));
		const jobs = await Promise.all(Array.from({ length: 4 }, () => jobFixture(f.ownerId)));
		const results = await Promise.allSettled(
			jobs.map((jobId) =>
				sqlTransaction((tx) =>
					reserveImagePassForJobInTransaction({ ownerId: f.ownerId, jobId }, tx),
				),
			),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
		expect(
			(results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason
				.message,
		).toBe("IMAGE_PASS_INSUFFICIENT");
		expect(await sqlTransaction((tx) => getImagePassBalance({ ownerId: f.ownerId }, tx))).toEqual({
			available: 0,
			reserved: 3,
			consumed: 0,
			revoked: 0,
		});
		const credits = await pool!.query(
			`SELECT count(*) FROM credit_reservation WHERE "jobId"=ANY($1::text[])`,
			[jobs],
		);
		expect(credits.rows[0].count).toBe(0n);
	});
	it("returns the same reservation on job replay and releases a known failure once", async () => {
		const f = await paymentFixture();
		await sqlTransaction((tx) => fulfillImagePassPurchaseInTransaction(f, tx));
		const jobId = await jobFixture(f.ownerId);
		const first = await sqlTransaction((tx) =>
			reserveImagePassForJobInTransaction({ ownerId: f.ownerId, jobId }, tx),
		);
		expect(
			(
				await sqlTransaction((tx) =>
					reserveImagePassForJobInTransaction({ ownerId: f.ownerId, jobId }, tx),
				)
			).id,
		).toBe(first.id);
		await pool!.query(`UPDATE generation_job SET status='FINALIZING' WHERE id=$1`, [jobId]);
		expect(
			await sqlTransaction((tx) =>
				finalizeImagePassReservationInTransaction(
					{ ownerId: f.ownerId, jobId, hasUsableOutput: false },
					tx,
				),
			),
		).toEqual({ status: "RELEASED", replayed: false });
		expect(
			await sqlTransaction((tx) =>
				finalizeImagePassReservationInTransaction(
					{ ownerId: f.ownerId, jobId, hasUsableOutput: false },
					tx,
				),
			),
		).toEqual({ status: "RELEASED", replayed: true });
		expect(
			(await sqlTransaction((tx) => getImagePassBalance({ ownerId: f.ownerId }, tx))).available,
		).toBe(3);
	});
	it("holds an uncertain outcome and cannot spend another owner's unit", async () => {
		const f = await paymentFixture();
		await sqlTransaction((tx) => fulfillImagePassPurchaseInTransaction(f, tx));
		const jobId = await jobFixture(f.ownerId);
		await sqlTransaction((tx) =>
			reserveImagePassForJobInTransaction({ ownerId: f.ownerId, jobId }, tx),
		);
		await expect(
			sqlTransaction((tx) =>
				finalizeImagePassReservationInTransaction(
					{ ownerId: f.ownerId, jobId, hasUsableOutput: false },
					tx,
				),
			),
		).rejects.toThrow("IMAGE_PASS_OUTCOME_UNCERTAIN");
		await expect(
			sqlTransaction((tx) =>
				reserveImagePassForJobInTransaction({ ownerId: "foreign-owner", jobId }, tx),
			),
		).rejects.toThrow("IMAGE_PASS_OWNER_INVALID");
		expect(
			(await sqlTransaction((tx) => getImagePassBalance({ ownerId: f.ownerId }, tx))).reserved,
		).toBe(1);
	});
	it("revokes available refunded units and never releases the in-flight unit back to spendable", async () => {
		const f = await paymentFixture();
		await sqlTransaction((tx) => fulfillImagePassPurchaseInTransaction(f, tx));
		const jobId = await jobFixture(f.ownerId);
		await sqlTransaction((tx) =>
			reserveImagePassForJobInTransaction({ ownerId: f.ownerId, jobId }, tx),
		);
		const refund = {
			provider: "paypal" as const,
			providerPaymentId: f.providerPaymentId,
			providerAdjustmentId: "refund-" + crypto.randomUUID(),
			amountMicros: 1_000_000n,
			currency: "USD",
			occurredAt: new Date(),
			kind: "REFUND" as const,
		};
		expect(await sqlTransaction((tx) => revokeImagePassPurchaseInTransaction(refund, tx))).toEqual({
			replayed: false,
		});
		expect(await sqlTransaction((tx) => revokeImagePassPurchaseInTransaction(refund, tx))).toEqual({
			replayed: true,
		});
		expect(await sqlTransaction((tx) => getImagePassBalance({ ownerId: f.ownerId }, tx))).toEqual({
			available: 0,
			reserved: 1,
			consumed: 0,
			revoked: 2,
		});
		await pool!.query(`UPDATE generation_job SET status='FINALIZING' WHERE id=$1`, [jobId]);
		await sqlTransaction((tx) =>
			finalizeImagePassReservationInTransaction(
				{ ownerId: f.ownerId, jobId, hasUsableOutput: false },
				tx,
			),
		);
		expect(await sqlTransaction((tx) => getImagePassBalance({ ownerId: f.ownerId }, tx))).toEqual({
			available: 0,
			reserved: 0,
			consumed: 0,
			revoked: 3,
		});
	});
	it("consumes exactly one real READY owned output once, leaving ordinary credit tables untouched", async () => {
		const f = await paymentFixture();
		await sqlTransaction((tx) => fulfillImagePassPurchaseInTransaction(f, tx));
		const jobId = await jobFixture(f.ownerId);
		await sqlTransaction((tx) =>
			reserveImagePassForJobInTransaction({ ownerId: f.ownerId, jobId }, tx),
		);
		await readyOutput(jobId, f.ownerId);
		await pool!.query(`UPDATE generation_job SET status='FINALIZING' WHERE id=$1`, [jobId]);
		expect(
			await sqlTransaction((tx) =>
				finalizeImagePassReservationInTransaction(
					{ ownerId: f.ownerId, jobId, hasUsableOutput: true },
					tx,
				),
			),
		).toEqual({ status: "SETTLED", replayed: false });
		expect(
			await sqlTransaction((tx) =>
				finalizeImagePassReservationInTransaction(
					{ ownerId: f.ownerId, jobId, hasUsableOutput: true },
					tx,
				),
			),
		).toEqual({ status: "SETTLED", replayed: true });
		expect(await sqlTransaction((tx) => getImagePassBalance({ ownerId: f.ownerId }, tx))).toEqual({
			available: 2,
			reserved: 0,
			consumed: 1,
			revoked: 0,
		});
		const ledger = await pool!.query(
			`SELECT count(*) FROM image_pass_ledger_entry WHERE "jobId"=$1 AND operation='CONSUME'`,
			[jobId],
		);
		expect(ledger.rows[0].count).toBe(1n);
		const credit = await pool!.query(`SELECT count(*) FROM credit_reservation WHERE "jobId"=$1`, [
			jobId,
		]);
		expect(credit.rows[0].count).toBe(0n);
	});
	it("consumes the held unit on a real late success after a refund freezes the grant", async () => {
		const f = await paymentFixture();
		await sqlTransaction((tx) => fulfillImagePassPurchaseInTransaction(f, tx));
		const jobId = await jobFixture(f.ownerId);
		await sqlTransaction((tx) =>
			reserveImagePassForJobInTransaction({ ownerId: f.ownerId, jobId }, tx),
		);
		await sqlTransaction((tx) =>
			revokeImagePassPurchaseInTransaction(
				{
					provider: "paypal",
					providerPaymentId: f.providerPaymentId,
					providerAdjustmentId: "dispute-" + crypto.randomUUID(),
					amountMicros: 1_000_000n,
					currency: "USD",
					occurredAt: new Date(),
					kind: "DISPUTE",
				},
				tx,
			),
		);
		await readyOutput(jobId, f.ownerId);
		await pool!.query(`UPDATE generation_job SET status='FINALIZING' WHERE id=$1`, [jobId]);
		await sqlTransaction((tx) =>
			finalizeImagePassReservationInTransaction(
				{ ownerId: f.ownerId, jobId, hasUsableOutput: true },
				tx,
			),
		);
		expect(await sqlTransaction((tx) => getImagePassBalance({ ownerId: f.ownerId }, tx))).toEqual({
			available: 0,
			reserved: 0,
			consumed: 1,
			revoked: 2,
		});
	});
	it("cannot consume a foreign owner's READY output or a multi-image result", async () => {
		const f = await paymentFixture();
		await sqlTransaction((tx) => fulfillImagePassPurchaseInTransaction(f, tx));
		const jobId = await jobFixture(f.ownerId);
		await sqlTransaction((tx) =>
			reserveImagePassForJobInTransaction({ ownerId: f.ownerId, jobId }, tx),
		);
		await readyOutput(jobId, "foreign-owner");
		await pool!.query(`UPDATE generation_job SET status='FINALIZING' WHERE id=$1`, [jobId]);
		await expect(
			sqlTransaction((tx) =>
				finalizeImagePassReservationInTransaction(
					{ ownerId: f.ownerId, jobId, hasUsableOutput: true },
					tx,
				),
			),
		).rejects.toThrow("IMAGE_PASS_OUTPUT_NOT_USABLE");
		await expect(
			sqlTransaction((tx) =>
				finalizeImagePassReservationInTransaction(
					{ ownerId: f.ownerId, jobId, hasUsableOutput: false },
					tx,
				),
			),
		).rejects.toThrow("IMAGE_PASS_OUTCOME_UNCERTAIN");
		await readyOutput(jobId, f.ownerId);
		await expect(
			sqlTransaction((tx) =>
				finalizeImagePassReservationInTransaction(
					{ ownerId: f.ownerId, jobId, hasUsableOutput: true },
					tx,
				),
			),
		).rejects.toThrow("IMAGE_PASS_OUTPUT_COUNT_INVALID");
		expect(
			(await sqlTransaction((tx) => getImagePassBalance({ ownerId: f.ownerId }, tx))).reserved,
		).toBe(1);
	});
	it("rejects expired approval and prevents mutation of the immutable pass ledger", async () => {
		const f = await paymentFixture();
		await sqlTransaction((tx) => fulfillImagePassPurchaseInTransaction(f, tx));
		const jobId = await jobFixture(f.ownerId);
		await sqlTransaction((tx) =>
			reserveImagePassForJobInTransaction({ ownerId: f.ownerId, jobId }, tx),
		);
		await readyOutput(jobId, f.ownerId, new Date(Date.now() + 300));
		await pool!.query(`UPDATE generation_job SET status='FINALIZING' WHERE id=$1`, [jobId]);
		await new Promise((resolve) => setTimeout(resolve, 350));
		await expect(
			sqlTransaction((tx) =>
				finalizeImagePassReservationInTransaction(
					{ ownerId: f.ownerId, jobId, hasUsableOutput: true },
					tx,
				),
			),
		).rejects.toThrow("IMAGE_PASS_OUTPUT_NOT_USABLE");
		await expect(
			sqlTransaction((tx) =>
				finalizeImagePassReservationInTransaction(
					{ ownerId: f.ownerId, jobId, hasUsableOutput: false },
					tx,
				),
			),
		).rejects.toThrow("IMAGE_PASS_OUTCOME_UNCERTAIN");
		await expect(
			pool!.query(`UPDATE image_pass_ledger_entry SET operation='RELEASE' WHERE "jobId"=$1`, [
				jobId,
			]),
		).rejects.toThrow("IMAGE_PASS_LEDGER_IMMUTABLE");
	});
	it.each([
		{ paid: false, usage: 0n, admitted: true },
		{ paid: false, usage: 3n * 1024n * 1024n * 1024n, admitted: false },
		{ paid: true, usage: 3n * 1024n * 1024n * 1024n, admitted: true },
	])(
		"retains current storage policy for a 4K pass: paid=$paid admitted=$admitted",
		async ({ paid, usage, admitted }) => {
			const f = await paymentFixture();
			await sqlTransaction((tx) => fulfillImagePassPurchaseInTransaction(f, tx));
			if (paid) {
				const planId = "paid-plan-" + crypto.randomUUID();
				const subscriptionId = "paid-sub-" + crypto.randomUUID();
				await pool!.query(
					`INSERT INTO billing_plan (id,provider,"providerPriceId","productKind",name,"creditsPerPeriod","priceMicros",currency,metadata,"updatedAt") VALUES ($1,'paypal',$1,'PLAN','creator',1,1000000,'USD','{}',now())`,
					[planId],
				);
				await pool!.query(
					`INSERT INTO subscription (id,"ownerType","ownerId",provider,"providerSubscriptionId","planId",status,"currentPeriodStart","currentPeriodEnd","updatedAt") VALUES ($1,'USER',$2,'paypal',$1,$3,'ACTIVE',now()-interval '1 day',now()+interval '1 day',now())`,
					[subscriptionId, f.ownerId, planId],
				);
				await pool!.query(
					`INSERT INTO billing_period (id,"subscriptionId","startsAt","endsAt",status,"creditAmount","paidAmount","updatedAt") VALUES ($1,$2,now()-interval '1 day',now()+interval '1 day','ACTIVE',0,1000000,now())`,
					["period-" + crypto.randomUUID(), subscriptionId],
				);
			}
			if (usage)
				await pool!.query(
					`INSERT INTO storage_usage_reservation (id,"ownerType","ownerId",bytes,status,"referenceKey","expiresAt") VALUES ($1,'USER',$2,$3,'COMMITTED',$1,now()+interval '1 day')`,
					["storage-" + crypto.randomUUID(), f.ownerId, usage],
				);
			const pricingSnapshot = {
				fundingSource: "IMAGE_PASS",
				skuKey: "nano-banana-pro-4k",
				credits: 25,
				settlementPolicy: { unitCredits: "25", requestedOutputCount: 1, maxCharge: "25" },
			};
			const quote = {
				id: "admission-" + crypto.randomUUID(),
				ownerType: "USER" as const,
				ownerId: f.ownerId,
				submittedByUserId: f.ownerId,
				productKey: "image-nano-banana-pro",
				catalogVersion: "2026-09-14.1",
				pricingVersion: "2026-09-13.2",
				credits: 25n,
				costMicros: 120000n,
				inputSnapshot: {
					kind: "text-to-image",
					prompt: "A vase",
					skuKey: "nano-banana-pro-4k",
					aspectRatio: "1:1",
				},
				pricingSnapshot,
				expiresAt: new Date(Date.now() + 60_000),
			};
			await pool!.query(
				`INSERT INTO generation_quote (id,"ownerType","ownerId","submittedByUserId","productKey","catalogVersion","pricingVersion",credits,"costMicros","inputSnapshot","pricingSnapshot","expiresAt","moderationDecision","moderationProvider","moderationRuleVersion","moderationReasonCode","inputFingerprint") VALUES ($1,'USER',$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ALLOW','waffo','test-rule','NO_POLICY_MATCH',$11)`,
				[
					quote.id,
					quote.ownerId,
					quote.productKey,
					quote.catalogVersion,
					quote.pricingVersion,
					quote.credits,
					quote.costMicros,
					JSON.stringify(quote.inputSnapshot),
					JSON.stringify(quote.pricingSnapshot),
					quote.expiresAt,
					fingerprintGenerationQuoteSecurityPayload(quote),
				],
			);
			const isolation: string[] = [];
			const result = createGenerationJobTransaction(
				{
					ownerType: "USER",
					ownerId: f.ownerId,
					submittedByUserId: f.ownerId,
					quoteId: quote.id,
					idempotencyKey: "request-" + crypto.randomUUID(),
					inputAssetIds: [],
					expectedModerationRuleVersion: "test-rule",
					expectedModerationProvider: "waffo",
					maximumStorageBytes: 2n * 1024n * 1024n * 1024n,
					validateCurrentEligibility: true,
				},
				{
					$transaction: (
						operation: (tx: unknown) => Promise<unknown>,
						options?: { isolationLevel?: string },
					) =>
						sqlTransaction(async (tx) => {
							const [state] =
								await tx.$queryRaw`SELECT current_setting('transaction_isolation') AS level`;
							isolation.push(state.level);
							return operation(tx);
						}, options),
				} as never,
			);
			if (!admitted) {
				await expect(result).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
				expect(
					await sqlTransaction((tx) => getImagePassBalance({ ownerId: f.ownerId }, tx)),
				).toEqual({ available: 3, reserved: 0, consumed: 0, revoked: 0 });
				return;
			}
			const created = await result;
			expect(created.job.creditsReserved).toBe(0n);
			expect(isolation).toEqual(["read committed", "serializable"]);
			const stored = (
				await pool!.query(`SELECT "pricingSnapshot" FROM generation_job WHERE id=$1`, [
					created.job.id,
				])
			).rows[0];
			expect(stored.pricingSnapshot).toEqual({
				...pricingSnapshot,
				aggregateStoragePolicy: {
					schemaVersion: 1,
					maximumBytes: paid ? null : (2n * 1024n * 1024n * 1024n).toString(),
				},
			});
			expect(
				(
					await pool!.query(`SELECT "pricingSnapshot" FROM generation_quote WHERE id=$1`, [
						quote.id,
					])
				).rows[0].pricingSnapshot,
			).toEqual(pricingSnapshot);
			expect(
				(
					await pool!.query(
						`SELECT count(*)::int AS n FROM credit_account WHERE "ownerType"='USER' AND "ownerId"=$1`,
						[f.ownerId],
					)
				).rows[0].n,
			).toBe(0);
			expect(await sqlTransaction((tx) => getImagePassBalance({ ownerId: f.ownerId }, tx))).toEqual(
				{
					available: 2,
					reserved: 1,
					consumed: 0,
					revoked: 0,
				},
			);
		},
	);
});
