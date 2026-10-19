import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const pgTestUrl = process.env.GUEST_BOUNDARY_PG_TEST_DATABASE_URL;
describe.skipIf(!pgTestUrl)("PostgreSQL guest network boundary regression", () => {
	let connection: import("pg").Client;
	const schema = `guest_boundary_${crypto.randomUUID().replaceAll("-", "")}`;
	beforeAll(async () => {
		const url = new URL(pgTestUrl!);
		if (
			!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
			!/test/i.test(url.pathname)
		) {
			throw new Error("LOCAL_GUEST_TEST_DATABASE_REQUIRED");
		}
		const { Client } = await import("pg");
		connection = new Client({ connectionString: pgTestUrl });
		await connection.connect();
		await connection.query(`CREATE SCHEMA "${schema}"`);
		await connection.query(`SET search_path TO "${schema}"`);
		await connection.query(`CREATE TABLE guest_abuse_bucket (
      id text PRIMARY KEY, scope text NOT NULL, "subjectHash" text NOT NULL,
      "windowStart" timestamptz NOT NULL, "windowEnd" timestamptz NOT NULL,
      "requestCount" bigint NOT NULL, "rejectionCount" bigint NOT NULL,
      "expiresAt" timestamptz NOT NULL, version integer NOT NULL, "updatedAt" timestamptz NOT NULL,
      UNIQUE(scope, "subjectHash", "windowStart"))`);
	});
	afterAll(async () => {
		if (!connection) return;
		await connection.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
		await connection.end();
	});
	it.each(boundaries)(
		"allows independent %s guests sharing one network using real PostgreSQL buckets",
		async (boundary) => {
			await connection.query("TRUNCATE guest_abuse_bucket");
			const admissionTime = boundary === "upload" ? new Date() : now;
			for (const [scope, windowMs] of [
				["ip:ten-minute", 600_000],
				["ip:day", 86_400_000],
				["subnet:day", 86_400_000],
			] as const) {
				const start = new Date(Math.floor(admissionTime.getTime() / windowMs) * windowMs);
				const end = new Date(start.getTime() + windowMs);
				await connection.query(
					"INSERT INTO guest_abuse_bucket VALUES ($1,$2,$3,$4,$5,100,0,$6,0,$4)",
					[
						crypto.randomUUID(),
						`guest-${boundary}:launch:${scope}`,
						hash,
						start,
						end,
						new Date(end.getTime() + 86_400_000),
					],
				);
			}
			for (let index = 0; index < 3; index++) {
				const fixture = boundaryFixture(boundary);
				fixture.tx.$queryRaw.mockImplementation(async (sql, ...values) => {
					const result = await connection.query(
						sql.reduce((text, part, index) => text + (index ? `$${index}` : "") + part, ""),
						values,
					);
					return result.rows;
				});
				if (boundary === "bootstrap")
					await expect(fixture.run()).resolves.toMatchObject({ outcome: "ACQUIRED" });
				else await expect(fixture.run()).rejects.toBe(fixture.passedRateChecks);
			}
			const { rows } = await connection.query(
				'SELECT scope, "requestCount" FROM guest_abuse_bucket ORDER BY scope',
			);
			const globalRows = rows.filter(({ scope }) => scope.includes(":global:"));
			expect(globalRows).toHaveLength(2);
			expect(
				globalRows.every(
					({ scope, requestCount }) =>
						/^guest-(upload|bootstrap|generate):global:(minute|hour)$/.test(scope) &&
						requestCount === "3",
				),
			).toBe(true);
			expect(
				rows
					.filter(({ scope }) => /:ip:|:subnet:/.test(scope))
					.map(({ requestCount }) => requestCount),
			).toEqual(["100", "100", "100"]);
		},
	);
});

describe("guest admission without a global daily request cap", () => {
	beforeEach(() => vi.stubEnv("VIDEO_V1_PROVIDER_CONCURRENCY", ""));
	afterEach(() => vi.unstubAllEnvs());
	it("does not reject a guest's second daily edit when 80 tasks are unfinished", async () => {
		const fixture = boundaryFixture("generate");
		fixture.tx.generationJob.count.mockResolvedValue(80);
		fixture.tx.guestMediaTrial.count.mockResolvedValue(1);
		await expect(fixture.run()).rejects.toBe(fixture.passedRateChecks);
	});
	it("keeps the daily free allowance independent from task-count admission", async () => {
		const fixture = boundaryFixture("generate");
		fixture.tx.generationJob.count.mockResolvedValue(80);
		fixture.tx.guestMediaTrial.count.mockResolvedValue(2);
		await expect(fixture.run()).rejects.toThrow("GUEST_TRIAL_UNAVAILABLE");
		expect(fixture.tx.generationJob.count).not.toHaveBeenCalled();
	});
	it("does not reject by estimated queue depth or queue time before the actual file expires", async () => {
		const fixture = boundaryFixture("generate");
		fixture.tx.generationJob.count.mockResolvedValue(80);
		fixture.tx.guestRiskBudgetBucket.findUnique.mockResolvedValue(null);
		await expect(fixture.run()).rejects.toThrow("GUEST_PRICE_CHANGED");
		expect(fixture.resolveCanonicalQuote).toHaveBeenCalledOnce();
	});
	it("does not reject guest admission when other owners occupy provider execution capacity", async () => {
		vi.stubEnv("VIDEO_V1_PROVIDER_CONCURRENCY", "1");
		const fixture = boundaryFixture("generate");
		await expect(fixture.run()).rejects.toBe(fixture.passedRateChecks);
		expect(fixture.scopes).toHaveLength(2);
	});

	it.each(boundaries)(
		"does not share IP or subnet quotas during %s admission",
		async (boundary) => {
			for (const scope of ["launch:ip:ten-minute", "launch:ip:day", "launch:subnet:day"]) {
				const fixture = boundaryFixture(boundary, scope);
				if (boundary === "bootstrap") {
					await expect(fixture.run()).resolves.toMatchObject({ outcome: "ACQUIRED" });
				} else {
					await expect(fixture.run()).rejects.toBe(fixture.passedRateChecks);
				}
				expect(fixture.counts.get(`${fixture.prefix}:${scope}`)).toBe(100n);
				expect(fixture.scopes).toEqual([
					`${fixture.prefix}:global:minute`,
					`${fixture.prefix}:global:hour`,
				]);
			}
		},
	);

	it("does not reject an independent guest because other active jobs share its IP", async () => {
		const fixture = boundaryFixture("generate");
		fixture.tx.generationJob.count.mockImplementation(async ({ where }) => {
			if (where.guestTrial?.ipHash) return 100;
			if (where.ownerId || where.guestTrial?.deviceHash) return 0;
			throw fixture.passedRateChecks;
		});
		await expect(fixture.run()).rejects.toBe(fixture.passedRateChecks);
	});

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
				]),
			);
			expect(fixture.scopes).toHaveLength(2);
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
		guestRiskBudgetBucket: { findUnique: vi.fn().mockRejectedValue(passedRateChecks) },
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
	const resolveCanonicalQuote = vi.fn().mockRejectedValue(passedRateChecks);
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
			resolveCanonicalQuote as never,
		);
	};
	return { run, prefix, scopes, counts, passedRateChecks, tx, resolveCanonicalQuote };
}
