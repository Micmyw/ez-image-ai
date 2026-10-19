import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		throw new Error("Unexpected implicit database connection");
	},
}));
vi.mock("./credits", () => ({
	createCreditGrant: vi.fn(),
	reserveCreditsInTransaction: vi.fn(),
}));

import { createGuestGenerationTransaction } from "./guest-admission";
import {
	acquireGuestBootstrapPrincipalLease,
	createGuestMediaUploadIntentTransaction,
} from "./guest-bootstrap";

const now = new Date("2026-10-19T12:00:00Z");
const hash = "a".repeat(64);
const limits = {
	maximumRequestsPerMinute: 100,
	maximumRequestsPerIpPerHour: 100,
	maximumGlobalQueueDepth: 25,
	maximumRequestsPerIpPerTenMinutes: 100,
	maximumRequestsPerIpPerDay: 100,
	maximumRequestsPerSubnetPerDay: 100,
	maximumGlobalRequestsPerMinute: 100,
	maximumGlobalRequestsPerHour: 100,
};
const boundaries = ["upload", "bootstrap", "generate"] as const;

describe("guest admission without a global daily request cap", () => {
	beforeEach(() => vi.stubEnv("VIDEO_V1_PROVIDER_CONCURRENCY", ""));
	afterEach(() => vi.unstubAllEnvs());

	it.each(boundaries)(
		"ignores a full legacy global-day bucket during %s admission",
		async (boundary) => {
			const fixture = boundaryFixture(boundary);

			if (boundary === "bootstrap") {
				await expect(fixture.run()).resolves.toMatchObject({ outcome: "ACQUIRED" });
			} else {
				// Stop at the first downstream business boundary after the real rate checks.
				await expect(fixture.run()).rejects.toBe(fixture.passedRateChecks);
			}

			expect(fixture.scopes).toEqual(
				expect.arrayContaining([
					`${fixture.prefix}:global:minute`,
					`${fixture.prefix}:global:hour`,
					`${fixture.prefix}:launch:ip:ten-minute`,
					`${fixture.prefix}:launch:ip:day`,
					`${fixture.prefix}:launch:subnet:day`,
				]),
			);
			expect(fixture.scopes).toHaveLength(5);
			expect(fixture.counts.get(`${fixture.prefix}:global:day`)).toBe(100n);
		},
	);

	it.each(
		boundaries.flatMap(
			(boundary) =>
				[
					[
						boundary,
						"global:minute",
						boundary === "generate"
							? "GUEST_GLOBAL_RATE_LIMIT"
							: boundary === "upload"
								? "GUEST_UPLOAD_RATE_LIMITED"
								: "GUEST_TEMPORARY_USER_CAP_EXCEEDED",
					],
					[
						boundary,
						"global:hour",
						boundary === "generate"
							? "GUEST_GLOBAL_RATE_LIMIT"
							: boundary === "upload"
								? "GUEST_UPLOAD_RATE_LIMITED"
								: "GUEST_TEMPORARY_USER_CAP_EXCEEDED",
					],
					[
						boundary,
						"launch:ip:ten-minute",
						boundary === "generate"
							? "GUEST_IP_RATE_LIMIT"
							: boundary === "upload"
								? "GUEST_UPLOAD_RATE_LIMITED"
								: "GUEST_TEMPORARY_USER_CAP_EXCEEDED",
					],
					[
						boundary,
						"launch:ip:day",
						boundary === "generate"
							? "GUEST_IP_RATE_LIMIT"
							: boundary === "upload"
								? "GUEST_UPLOAD_RATE_LIMITED"
								: "GUEST_TEMPORARY_USER_CAP_EXCEEDED",
					],
					[
						boundary,
						"launch:subnet:day",
						boundary === "generate"
							? "GUEST_SUBNET_RATE_LIMIT"
							: boundary === "upload"
								? "GUEST_UPLOAD_RATE_LIMITED"
								: "GUEST_TEMPORARY_USER_CAP_EXCEEDED",
					],
				] as const,
		),
	)("retains the %s %s request limit", async (boundary, scope, errorCode) => {
		const fixture = boundaryFixture(boundary, scope);

		await expect(fixture.run()).rejects.toThrow(errorCode);
		expect(fixture.scopes).toContain(`${fixture.prefix}:${scope}`);
		expect(fixture.scopes).not.toContain(`${fixture.prefix}:global:day`);
	});
});

