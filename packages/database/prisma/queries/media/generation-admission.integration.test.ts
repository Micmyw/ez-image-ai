import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildMediaQuote } from "../../../../api/modules/media/lib/quote";
import { PrismaClient } from "../../generated/client";
import {
	createCreditGrant,
	getCreditInvariantReport,
	refundCreditGrant,
	releaseCredits,
} from "./credits";
import { createGenerationJobTransaction, transitionGenerationJob } from "./jobs";
import {
	createModeratedGenerationQuoteTransaction,
	fingerprintGenerationQuoteSecurityPayload,
} from "./quotes";

let client: PrismaClient;
let overrideVersion = Math.floor(Date.now() / 1000);
const prefix = `batch1-admission-${crypto.randomUUID()}`;
const sunburstSelection = {
	productKey: "image-gpt-image-2-5-sunburst",
	input: {
		kind: "text-to-image",
		prompt: "A sunlit mountain landscape",
		skuKey: "gpt-image-2-5-sunburst-1k",
		aspectRatio: "1:1",
	},
} as const;

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
	options: {
		productKey?: string;
		amount?: bigint;
		assetBytes?: bigint;
		catalogSelection?: Parameters<typeof buildMediaQuote>[0];
		grantExpiresAt?: Date;
	} = {},
) {
	const catalogQuote = options.catalogSelection
		? buildMediaQuote(options.catalogSelection, {
				enabledProviders: new Set(["kie"]),
				generationEnabled: true,
			})
		: undefined;
	const ownerId = `${prefix}-${crypto.randomUUID()}`;
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	await createCreditGrant(
		{
			accountId: account.id,
			amount: options.amount ?? 100n,
			referenceKey: `${ownerId}:grant`,
			expiresAt: options.grantExpiresAt,
		},
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
			productKey: catalogQuote?.productKey ?? options.productKey ?? "image-nano-banana-2-lite",
			catalogVersion: catalogQuote?.catalogVersion ?? "test",
			pricingVersion: catalogQuote?.pricingVersion ?? "test",
			credits: catalogQuote?.credits ?? 5n,
			costMicros: catalogQuote?.costMicros ?? 100n,
			inputSnapshot:
				options.catalogSelection?.input ??
				(asset
					? { kind: "image-to-image", sourceAssetId: asset.id, prompt: "fixed simulated prompt" }
					: { kind: "text-to-image", prompt: "fixed simulated prompt" }),
			pricingSnapshot: catalogQuote?.pricingSnapshot ?? {},
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
			maximumDailyCostMicros: catalogQuote ? catalogQuote.costMicros * 3n : 1000n,
			maximumStorageBytes: 10_000_000_000n,
			validateCurrentEligibility: true,
		};
	}
	return { ownerId, account, catalogQuote, makeInput, input: await makeInput() };
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

