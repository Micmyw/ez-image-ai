import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { createCreditGrant } from "./credits";
import { createGenerationJobTransaction } from "./jobs";
import {
	createModeratedGenerationQuoteTransaction,
	fingerprintGenerationQuoteSecurityPayload,
} from "./quotes";

let client: PrismaClient;
let overrideVersion = Math.floor(Date.now() / 1000);
const prefix = `batch1-admission-${crypto.randomUUID()}`;

function isolatedUrl() {
	const value = process.env.TEST_DATABASE_URL;
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	if (
		!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) ||
		!/(^|[_-])test([_-]|$)/.test(parsed.pathname.slice(1)) ||
		value === process.env.DATABASE_URL
	)
		throw new Error("ISOLATED_LOCAL_TEST_DATABASE_REQUIRED");
	return value;
}

async function fixture(
	options: { productKey?: string; amount?: bigint; assetBytes?: bigint } = {},
) {
	const ownerId = `${prefix}-${crypto.randomUUID()}`;
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	await createCreditGrant(
		{ accountId: account.id, amount: options.amount ?? 100n, referenceKey: `${ownerId}:grant` },
		client,
	);
	const validUntil = new Date(Date.now() + 60_000);
	const asset =
		options.assetBytes === undefined
			? undefined
			: await client.mediaAsset.create({
					data: {
						ownerType: "USER",
						ownerId,
						kind: "INPUT",
						status: "VERIFYING",
						objectKey: `${ownerId}/input.png`,
						mimeType: "image/png",
						byteSize: options.assetBytes,
						checksum: "a".repeat(64),
						verificationGeneration: 1,
						verificationAttemptCount: 1,
						verificationProvider: "test",
						verificationRuleVersion: "test-asset-rule",
						verificationPolicyVersion: "test-asset-policy",
						verificationValidUntil: validUntil,
					},
				});
	if (asset) {
		await client.assetModerationResult.create({
			data: {
				assetId: asset.id,
				assetChecksum: asset.checksum!,
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "INPUT",
				provider: "test",
				ruleVersion: "test-asset-rule",
				policyVersion: "test-asset-policy",
				status: "APPROVED",
				reasonCode: "TEST_ALLOW",
				categories: {},
				rawEnvelope: { decision: "ALLOW" },
				validUntil,
			},
		});
		await client.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } });
	}
	async function makeInput() {
		const quoteInput = {
			ownerType: "USER" as const,
			ownerId,
			submittedByUserId: ownerId,
			productKey: options.productKey ?? "image-nano-banana-2-lite",
			catalogVersion: "test",
			pricingVersion: "test",
			credits: 5n,
			costMicros: 100n,
			inputSnapshot: asset
				? { kind: "image-to-image", sourceAssetId: asset.id, prompt: "fixed simulated prompt" }
				: { kind: "text-to-image", prompt: "fixed simulated prompt" },
			pricingSnapshot: {},
			expiresAt: new Date(Date.now() + 60_000),
		};
		const quote = await createModeratedGenerationQuoteTransaction(
			{
				...quoteInput,
				moderation: {
					decision: "ALLOW",
					provider: "waffo",
					ruleVersion: "test-rule",
					reasonCode: "NO_POLICY_MATCH",
					inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteInput),
				},
			},
			client,
		);
		return {
			ownerType: "USER" as const,
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: `${ownerId}:${quote.id}`,
			inputAssetIds: asset ? [asset.id] : [],
			expectedModerationRuleVersion: "test-rule",
			expectedModerationProvider: "waffo",
			maximumConcurrentJobs: 99,
			maximumDailyCostMicros: 1000n,
			maximumStorageBytes: 10_000_000_000n,
			validateCurrentEligibility: true,
		};
	}
	return { ownerId, account, makeInput, input: await makeInput() };
}

async function disable(configKey: string) {
	return client.runtimeConfigOverride.create({
		data: {
			configKey,
			value: false,
			version: ++overrideVersion,
			reason: prefix,
			createdByUserId: prefix,
		},
	});
}

