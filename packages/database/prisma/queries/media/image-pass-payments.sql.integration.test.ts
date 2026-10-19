import { getImagePassOfferSnapshot } from "@repo/config/image-pass";
import { IMAGE_PASS_PAYPAL_SKU } from "@repo/config/image-pass.server";
import { Pool, types } from "pg";
import { describe, it, expect, afterAll, vi } from "vitest";
// The barrel's default Prisma runtime is not loaded. Every entitlement helper
// below is the real implementation and executes its SQL against local Postgres.
vi.mock("@repo/database", async () => ({
	...(await import("./image-passes")),
	PAYMENT_PROVIDER_CORRELATION_MISSING: "PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISSING",
}));
import {
	applyImagePassPaymentFact,
	tryApplyImagePassAdjustment,
	requeueImagePassAdjustments,
	lockImagePassPayment,
} from "../../../../payments/provider/image-pass-reducer";
import { normalizeProviderPaymentEvent } from "../../../../payments/provider/lifecycle-normalization";
import { getImagePassBalance } from "./image-passes";
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
async function transaction<T>(operation: (tx: never) => Promise<T>) {
	if (!pool) throw new Error("ISOLATED_IMAGE_PASS_DATABASE_REQUIRED");
	const c = await pool.connect();
	const query = (parts: TemplateStringsArray, ...values: unknown[]) =>
		c.query(
			parts.reduce((text, part, i) => text + (i ? `$${i}` : "") + part, ""),
			values,
		);
	const tx = {
		$queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
			(await query(parts, ...values)).rows,
		$executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
			(await query(parts, ...values)).rowCount,
		paymentEvent: {
			updateMany: async ({
				where,
				data,
			}: {
				where: { id: string };
				data: Record<string, unknown>;
			}) => {
				const allowed = [
					"status",
					"attemptCount",
					"processedAt",
					"processingToken",
					"processingLeasedUntil",
				];
				const keys = Object.keys(data);
				if (keys.some((key) => !allowed.includes(key)))
					throw new Error("UNEXPECTED_TEST_TRANSPORT_COLUMN");
				const result = await c.query(
					`UPDATE payment_event SET ${keys.map((key, i) => `"${key}"=$${i + 1}`).join(",")} WHERE id=$${keys.length + 1} AND status IN ('FAILED','DEAD_LETTER') AND "lastErrorClass"='TRANSIENT' AND "failureReason"='PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISSING'`,
					[...keys.map((key) => data[key]), where.id],
				);
				return { count: result.rowCount };
			},
		},
		outboxEvent: {
			upsert: async ({
				create,
			}: {
				create: {
					eventType: string;
					aggregateType: string;
					aggregateId: string;
					dedupeKey: string;
					payload: unknown;
				};
			}) =>
				c.query(
					`INSERT INTO outbox_event (id,"eventType","aggregateType","aggregateId","dedupeKey",payload) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT ("dedupeKey") DO NOTHING`,
					[
						crypto.randomUUID(),
						create.eventType,
						create.aggregateType,
						create.aggregateId,
						create.dedupeKey,
						JSON.stringify(create.payload),
					],
				),
		},
	};
	await c.query("BEGIN");
	try {
		const result = await operation(tx as never);
		await c.query("COMMIT");
		return result;
	} catch (error) {
		await c.query("ROLLBACK");
		throw error;
	} finally {
		c.release();
	}
}
async function paymentFixture() {
	const suffix = crypto.randomUUID();
	const ownerId = `image-pass-owner-${suffix}`;
	let billingPlanId = `image-pass-plan-${suffix}`;
	const checkoutIntentId = `image-pass-checkout-${suffix}`;
	const providerOrderId = `order-${suffix}`;
	const providerPaymentId = `capture-${suffix}`;
	const snapshot = getImagePassOfferSnapshot();
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

function paymentFact(f: Awaited<ReturnType<typeof paymentFixture>>) {
	return { ...f, providerEventId: `paid-${f.providerPaymentId}`, providerCustomerId: null };
}
function dispute(f: Awaited<ReturnType<typeof paymentFixture>>) {
	return {
		id: `WH-D-${crypto.randomUUID()}`,
		event_type: "CUSTOMER.DISPUTE.CREATED",
		create_time: new Date().toISOString(),
		resource: {
			dispute_id: `D-${crypto.randomUUID()}`,
			disputed_transactions: [{ seller_transaction_id: f.providerPaymentId }],
			dispute_amount: { value: "0.50", currency_code: "USD" },
		},
	};
}
async function persistFailed(envelope: unknown) {
	const id = crypto.randomUUID();
	await pool!.query(
		`INSERT INTO payment_event (id,provider,"providerEventId","verifiedAt",envelope,status,"lastErrorClass","failureReason","attemptCount") VALUES ($1,'paypal',$1,NOW(),$2,'DEAD_LETTER','TRANSIENT','PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISSING',1)`,
		[id, JSON.stringify(envelope)],
	);
	return id;
}
describe.skipIf(!enabled)("image-pass payment reducer real SQL", () => {
	afterAll(async () => {
		await pool?.end();
	});
	it("concurrent verified capture/webhook delivery grants three units exactly once", async () => {
		const f = await paymentFixture();
		const results = await Promise.all([
			transaction((tx) => applyImagePassPaymentFact(paymentFact(f), tx)),
			transaction((tx) =>
				applyImagePassPaymentFact({ ...paymentFact(f), providerEventId: "webhook-duplicate" }, tx),
			),
		]);
		expect(results.reduce((sum, result) => sum + result.grantsCreated, 0)).toBe(1);
		expect(await transaction((tx) => getImagePassBalance({ ownerId: f.ownerId }, tx))).toEqual({
			available: 3,
			reserved: 0,
			consumed: 0,
			revoked: 0,
		});
	});
	it("requeues only the exact capture's early failed dispute, idempotently", async () => {
		const f = await paymentFixture();
		const related = await persistFailed(dispute(f));
		const unrelated = await persistFailed(dispute({ ...f, providerPaymentId: "other-capture" }));
		await transaction((tx) => applyImagePassPaymentFact(paymentFact(f), tx));
		await transaction(async (tx) => {
			await lockImagePassPayment(f.providerPaymentId, tx);
			await requeueImagePassAdjustments(f.providerPaymentId, tx);
		});
		const rows = await pool!.query(
			`SELECT "aggregateId" FROM outbox_event WHERE "aggregateId"=ANY($1::text[])`,
			[[related, unrelated]],
		);
		expect(rows.rows).toEqual([{ aggregateId: related }]);
		const event = await pool!.query(`SELECT status,"attemptCount" FROM payment_event WHERE id=$1`, [
			related,
		]);
		expect(event.rows[0]).toEqual({ status: "FAILED", attemptCount: 0 });
	});
	it("requeues a failure persisted after fulfillment so that it cannot be stranded", async () => {
		const f = await paymentFixture();
		await transaction((tx) => applyImagePassPaymentFact(paymentFact(f), tx));
		const late = await persistFailed(dispute(f));
		await transaction(async (tx) => {
			await lockImagePassPayment(f.providerPaymentId, tx);
			await requeueImagePassAdjustments(f.providerPaymentId, tx);
		});
		const rows = await pool!.query(`SELECT count(*) FROM outbox_event WHERE "aggregateId"=$1`, [
			late,
		]);
		expect(rows.rows[0].count).toBe(1n);
	});
	it("verified dispute freezes the real grant and leaves ordinary credit accounts untouched", async () => {
		const f = await paymentFixture();
		await transaction((tx) => applyImagePassPaymentFact(paymentFact(f), tx));
		const normalized = normalizeProviderPaymentEvent("paypal", dispute(f));
		if (normalized.kind !== "PAYMENT_DISPUTED") throw new Error("UNEXPECTED_FACT");
		await transaction((tx) => tryApplyImagePassAdjustment(normalized.fact, tx, "DISPUTE"));
		expect(await transaction((tx) => getImagePassBalance({ ownerId: f.ownerId }, tx))).toEqual({
			available: 0,
			reserved: 0,
			consumed: 0,
			revoked: 3,
		});
		const credits = await pool!.query(`SELECT count(*) FROM credit_account WHERE "ownerId"=$1`, [
			f.ownerId,
		]);
		expect(credits.rows[0].count).toBe(0n);
	});
});