async function subscribeOwner(ownerId: string) {
	const start = new Date(Date.now() - 60_000),
		end = new Date(Date.now() + 60_000);
	const plan = await client.billingPlan.create({
		data: {
			provider: prefix,
			providerPriceId: ownerId,
			name: "creator",
			creditsPerPeriod: 100n,
			priceMicros: 100n,
			currency: "USD",
			metadata: { planId: "creator" },
		},
	});
	return client.subscription.create({
		data: {
			ownerType: "USER",
			ownerId,
			provider: prefix,
			providerSubscriptionId: ownerId,
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
	it("rejects an unused premium quote after its subscription ended despite valid credits", async () => {
		const f = await fixture({ catalogSelection: sunburstSelection });
		const subscription = await subscribeOwner(f.ownerId);
		await client.subscription.update({
			where: { id: subscription.id },
			data: { refundTerminationRequestedAt: new Date() },
		});
		await expect(createGenerationJobTransaction(f.input, client)).rejects.toThrow(
			"ENTITLEMENT_REQUIRED",
		);
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({
			valid: true,
			account: { spendable: 100n, reserved: 0n, debt: 0n },
		});
	});
	it.each(["ACTIVE", "CANCELED", "PAST_DUE"] as const)(
		"admits premium 4K with a paid %s subscription and valid grant credits",
		async (status) => {
			const f = await fixture({
				amount: 377n,
				catalogSelection: {
					...sunburstSelection,
					input: { ...sunburstSelection.input, skuKey: "gpt-image-2-5-sunburst-4k" },
				},
			});
			const subscription = await subscribeOwner(f.ownerId);
			await client.subscription.update({
				where: { id: subscription.id },
				data: {
					status,
					...(status === "PAST_DUE"
						? {
								currentPeriodEnd: new Date(Date.now() - 1_000),
								graceEndsAt: new Date(Date.now() + 60_000),
							}
						: {}),
				},
			});
			await expect(createGenerationJobTransaction(f.input, client)).resolves.toMatchObject({
				replayed: false,
				job: { creditsReserved: 17n },
				reservation: { amount: 17n, status: "ACTIVE" },
			});
			expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({
				valid: true,
				account: { spendable: 360n, reserved: 17n, debt: 0n },
			});
		},
	);
	it("rejects a premium image from a non-subscriber grant without reserving credits", async () => {
		const f = await fixture({ amount: 377n, catalogSelection: sunburstSelection });
		expect(
			await client.subscription.count({ where: { ownerType: "USER", ownerId: f.ownerId } }),
		).toBe(0);
		await expect(createGenerationJobTransaction(f.input, client)).rejects.toThrow(
			"ENTITLEMENT_REQUIRED",
		);
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({
			valid: true,
			account: { spendable: 377n, reserved: 0n, debt: 0n },
		});
	});
	it("keeps accepted premium work and its ledger replay stable after subscription expiry", async () => {
		const f = await fixture({ amount: 377n, catalogSelection: sunburstSelection });
		const subscription = await subscribeOwner(f.ownerId);
		expect(f.catalogQuote).toMatchObject({ credits: 7n, costMicros: 30_000n });
		const created = await createGenerationJobTransaction(f.input, client);
		expect(created).toMatchObject({
			replayed: false,
			job: { status: "RESERVED", creditsReserved: 7n },
			reservation: { amount: 7n, status: "ACTIVE" },
		});
		await client.subscription.update({
			where: { id: subscription.id },
			data: { refundTerminationRequestedAt: new Date() },
		});
		await expect(createGenerationJobTransaction(f.input, client)).resolves.toMatchObject({
			replayed: true,
			job: { id: created.job.id },
			reservation: { id: created.reservation.id },
		});
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({
			valid: true,
			account: { spendable: 370n, reserved: 7n, debt: 0n },
		});

		// Exercise a definite failure before provider submission using the real job and ledger APIs.
		await expect(
			transitionGenerationJob(
				{
					jobId: created.job.id,
					expectedStatuses: ["RESERVED"],
					expectedVersion: created.job.version,
					nextStatus: "FAILED",
					failureCode: "TEST_BEFORE_PROVIDER_FAILURE",
				},
				client,
			),
		).resolves.toMatchObject({ applied: true, job: { status: "FAILED" } });
		const release = {
			reservationId: created.reservation.id,
			referenceKey: `job:${created.job.id}:test-failure-release`,
		};
		const released = await releaseCredits(release, client);
		expect(released).toMatchObject({ status: "RELEASED", releasedAmount: 7n });
		await expect(releaseCredits(release, client)).resolves.toEqual(released);
		await expect(createGenerationJobTransaction(f.input, client)).resolves.toMatchObject({
			replayed: true,
			job: { id: created.job.id, status: "FAILED" },
			reservation: { id: created.reservation.id, status: "RELEASED" },
		});
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({
			valid: true,
			account: { spendable: 377n, reserved: 0n, debt: 0n },
			ledger: { reserved: 7n, released: 7n, settled: 0n },
		});
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(1);
		expect(await client.generationAttempt.count({ where: { jobId: created.job.id } })).toBe(0);
		for (const type of ["RESERVE", "RELEASE"] as const)
			expect(
				await client.creditLedgerEntry.count({ where: { accountId: f.account.id, type } }),
			).toBe(1);
	});
	it.each(["expired", "refunded"] as const)(
		"rejects %s shared credits for a non-subscriber without creating image work",
		async (funding) => {
			const f = await fixture({
				amount: 377n,
				...(funding === "expired" ? { grantExpiresAt: new Date(Date.now() - 60_000) } : {}),
			});
			if (funding === "refunded")
				await refundCreditGrant(
					{
						accountId: f.account.id,
						grantReferenceKey: `${f.ownerId}:grant`,
						amount: 377n,
						referenceKey: `${f.ownerId}:refund`,
					},
					client,
				);
			await expect(createGenerationJobTransaction(f.input, client)).rejects.toThrow(
				"INSUFFICIENT_CREDITS",
			);
			expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
			expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
		},
	);
	it("admits multiple funded requests for one account and keeps each replay stable", async () => {
		const f = await fixture();
		const inputs = [f.input, await f.makeInput()].map((input) => ({
			...input,
			maximumConcurrentJobs: 1,
		}));
		const results = await Promise.all(
			inputs.map((input) => createGenerationJobTransaction(input, client)),
		);
		expect(results).toHaveLength(2);
		expect(results.every((result) => !result.replayed)).toBe(true);
		const flag = await disable("media.generation.enabled");
		try {
			for (const input of inputs) {
				await expect(createGenerationJobTransaction(input, client)).resolves.toMatchObject({
					replayed: true,
				});
			}
		} finally {
			await client.runtimeConfigOverride.delete({ where: { id: flag.id } });
		}
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(2);
		expect(
			await client.creditReservation.count({
				where: { accountId: f.account.id, status: "ACTIVE" },
			}),
		).toBe(2);
		expect(
			await client.creditLedgerEntry.count({ where: { accountId: f.account.id, type: "RESERVE" } }),
		).toBe(2);
		expect(
			await client.creditAccount.findUniqueOrThrow({ where: { id: f.account.id } }),
		).toMatchObject({ reservedCredits: 10n, spendableCredits: 90n });
	});
	it("admits 32 independently funded accounts without executing provider work", async () => {
		const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
		// Seed each ledger independently; the admission race below remains concurrent.
		for (let index = 0; index < 32; index += 1) fixtures.push(await fixture());
		const results = await Promise.all(
			fixtures.map((f) =>
				createGenerationJobTransaction({ ...f.input, maximumConcurrentJobs: 1 }, client),
			),
		);
		expect(results.every((result) => !result.replayed)).toBe(true);
		const ownerIds = fixtures.map((f) => f.ownerId),
			accountIds = fixtures.map((f) => f.account.id);
		expect(await client.generationJob.count({ where: { ownerId: { in: ownerIds } } })).toBe(32);
		expect(
			await client.creditReservation.count({
				where: { accountId: { in: accountIds }, status: "ACTIVE" },
			}),
		).toBe(32);
		expect(
			await client.creditLedgerEntry.count({
				where: { accountId: { in: accountIds }, type: "RESERVE" },
			}),
		).toBe(32);
	}, 30_000);
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