describe("combined generation final atomic qualification", () => {
	beforeAll(() => {
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString: isolatedUrl() }) });
	});
	afterAll(async () => {
		if (!client) return;
		await client.runtimeConfigOverride.deleteMany({ where: { reason: prefix } });
		await client.$disconnect();
	});

	it.each(["media.generation.enabled", "media.model.image-nano-banana-2-lite.enabled"])(
		"rejects %s changed after the approved quote, without job/reservation/outbox",
		async (key) => {
			const f = await fixture();
			const flag = await disable(key);
			try {
				await expect(createGenerationJobTransaction(f.input, client)).rejects.toThrow(
					"MODEL_DISABLED",
				);
				expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
				expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(
					0,
				);
			} finally {
				await client.runtimeConfigOverride.delete({ where: { id: flag.id } });
			}
		},
	);
	it("rejects a paid plan that ended after the approved quote", async () => {
		const f = await fixture({ productKey: "image-nano-banana-2" });
		const start = new Date(Date.now() - 60_000),
			end = new Date(Date.now() + 60_000);
		const plan = await client.billingPlan.create({
			data: {
				provider: prefix,
				providerPriceId: f.ownerId,
				name: "creator",
				creditsPerPeriod: 100n,
				priceMicros: 100n,
				currency: "USD",
				metadata: { planId: "creator" },
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId: f.ownerId,
				provider: prefix,
				providerSubscriptionId: f.ownerId,
				planId: plan.id,
				status: "ACTIVE",
				currentPeriodStart: start,
				currentPeriodEnd: end,
				periods: {
					create: {
						startsAt: start,
						endsAt: end,
						paidAmount: 100n,
						creditAmount: 100n,
						status: "PENDING",
					},
				},
			},
		});
		await client.subscription.update({
			where: { id: subscription.id },
			data: { refundTerminationRequestedAt: new Date() },
		});
		await expect(createGenerationJobTransaction(f.input, client)).rejects.toThrow(
			"ENTITLEMENT_REQUIRED",
		);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
	});
	it("uses the current free concurrency limit and keeps the winning replay", async () => {
		const f = await fixture();
		const inputs = [f.input, await f.makeInput()];
		const results = await Promise.allSettled(
			inputs.map((input) => createGenerationJobTransaction(input, client)),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected).toMatchObject({ reason: { message: "CONCURRENT_JOB_LIMIT_REACHED" } });
		const winner = results.findIndex((result) => result.status === "fulfilled");
		const flag = await disable("media.generation.enabled");
		try {
			await expect(createGenerationJobTransaction(inputs[winner]!, client)).resolves.toMatchObject({
				replayed: true,
			});
		} finally {
			await client.runtimeConfigOverride.delete({ where: { id: flag.id } });
		}
		expect(
			await client.creditLedgerEntry.count({ where: { accountId: f.account.id, type: "RESERVE" } }),
		).toBe(1);
	});
	it.each([
		["balance", 4n, "INSUFFICIENT_CREDITS"],
		["debt", 100n, "CREDIT_DEBT_OUTSTANDING"],
	] as const)(
		"rechecks %s after approval and rolls the job back",
		async (kind, amount, message) => {
			const f = await fixture({ amount });
			if (kind === "debt")
				await client.creditAccount.update({
					where: { id: f.account.id },
					data: { creditDebt: 10n },
				});
			await expect(createGenerationJobTransaction(f.input, client)).rejects.toThrow(message);
			expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
			expect(
				await client.creditLedgerEntry.count({
					where: { accountId: f.account.id, type: "RESERVE" },
				}),
			).toBe(0);
		},
	);
	it("rechecks input bytes against the current plan before reservation", async () => {
		const f = await fixture({ assetBytes: 20_000_000n });
		await expect(createGenerationJobTransaction(f.input, client)).rejects.toThrow(
			"INPUT_TOO_LARGE",
		);
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
	});
});