function boundaryFixture(boundary: (typeof boundaries)[number], blockedScope = "global:day") {
	const prefix = `guest-${boundary}`;
	const scopes: string[] = [];
	const counts = new Map([
		[`${prefix}:global:day`, 100n],
		[`${prefix}:${blockedScope}`, 100n],
	]);
	const passedRateChecks = new Error("DOWNSTREAM_BUSINESS_CHECK_REACHED");
	const expiresAt = new Date(now.getTime() + 60_000);
	const evidence = {
		status: "APPROVED",
		assetChecksum: hash,
		verificationGeneration: 1,
		attemptNumber: 1,
		evidenceKind: "INPUT",
		provider: "test",
		providerTaskId: "moderation-1",
		ruleVersion: "rule-v1",
		policyVersion: "policy-v1",
		validUntil: expiresAt,
	};
	const tx = {
		$executeRaw: vi.fn().mockResolvedValue(1),
		$queryRaw: vi.fn(async (_sql: TemplateStringsArray, ...values: unknown[]) => {
			const scope = values[0] as string;
			scopes.push(scope);
			const count = (counts.get(scope) ?? 0n) + 1n;
			counts.set(scope, count);
			return [{ allowed: count <= (values[5] as bigint) }];
		}),
		guestAbuseBucket: { create: vi.fn().mockResolvedValue({}), upsert: vi.fn() },
		guestLinkIntent: { findUnique: vi.fn().mockResolvedValue(null) },
		guestMediaTrial: { count: vi.fn().mockResolvedValue(0) },
		generationJob: {
			findUnique: vi.fn().mockResolvedValue(null),
			count: vi.fn().mockRejectedValue(passedRateChecks),
		},
		user: { findUnique: vi.fn().mockResolvedValue({ isAnonymous: true }) },
		guestSessionBootstrap: {
			findFirst: vi.fn().mockResolvedValue(
				boundary === "bootstrap"
					? {
							id: "bootstrap-1",
							ownerId: null,
							completedAt: null,
							principalLeaseToken: null,
							principalLeaseExpiresAt: null,
							version: 0,
						}
					: {
							claimedDraft: {
								ownerType: "USER",
								ownerId: "guest-owner",
								submittedByUserId: "guest-owner",
								status: "SUBMITTED",
								assetId: "asset-1",
							},
							sourceAsset: {
								ownerType: "USER",
								ownerId: "guest-owner",
								kind: "INPUT",
								status: "READY",
								retentionClass: "GUEST_TRIAL",
								deletedAt: null,
								deleteAfter: expiresAt,
								byteSize: 8n,
								checksum: hash,
								verificationGeneration: 1,
								verificationAttemptCount: 1,
								verificationProvider: "test",
								verificationProviderTaskId: "moderation-1",
								verificationRuleVersion: "rule-v1",
								verificationPolicyVersion: "policy-v1",
								verificationValidUntil: expiresAt,
								moderationResults: [evidence],
							},
						},
			),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
	};
	const client = {
		...tx,
		$transaction: vi.fn(
			async (
				operation: (transaction: typeof tx) => unknown,
				options?: { isolationLevel?: string },
			) => {
				if (boundary === "upload" && options?.isolationLevel === "Serializable")
					throw passedRateChecks;
				return operation(tx);
			},
		),
	};
	const run = () => {
		if (boundary === "upload")
			return createGuestMediaUploadIntentTransaction(
				{
					assetId: "asset-1",
					sessionId: "upload-1",
					ownerType: "USER",
					ownerId: "guest-owner",
					kind: "INPUT",
					objectKey: "final.png",
					stagingObjectKey: "staging.png",
					mimeType: "image/png",
					expectedBytes: 8n,
					completionTokenHash: hash,
					expiresAt,
					multipartUploadId: null,
					limits: { maximumActiveSessions: 1, maximumReservedBytes: 10_000n },
					capabilityVersion: "capability-v1",
					promotionPeriod: "launch",
					originHash: hash,
					expectedSha256: hash,
					deleteAfter: new Date(now.getTime() + 86_400_000),
					ipHash: hash,
					subnetHash: hash,
					abuseLimits: limits,
				},
				client as never,
			);
		if (boundary === "bootstrap")
			return acquireGuestBootstrapPrincipalLease(
				{
					claimHash: hash,
					expectedOrigin: "https://example.test",
					origin: "https://example.test",
					principalEmail: "guest@anonymous.invalid",
					promotionPeriod: "launch",
					ipHash: hash,
					subnetHash: hash,
					limits,
					now,
				},
				client as never,
			);
		return createGuestGenerationTransaction(
			{
				ownerId: "guest-owner",
				promotionPeriod: "launch",
				capabilityVersion: "capability-v1",
				sourceSessionHash: hash,
				deviceHash: hash,
				ipHash: hash,
				subnetHash: hash,
				idempotencyKey: "guest-generation-1",
				idempotencyFingerprint: hash,
				denialSubjectHash: hash,
				turnstile: { tokenHash: hash, challengeTimestamp: now, expiresAt },
				sourceDraftId: "draft-1",
				sourceBootstrapId: "bootstrap-1",
				sourceAssetId: "asset-1",
				sourceAssetChecksum: hash,
				now,
				retentionMs: 60_000,
				queueTtlMs: 60_000,
				serviceTimeMs: 1_000,
				maximumBytes: 10 * 1024 * 1024,
				maximumActiveJobsPerGuest: 1,
				...limits,
				abuseEvidenceTtlMs: 60_000,
				riskBudgetMicros: 230_000n,
				sponsorCredits: 5n,
				assetModeration: { provider: "test", ruleVersion: "rule-v1", policyVersion: "policy-v1" },
				quote: {
					ownerType: "USER",
					ownerId: "guest-owner",
					submittedByUserId: "guest-owner",
					productKey: "image-nano-banana-2-lite",
					catalogVersion: "catalog-v1",
					pricingVersion: "pricing-v1",
					credits: 5n,
					costMicros: 23_000n,
					inputSnapshot: { kind: "image-to-image", skuKey: "nano-banana-2-lite-1k" },
					pricingSnapshot: {},
					expiresAt,
					moderation: {
						decision: "ALLOW",
						provider: "test",
						ruleVersion: "rule-v1",
						reasonCode: "TEST_ALLOW",
						inputFingerprint: hash,
					},
				},
			},
			client as never,
			vi.fn() as never,
		);
	};
	return { run, prefix, scopes, counts, passedRateChecks };
}
