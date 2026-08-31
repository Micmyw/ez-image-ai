import { createHash, randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { getAdminMediaDiagnostics } from "./admin-diagnostics";
import { createGuestGenerationTransaction } from "./guest-admission";
import { expireGuestJobBeforeProvider } from "./guest-retention";
import { fingerprintGenerationQuoteSecurityPayload } from "./quotes";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL;

let client: PrismaClient;

const guestAdmissionTestDay = new Date();
guestAdmissionTestDay.setUTCDate(guestAdmissionTestDay.getUTCDate() + 1);
guestAdmissionTestDay.setUTCHours(3, 0, 0, 0);

function guestAdmissionTestTime(minutesAfterThreeUtc: number): Date {
	return new Date(guestAdmissionTestDay.getTime() + minutesAfterThreeUtc * 60_000);
}

describe("guest generation admission", () => {
	beforeAll(async () => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl() }),
		});
		await client.$connect();
	});

	beforeEach(async () => {
		await client.$executeRawUnsafe(
			'TRUNCATE TABLE "user", "guest_abuse_bucket", "guest_risk_budget_bucket", "outbox_event", "generation_quote" CASCADE',
		);
	});

	afterAll(async () => {
		await client?.$disconnect();
	});

	it("commits exactly one sponsored graph under a deterministic 32-way replay", async () => {
		const fixture = await createGuestFixture("replay");
		const input = guestAdmissionInput(fixture, { idempotencyKey: "guest-replay-0001" });
		const results = await concurrentBarrier(32, () => createGuestAdmission(input));

		expect(new Set(results.map((result) => result.jobId)).size).toBe(1);
		const jobId = results[0]!.jobId;
		const trial = await client.guestMediaTrial.findUniqueOrThrow({
			where: {
				ownerId_promotionPeriod: {
					ownerId: fixture.ownerId,
					promotionPeriod: fixture.promotionPeriod,
				},
			},
		});
		const account = await client.creditAccount.findUniqueOrThrow({
			where: { ownerType_ownerId: { ownerType: "USER", ownerId: fixture.ownerId } },
		});
		await expect(
			Promise.all([
				client.guestMediaTrial.count({ where: { ownerId: fixture.ownerId } }),
				client.generationQuote.count({ where: { ownerId: fixture.ownerId } }),
				client.generationJob.count({ where: { ownerId: fixture.ownerId } }),
				client.creditLedgerEntry.count({
					where: { accountId: account.id, type: "GRANT" },
				}),
				client.creditReservation.count({ where: { jobId } }),
				client.creditReservationAllocation.count({
					where: { reservation: { jobId } },
				}),
				client.generationJobAsset.count({ where: { jobId, role: "INPUT" } }),
				client.outboxEvent.count({
					where: { aggregateId: jobId, eventType: "GUEST_GENERATION_ELIGIBLE" },
				}),
			]),
		).resolves.toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
		expect(trial).toMatchObject({
			currentJobId: jobId,
			eligibility: "IN_FLIGHT",
			riskState: "HELD",
			sponsorCredits: 4n,
		});
		expect(account).toMatchObject({ spendableCredits: 0n, reservedCredits: 4n });
		await expect(
			client.outboxEvent.findFirstOrThrow({
				where: { aggregateId: jobId, eventType: "GUEST_GENERATION_ELIGIBLE" },
			}),
		).resolves.toMatchObject({ availableAt: trial.projectedDispatchAt });
	});

	it("persists the immutable abuse-evidence expiry from the admission TTL", async () => {
		const fixture = await createGuestFixture("evidence-expiry");
		const abuseEvidenceTtlMs = 17 * 24 * 60 * 60_000;
		const admitted = await createGuestAdmission(
			guestAdmissionInput(fixture, {
				idempotencyKey: "guest-evidence-expiry",
				abuseEvidenceTtlMs,
			}),
		);

		const rows = await client.$queryRaw<
			Array<{ abuseEvidenceDeletedAt: Date | null; abuseEvidenceExpiresAt: Date | null }>
		>`
			SELECT
				(to_jsonb(trial)->>'abuseEvidenceExpiresAt')::timestamptz AS "abuseEvidenceExpiresAt",
				(to_jsonb(trial)->>'abuseEvidenceDeletedAt')::timestamptz AS "abuseEvidenceDeletedAt"
			FROM "guest_media_trial" trial
			WHERE trial."id" = ${admitted.trialId}
		`;

		expect(rows).toEqual([
			{
				abuseEvidenceExpiresAt: new Date(fixture.now.getTime() + abuseEvidenceTtlMs),
				abuseEvidenceDeletedAt: null,
			},
		]);
	});

	it("creates no business graph when the queue dimension is N plus one", async () => {
		const admitted = await createGuestFixture("capacity-a");
		await createGuestAdmission(
			guestAdmissionInput(admitted, {
				idempotencyKey: "guest-capacity-a",
				maximumGlobalQueueDepth: 1,
			}),
		);
		const rejected = await createGuestFixture("capacity-b");

		await expect(
			createGuestAdmission(
				guestAdmissionInput(rejected, {
					idempotencyKey: "guest-capacity-b",
					maximumGlobalQueueDepth: 1,
				}),
			),
		).rejects.toThrow("GUEST_QUEUE_CAPACITY");
		await expect(countGuestBusinessGraph(rejected.ownerId)).resolves.toEqual(
			emptyGuestBusinessGraph(),
		);
	});

	it("keeps old promotion queue and failures out of current admission and diagnostics", async () => {
		const fixtureNow = new Date();
		const oldFixture = await createGuestFixture("old-promotion", fixtureNow, "promotion-old");
		const oldAdmission = await createGuestAdmission(
			guestAdmissionInput(oldFixture, {
				idempotencyKey: "guest-old-promotion",
				maximumGlobalQueueDepth: 1,
				riskBudgetMicros: 4_000n,
			}),
		);
		await client.generationJob.update({
			where: { id: oldAdmission.jobId },
			data: { failureCode: "GUEST_WATERMARK_FAILED" },
		});
		await client.guestMediaTrial.update({
			where: { id: oldAdmission.trialId },
			data: { riskState: "COMMITTED", providerBoundaryAt: oldFixture.now },
		});
		await client.guestAbuseBucket.create({
			data: {
				scope: "guest-denial:promotion-old:QUEUE_CAPACITY",
				subjectHash: hashFixture("old-denial"),
				windowStart: new Date(0),
				windowEnd: new Date(1),
				rejectionCount: 1n,
				expiresAt: oldFixture.validUntil,
			},
		});

		const currentFixture = await createGuestFixture(
			"current-promotion",
			fixtureNow,
			"promotion-current",
		);
		await expect(
			createGuestAdmission(
				guestAdmissionInput(currentFixture, {
					idempotencyKey: "guest-current-promotion",
					maximumGlobalQueueDepth: 1,
				}),
			),
		).resolves.toMatchObject({ stage: "WAITING" });

		const diagnostics = await getAdminMediaDiagnostics(client, {
			guestEnvironmentEnabled: true,
			guestPromotionPeriod: "promotion-current",
			guestRiskBudgetMicros: 350_000n,
		});
		expect(diagnostics.guest.watermark.failed).toBe(0);
		expect(diagnostics.guest.admission.deniedByReason).toEqual([]);
		expect(diagnostics.guest.admission.accepted).toBe(1);
		expect(diagnostics.guest.risk.heldMicros).toBe("3500");
	});

	it("doubles the queue estimate at 75 percent risk and rejects at 90 percent", async () => {
		const fixtureNow = new Date();
		const slowFixture = await createGuestFixture("risk-slow", fixtureNow, "promotion-slow");
		await client.guestRiskBudgetBucket.create({
			data: {
				promotionPeriod: slowFixture.promotionPeriod,
				subjectHash: "global",
				reservedMicros: 262_500n,
				hardLimitMicros: 350_000n,
				expiresAt: slowFixture.validUntil,
			},
		});
		const slow = await createGuestAdmission(
			guestAdmissionInput(slowFixture, { idempotencyKey: "guest-risk-slow" }),
		);
		expect(slow.projectedDispatchAt).toEqual(new Date(slowFixture.now.getTime() + 120_000));

		const closedFixture = await createGuestFixture("risk-closed", fixtureNow, "promotion-closed");
		await client.guestRiskBudgetBucket.create({
			data: {
				promotionPeriod: closedFixture.promotionPeriod,
				subjectHash: "global",
				reservedMicros: 315_000n,
				hardLimitMicros: 350_000n,
				expiresAt: closedFixture.validUntil,
			},
		});
		await expect(
			createGuestAdmission(
				guestAdmissionInput(closedFixture, { idempotencyKey: "guest-risk-closed" }),
			),
		).rejects.toThrow("GUEST_RISK_CAPACITY");
	});

	it("persists one idempotent global-rate denial after the business transaction rolls back", async () => {
		const evidenceTtlMs = 17 * 24 * 60 * 60_000;
		const first = await createGuestFixture("rate-first");
		await createGuestAdmission(
			guestAdmissionInput(first, {
				idempotencyKey: "guest-rate-first",
				maximumRequestsPerMinute: 1,
				abuseEvidenceTtlMs: evidenceTtlMs,
			}),
		);
		const denied = await createGuestFixture("rate-denied");
		const input = guestAdmissionInput(denied, {
			idempotencyKey: "guest-rate-denied",
			maximumRequestsPerMinute: 1,
			abuseEvidenceTtlMs: evidenceTtlMs,
		});

		await expect(createGuestAdmission(input)).rejects.toThrow("GUEST_GLOBAL_RATE_LIMIT");
		await expect(createGuestAdmission(input)).rejects.toThrow("GUEST_GLOBAL_RATE_LIMIT");
		await expect(
			client.guestAbuseBucket.aggregate({
				where: { scope: `guest-denial:${denied.promotionPeriod}:GLOBAL_RATE_LIMIT` },
				_sum: { rejectionCount: true },
			}),
		).resolves.toMatchObject({ _sum: { rejectionCount: 1n } });
		await expect(
			client.guestAbuseBucket.findUniqueOrThrow({
				where: {
					scope_subjectHash_windowStart: {
						scope: `guest-denial:${denied.promotionPeriod}:GLOBAL_RATE_LIMIT`,
						subjectHash: input.idempotencyFingerprint,
						windowStart: new Date(0),
					},
				},
			}),
		).resolves.toMatchObject({
			expiresAt: new Date(input.now.getTime() + evidenceTtlMs),
		});
	});

	it("isolates generation IP and subnet evidence by promotion while sharing global capacity", async () => {
		const now = guestAdmissionTestTime(10);
		const sharedIpHash = hashFixture("promotion-isolation-ip");
		const sharedSubnetHash = hashFixture("promotion-isolation-subnet");
		const first = await createGuestFixture("promotion-isolation-a", now, "promotion-a");
		const second = await createGuestFixture("promotion-isolation-b", now, "promotion-b");
		const limits = {
			maximumRequestsPerIpPerTenMinutes: 1,
			maximumRequestsPerIpPerDay: 1,
			maximumRequestsPerSubnetPerDay: 1,
			maximumGlobalRequestsPerMinute: 2,
			maximumGlobalRequestsPerHour: 2,
			maximumGlobalRequestsPerDay: 2,
		};

		await expect(
			createGuestAdmission(
				guestAdmissionInput(first, {
					idempotencyKey: "guest-promotion-isolation-a",
					ipHash: sharedIpHash,
					subnetHash: sharedSubnetHash,
					...limits,
				}),
			),
		).resolves.toMatchObject({ stage: "WAITING" });
		await expect(
			createGuestAdmission(
				guestAdmissionInput(second, {
					idempotencyKey: "guest-promotion-isolation-b",
					ipHash: sharedIpHash,
					subnetHash: sharedSubnetHash,
					...limits,
				}),
			),
		).resolves.toMatchObject({ stage: "WAITING" });

		const scopes = await client.guestAbuseBucket.findMany({
			where: { subjectHash: { in: [sharedIpHash, sharedSubnetHash, "global"] } },
			select: { scope: true, subjectHash: true, requestCount: true },
		});
		expect(scopes).toEqual(
			expect.arrayContaining([
				{
					scope: "guest-generate:promotion-a:ip:ten-minute",
					subjectHash: sharedIpHash,
					requestCount: 1n,
				},
				{
					scope: "guest-generate:promotion-b:ip:ten-minute",
					subjectHash: sharedIpHash,
					requestCount: 1n,
				},
				{
					scope: "guest-generate:promotion-a:ip:day",
					subjectHash: sharedIpHash,
					requestCount: 1n,
				},
				{
					scope: "guest-generate:promotion-b:ip:day",
					subjectHash: sharedIpHash,
					requestCount: 1n,
				},
				{
					scope: "guest-generate:promotion-a:subnet:day",
					subjectHash: sharedSubnetHash,
					requestCount: 1n,
				},
				{
					scope: "guest-generate:promotion-b:subnet:day",
					subjectHash: sharedSubnetHash,
					requestCount: 1n,
				},
				{
					scope: "guest-generate:global:minute",
					subjectHash: "global",
					requestCount: 2n,
				},
				{
					scope: "guest-generate:global:hour",
					subjectHash: "global",
					requestCount: 2n,
				},
				{
					scope: "guest-generate:global:day",
					subjectHash: "global",
					requestCount: 2n,
				},
			]),
		);
	});

	it("keeps generation global capacity cross-promotion without leaking a rejected graph", async () => {
		const now = guestAdmissionTestTime(20);
		const first = await createGuestFixture("global-capacity-a", now, "global-promotion-a");
		const rejected = await createGuestFixture("global-capacity-b", now, "global-promotion-b");

		await createGuestAdmission(
			guestAdmissionInput(first, {
				idempotencyKey: "guest-global-capacity-a",
				maximumGlobalRequestsPerMinute: 1,
			}),
		);
		await expect(
			createGuestAdmission(
				guestAdmissionInput(rejected, {
					idempotencyKey: "guest-global-capacity-b",
					maximumGlobalRequestsPerMinute: 1,
				}),
			),
		).rejects.toThrow("GUEST_GLOBAL_RATE_LIMIT");

		await expect(countGuestBusinessGraph(rejected.ownerId)).resolves.toEqual({
			trials: 0,
			quotes: 0,
			accounts: 0,
			lots: 0,
			ledgers: 0,
			reservations: 0,
			jobs: 0,
			outbox: 0,
			attempts: 0,
		});
		await expect(
			client.guestAbuseBucket.findFirst({
				where: { scope: "guest-generate:global:minute", subjectHash: "global" },
				select: { requestCount: true },
			}),
		).resolves.toEqual({ requestCount: 1n });
	});

	it("admits exactly N concurrent global requests across promotions", async () => {
		const now = guestAdmissionTestTime(25);
		const fixtures = await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				createGuestFixture(`global-concurrent-${index}`, now, `global-concurrent-${index}`),
			),
		);
		const results = await concurrentSettledBarrier(
			fixtures.map(
				(fixture, index) => () =>
					createGuestAdmission(
						guestAdmissionInput(fixture, {
							idempotencyKey: `guest-global-concurrent-${index}`,
							maximumGlobalRequestsPerMinute: 2,
						}),
					),
			),
		);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(6);
		for (const [index, result] of results.entries()) {
			if (result.status === "fulfilled") continue;
			expect(result.reason).toEqual(
				expect.objectContaining({ message: "GUEST_GLOBAL_RATE_LIMIT" }),
			);
			await expect(countGuestBusinessGraph(fixtures[index]!.ownerId)).resolves.toEqual(
				emptyGuestBusinessGraph(),
			);
		}
		await expect(
			client.guestAbuseBucket.findFirst({
				where: { scope: "guest-generate:global:minute", subjectHash: "global" },
				select: { requestCount: true },
			}),
		).resolves.toEqual({ requestCount: 2n });
	});

	it("returns one stable domain rejection for concurrent admissions sharing a session", async () => {
		const now = guestAdmissionTestTime(30);
		const promotionPeriod = "shared-session-promotion";
		const sharedSessionHash = hashFixture("shared-session");
		const fixtures = await Promise.all([
			createGuestFixture("shared-session-a", now, promotionPeriod),
			createGuestFixture("shared-session-b", now, promotionPeriod),
		]);
		const results = await concurrentSettledBarrier(
			fixtures.map(
				(fixture, index) => () =>
					createGuestAdmission(
						guestAdmissionInput(fixture, {
							idempotencyKey: `guest-shared-session-${index}`,
							sourceSessionHash: sharedSessionHash,
						}),
					),
			),
		);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected).toMatchObject({
			status: "rejected",
			reason: expect.objectContaining({ message: "GUEST_TRIAL_UNAVAILABLE" }),
		});
		await expect(
			client.guestMediaTrial.count({
				where: { promotionPeriod, sourceSessionHash: sharedSessionHash },
			}),
		).resolves.toBe(1);
		await expect(
			client.generationAttempt.count({ where: { job: { guestTrial: { promotionPeriod } } } }),
		).resolves.toBe(0);
		const rejectedIndex = results.findIndex((result) => result.status === "rejected");
		await expect(countGuestBusinessGraph(fixtures[rejectedIndex]!.ownerId)).resolves.toEqual(
			emptyGuestBusinessGraph(),
		);
	});

	it("enforces the production device-accepted invariant before a second active device graph", async () => {
		const promotionPeriod = `device-accepted-${randomUUID()}`;
		const sharedDeviceHash = hashFixture("device-accepted-shared");
		const first = await createGuestFixture("device-accepted-first", undefined, promotionPeriod);
		const rejected = await createGuestFixture(
			"device-accepted-rejected",
			undefined,
			promotionPeriod,
		);

		await createGuestAdmission(
			guestAdmissionInput(first, {
				idempotencyKey: "guest-device-accepted-first",
				deviceHash: sharedDeviceHash,
			}),
		);
		await expect(
			createGuestAdmission(
				guestAdmissionInput(rejected, {
					idempotencyKey: "guest-device-accepted-rejected",
					deviceHash: sharedDeviceHash,
				}),
			),
		).rejects.toThrow("GUEST_TRIAL_UNAVAILABLE");
		await expect(countGuestBusinessGraph(rejected.ownerId)).resolves.toEqual(
			emptyGuestBusinessGraph(),
		);
	});

	it("keeps the active-device fence reachable under a targeted accepted-count override", async () => {
		const promotionPeriod = `device-active-${randomUUID()}`;
		const sharedDeviceHash = hashFixture("device-active-shared");
		const first = await createGuestFixture("device-active-first", undefined, promotionPeriod);
		const rejected = await createGuestFixture("device-active-rejected", undefined, promotionPeriod);
		const targetedLimits = {
			deviceHash: sharedDeviceHash,
			maximumAcceptedTrialsPerDevicePromotion: 2,
			maximumActiveJobsPerDevice: 1,
		};

		await createGuestAdmission(
			guestAdmissionInput(first, {
				idempotencyKey: "guest-device-active-first",
				...targetedLimits,
			}),
		);
		await expect(
			createGuestAdmission(
				guestAdmissionInput(rejected, {
					idempotencyKey: "guest-device-active-rejected",
					...targetedLimits,
				}),
			),
		).rejects.toThrow("GUEST_DEVICE_LIMIT");
		await expect(countGuestBusinessGraph(rejected.ownerId)).resolves.toEqual(
			emptyGuestBusinessGraph(),
		);
	});

	it("allows two active IP jobs and rejects the literal third without a partial graph", async () => {
		const promotionPeriod = `ip-active-${randomUUID()}`;
		const sharedIpHash = hashFixture("ip-active-shared");
		const fixtures = await Promise.all(
			["first", "second", "rejected"].map((label) =>
				createGuestFixture(`ip-active-${label}`, undefined, promotionPeriod),
			),
		);
		for (const [index, fixture] of fixtures.slice(0, 2).entries()) {
			await createGuestAdmission(
				guestAdmissionInput(fixture, {
					idempotencyKey: `guest-ip-active-${index}`,
					ipHash: sharedIpHash,
					maximumActiveJobsPerIp: 2,
				}),
			);
		}
		const rejected = fixtures[2]!;
		await expect(
			createGuestAdmission(
				guestAdmissionInput(rejected, {
					idempotencyKey: "guest-ip-active-rejected",
					ipHash: sharedIpHash,
					maximumActiveJobsPerIp: 2,
				}),
			),
		).rejects.toThrow("GUEST_IP_RATE_LIMIT");
		await expect(countGuestBusinessGraph(rejected.ownerId)).resolves.toEqual(
			emptyGuestBusinessGraph(),
		);
	});

	it("lets queue age reach exactly 600 seconds and rejects the next minute before depth 25", async () => {
		const now = guestAdmissionTestTime(60);
		const promotionPeriod = `queue-age-${randomUUID()}`;
		for (let index = 0; index < 11; index += 1) {
			const fixture = await createGuestFixture(`queue-age-${index}`, now, promotionPeriod);
			const admitted = await createGuestAdmission(
				guestAdmissionInput(fixture, {
					idempotencyKey: `guest-queue-age-${index}`,
					queueTtlMs: 600_000,
					queueCapacity: 1,
					maximumGlobalQueueDepth: 25,
				}),
			);
			if (index === 10) {
				expect(admitted.projectedDispatchAt).toEqual(new Date(now.getTime() + 600_000));
			}
		}
		const rejected = await createGuestFixture("queue-age-rejected", now, promotionPeriod);

		await expect(
			createGuestAdmission(
				guestAdmissionInput(rejected, {
					idempotencyKey: "guest-queue-age-rejected",
					queueTtlMs: 600_000,
					queueCapacity: 1,
					maximumGlobalQueueDepth: 25,
				}),
			),
		).rejects.toThrow("GUEST_QUEUE_CAPACITY");
		await expect(countGuestBusinessGraph(rejected.ownerId)).resolves.toEqual(
			emptyGuestBusinessGraph(),
		);
	});

	it("admits exactly 25 queued jobs with controlled capacity and rejects depth N plus one", async () => {
		const now = guestAdmissionTestTime(80);
		const promotionPeriod = `queue-depth-${randomUUID()}`;
		for (let index = 0; index < 25; index += 1) {
			const fixture = await createGuestFixture(`queue-depth-${index}`, now, promotionPeriod);
			await expect(
				createGuestAdmission(
					guestAdmissionInput(fixture, {
						idempotencyKey: `guest-queue-depth-${index}`,
						queueTtlMs: 600_000,
						queueCapacity: 25,
						maximumGlobalQueueDepth: 25,
					}),
				),
			).resolves.toMatchObject({ stage: "WAITING" });
		}
		const rejected = await createGuestFixture("queue-depth-rejected", now, promotionPeriod);

		await expect(
			createGuestAdmission(
				guestAdmissionInput(rejected, {
					idempotencyKey: "guest-queue-depth-rejected",
					queueTtlMs: 600_000,
					queueCapacity: 25,
					maximumGlobalQueueDepth: 25,
				}),
			),
		).rejects.toThrow("GUEST_QUEUE_CAPACITY");
		await expect(countGuestBusinessGraph(rejected.ownerId)).resolves.toEqual(
			emptyGuestBusinessGraph(),
		);
		await expect(client.guestMediaTrial.count({ where: { promotionPeriod } })).resolves.toBe(25);
	});

	it.each([
		["IP ten-minute", "maximumRequestsPerIpPerTenMinutes", 1, "GUEST_IP_RATE_LIMIT", "ipHash"],
		["IP daily", "maximumRequestsPerIpPerDay", 3, "GUEST_IP_RATE_LIMIT", "ipHash"],
		["subnet daily", "maximumRequestsPerSubnetPerDay", 20, "GUEST_SUBNET_RATE_LIMIT", "subnetHash"],
		["global hourly", "maximumGlobalRequestsPerHour", 30, "GUEST_GLOBAL_RATE_LIMIT", null],
		["global daily", "maximumGlobalRequestsPerDay", 100, "GUEST_GLOBAL_RATE_LIMIT", null],
	] as const)(
		"enforces the literal %s limit at N plus one with no rejected business graph",
		async (_label, limitName, limit, expectedCode, sharedField) => {
			const now = guestAdmissionTestTime(100);
			const promotionPeriod = `promotion-${limitName}-${randomUUID()}`;
			const sharedHash = hashFixture(`shared:${limitName}`);
			const isolationOverrides = {
				maximumActiveJobsPerIp: limit + 1,
				maximumRequestsPerIpPerTenMinutes: limit + 1,
				maximumRequestsPerIpPerDay: limit + 1,
				maximumRequestsPerSubnetPerDay: limit + 1,
				maximumGlobalRequestsPerMinute: limit + 1,
				maximumGlobalRequestsPerHour: limit + 1,
				maximumGlobalRequestsPerDay: limit + 1,
				maximumGlobalQueueDepth: limit + 1,
				queueCapacity: limit + 1,
				riskBudgetMicros: BigInt(limit + 1) * 35_000n,
				[limitName]: limit,
			};
			for (let index = 0; index < limit; index += 1) {
				const fixture = await createGuestFixture(
					`limit-${limitName}-${index}`,
					now,
					promotionPeriod,
				);
				await expect(
					createGuestAdmission(
						guestAdmissionInput(fixture, {
							idempotencyKey: `guest-${limitName}-${index}`,
							...isolationOverrides,
							...(sharedField ? { [sharedField]: sharedHash } : {}),
						}),
					),
				).resolves.toMatchObject({ stage: "WAITING" });
			}
			const rejected = await createGuestFixture(
				`limit-${limitName}-rejected`,
				now,
				promotionPeriod,
			);
			const rejectedInput = guestAdmissionInput(rejected, {
				idempotencyKey: `guest-${limitName}-rejected`,
				...isolationOverrides,
				...(sharedField ? { [sharedField]: sharedHash } : {}),
			});

			await expect(createGuestAdmission(rejectedInput)).rejects.toThrow(expectedCode);
			await expect(countGuestBusinessGraph(rejected.ownerId)).resolves.toEqual(
				emptyGuestBusinessGraph(),
			);
			await expect(client.guestMediaTrial.count({ where: { promotionPeriod } })).resolves.toBe(
				limit,
			);
		},
		120_000,
	);

	it("projects admission in capacity waves instead of multiplying every queued job", async () => {
		for (const label of ["wave-a", "wave-b", "wave-c"]) {
			const queued = await createGuestFixture(label);
			await createGuestAdmission(
				guestAdmissionInput(queued, {
					idempotencyKey: `guest-${label}`,
					queueCapacity: 2,
				}),
			);
		}
		const fixture = await createGuestFixture("wave-target");
		const result = await createGuestAdmission(
			guestAdmissionInput(fixture, {
				idempotencyKey: "guest-wave-target",
				queueCapacity: 2,
			}),
		);

		expect(result.projectedDispatchAt).toEqual(new Date(fixture.now.getTime() + 2 * 60_000));
		expect(result.estimateExpiresAt).toEqual(new Date(fixture.now.getTime() + 3 * 60_000));
	});

	it("reprojects a pre-provider replacement from remaining queue capacity", async () => {
		const queued = await createGuestFixture("replacement-blocker");
		await createGuestAdmission(
			guestAdmissionInput(queued, { idempotencyKey: "guest-replacement-blocker" }),
		);
		const fixture = await createGuestFixture("replacement-target");
		const original = await createGuestAdmission(
			guestAdmissionInput(fixture, { idempotencyKey: "guest-replacement-target" }),
		);
		const replacementNow = new Date(fixture.now.getTime() + 10_000);

		const expired = await client.$transaction((tx) =>
			expireGuestJobBeforeProvider({ jobId: original.jobId, now: replacementNow }, tx),
		);
		if (expired.outcome !== "EXPIRED" || !expired.replacementJobId) {
			throw new Error("Expected one bounded guest replacement");
		}
		const [trial, replacement, event] = await Promise.all([
			client.guestMediaTrial.findUniqueOrThrow({ where: { id: original.trialId } }),
			client.generationJob.findUniqueOrThrow({ where: { id: expired.replacementJobId } }),
			client.outboxEvent.findFirstOrThrow({
				where: {
					aggregateId: expired.replacementJobId,
					eventType: "GUEST_GENERATION_ELIGIBLE",
				},
			}),
		]);
		const projectedDispatchAt = new Date(replacementNow.getTime() + 60_000);
		expect(trial).toMatchObject({
			projectedDispatchAt,
			estimateExpiresAt: new Date(replacementNow.getTime() + 2 * 60_000),
		});
		expect(replacement.dispatchEligibleAt).toEqual(projectedDispatchAt);
		expect(event.availableAt).toEqual(projectedDispatchAt);
	});

	it("terminalizes a pre-provider job when replacement projection exceeds immutable expiry", async () => {
		const queued = await createGuestFixture("replacement-expiry-blocker");
		await createGuestAdmission(
			guestAdmissionInput(queued, { idempotencyKey: "guest-replacement-expiry-blocker" }),
		);
		const fixture = await createGuestFixture("replacement-expiry-target");
		const original = await createGuestAdmission(
			guestAdmissionInput(fixture, { idempotencyKey: "guest-replacement-expiry-target" }),
		);
		const replacementNow = new Date(fixture.now.getTime() + 10_000);
		const nearExpiry = new Date(replacementNow.getTime() + 30_000);
		await client.guestMediaTrial.update({
			where: { id: original.trialId },
			data: {
				projectedDispatchAt: replacementNow,
				estimateExpiresAt: nearExpiry,
				expiresAt: nearExpiry,
			},
		});

		await expect(
			client.$transaction((tx) =>
				expireGuestJobBeforeProvider(
					{ jobId: original.jobId, now: replacementNow, serviceTimeMs: 60_000 },
					tx,
				),
			),
		).resolves.toEqual({ outcome: "EXPIRED", jobId: original.jobId });
		const [trial, job, reservation, riskBudget, jobCount, attemptCount] = await Promise.all([
			client.guestMediaTrial.findUniqueOrThrow({ where: { id: original.trialId } }),
			client.generationJob.findUniqueOrThrow({ where: { id: original.jobId } }),
			client.creditReservation.findUniqueOrThrow({ where: { jobId: original.jobId } }),
			client.guestRiskBudgetBucket.findUniqueOrThrow({
				where: {
					promotionPeriod_subjectHash: {
						promotionPeriod: fixture.promotionPeriod,
						subjectHash: "global",
					},
				},
			}),
			client.generationJob.count({ where: { ownerId: fixture.ownerId } }),
			client.generationAttempt.count({ where: { job: { ownerId: fixture.ownerId } } }),
		]);
		expect(trial).toMatchObject({
			currentJobId: null,
			eligibility: "AVAILABLE",
			replacementCount: 0,
			riskState: "RELEASED",
			projectedDispatchAt: replacementNow,
			estimateExpiresAt: nearExpiry,
			expiresAt: nearExpiry,
			terminalAt: replacementNow,
		});
		expect(job).toMatchObject({
			status: "FAILED",
			failureCode: "GUEST_QUEUE_EXPIRED",
			terminalAt: replacementNow,
		});
		expect(reservation).toMatchObject({ status: "RELEASED", releasedAmount: 4n });
		expect(riskBudget).toMatchObject({ reservedMicros: 3_500n });
		expect(jobCount).toBe(1);
		expect(attemptCount).toBe(0);
	});

	it.each([
		["catalog version", { catalogVersion: "catalog-v2" }],
		["pricing version", { pricingVersion: "pricing-v2" }],
		["sponsor credits", { credits: 5n }],
		["maximum route cost", { costMicros: 4500n }],
		["route graph", { pricingSnapshot: { routeGraph: { graphFingerprint: "changed-at-commit" } } }],
	] as const)(
		"rolls back the entire graph when canonical %s changes after preflight",
		async (_label, canonicalOverride) => {
			const slug = _label.replaceAll(" ", "-");
			const fixture = await createGuestFixture(`stale-${slug}`);
			const input = guestAdmissionInput(fixture, { idempotencyKey: `guest-stale-${slug}` });
			const resolveCanonicalQuote = () => ({ ...input.quote, ...canonicalOverride });

			await expect(
				createGuestGenerationTransaction(input, client, resolveCanonicalQuote),
			).rejects.toThrow("GUEST_PRICE_CHANGED");
			await expect(
				Promise.all([
					client.guestAbuseBucket.count({ where: { scope: "guest-turnstile-token" } }),
					client.guestMediaTrial.count({ where: { ownerId: fixture.ownerId } }),
					client.generationQuote.count({ where: { ownerId: fixture.ownerId } }),
					client.generationJob.count({ where: { ownerId: fixture.ownerId } }),
					client.creditAccount.count({ where: { ownerId: fixture.ownerId } }),
				]),
			).resolves.toEqual([0, 0, 0, 0, 0]);
		},
	);

	it("extends aggregate risk expiry through the latest staggered hold", async () => {
		const fixtureNow = new Date();
		const firstFixture = await createGuestFixture("risk-expiry-first", fixtureNow);
		const first = await createGuestAdmission(
			guestAdmissionInput(firstFixture, { idempotencyKey: "guest-risk-expiry-first" }),
		);
		const laterFixture = await createGuestFixture(
			"risk-expiry-later",
			new Date(fixtureNow.getTime() + 60 * 60_000),
		);
		const later = await createGuestAdmission(
			guestAdmissionInput(laterFixture, { idempotencyKey: "guest-risk-expiry-later" }),
		);
		const bucket = await client.guestRiskBudgetBucket.findUniqueOrThrow({
			where: {
				promotionPeriod_subjectHash: {
					promotionPeriod: firstFixture.promotionPeriod,
					subjectHash: "global",
				},
			},
		});

		expect(later.resultExpiresAt.getTime()).toBeGreaterThan(first.resultExpiresAt.getTime());
		expect(bucket.expiresAt).toEqual(later.resultExpiresAt);
	});

	it("rejects a link-fenced draft without creating sponsor or job rows", async () => {
		const fixture = await createGuestFixture("link-fenced");
		await client.guestLinkIntent.create({
			data: {
				claimedDraftId: fixture.draftId,
				anonymousOwnerId: fixture.ownerId,
				promotionPeriod: fixture.promotionPeriod,
				sourceSessionHash: fixture.sourceSessionHash,
				deviceHash: fixture.deviceHash,
				returnPath: "/create",
				state: "LINKING",
				tokenHash: "1".repeat(64),
				idempotencyKey: "link-fenced-intent",
				expiresAt: new Date(fixture.now.getTime() + 15 * 60_000),
			},
		});

		await expect(
			createGuestAdmission(guestAdmissionInput(fixture, { idempotencyKey: "guest-link-fenced" })),
		).rejects.toThrow("GUEST_LINK_IN_PROGRESS");
		await expect(countGuestBusinessGraph(fixture.ownerId)).resolves.toEqual(
			emptyGuestBusinessGraph(),
		);
	});

	it.each([
		["current approved", {}, false, "READY", true] as const,
		["stale provider", { provider: "stale-provider" }, false, "FINISHING", false] as const,
		["stale rule", { ruleVersion: "stale-rule" }, false, "FINISHING", false] as const,
		["stale policy", { policyVersion: "stale-policy" }, false, "FINISHING", false] as const,
		["latest rejected", {}, true, "FINISHING", false] as const,
	])(
		"replays a succeeded admission with %s result evidence",
		async (label, outputVerification, appendRejectedEvidence, expectedStage, expectedReady) => {
			const fixture = await createGuestFixture(`result-replay-${label.replaceAll(" ", "-")}`);
			const input = guestAdmissionInput(fixture, {
				idempotencyKey: `guest-result-replay-${label.replaceAll(" ", "-")}`,
			});
			const admitted = await createGuestAdmission(input);
			const resultAssetId = await finalizeGuestAdmissionResultForReplay({
				fixture,
				jobId: admitted.jobId,
				resultExpiresAt: admitted.resultExpiresAt,
				outputVerification,
				appendRejectedEvidence,
			});

			const replay = await createGuestAdmission(input);

			expect(replay).toMatchObject({
				jobId: admitted.jobId,
				trialId: admitted.trialId,
				stage: expectedStage,
				watermarked: expectedReady,
				resultAssetId: expectedReady ? resultAssetId : null,
			});
		},
	);

	async function createGuestFixture(
		label: string,
		now = new Date(),
		promotionPeriod = "launch-2026-08",
	) {
		const suffix = `${label}-${randomUUID()}`;
		const ownerId = `guest-${suffix}`;
		const sessionId = `session-${suffix}`;
		const sourceSessionHash = hashFixture(`session:${suffix}`);
		const deviceHash = hashFixture(`device:${suffix}`);
		const assetId = `asset-${suffix}`;
		const draftId = `draft-${suffix}`;
		const bootstrapId = `bootstrap-${suffix}`;
		const checksum = hashFixture(`asset:${suffix}`);
		const validUntil = new Date(now.getTime() + 24 * 60 * 60_000);
		await client.user.create({
			data: {
				id: ownerId,
				name: "Guest",
				email: `${suffix}@anonymous.invalid`,
				emailVerified: false,
				isAnonymous: true,
				createdAt: now,
				updatedAt: now,
			},
		});
		await client.session.create({
			data: {
				id: sessionId,
				token: `token-${suffix}`,
				userId: ownerId,
				expiresAt: validUntil,
				createdAt: now,
				updatedAt: now,
			},
		});
		await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				status: "VERIFYING",
				retentionClass: "GUEST_TRIAL",
				deleteAfter: validUntil,
				objectKey: `users/${ownerId}/assets/${assetId}/original.png`,
				mimeType: "image/png",
				byteSize: 1024n,
				checksum,
				finalizedAt: now,
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				verificationProvider: "test",
				verificationProviderTaskId: `moderation-${suffix}`,
				verificationRuleVersion: "media-safety-rule-v1",
				verificationPolicyVersion: "media-safety-policy-v1",
				verificationValidUntil: validUntil,
			},
		});
		await client.assetModerationResult.create({
			data: {
				assetId,
				assetChecksum: checksum,
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "INPUT",
				provider: "test",
				providerTaskId: `moderation-${suffix}`,
				ruleVersion: "media-safety-rule-v1",
				policyVersion: "media-safety-policy-v1",
				status: "APPROVED",
				reasonCode: "ALLOW",
				categories: {},
				rawEnvelope: {},
				validUntil,
				createdAt: now,
			},
		});
		await client.mediaAsset.update({
			where: { id: assetId },
			data: { status: "READY" },
		});
		await client.generationDraft.create({
			data: {
				id: draftId,
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				claimTokenHash: hashFixture(`claim:${suffix}`),
				assetId,
				productKey: "image-fast",
				inputSnapshot: { kind: "image-to-image", prompt: "Make the sky violet" },
				status: "SUBMITTED",
				expiresAt: validUntil,
			},
		});
		await client.guestSessionBootstrap.create({
			data: {
				id: bootstrapId,
				ownerId,
				promotionPeriod,
				claimHash: hashFixture(`bootstrap-claim:${suffix}`),
				idempotencyKey: `bootstrap-idempotency-${suffix}`,
				claimedDraftId: draftId,
				sourceAssetId: assetId,
				createdAt: now,
				expiresAt: validUntil,
				completedAt: now,
			},
		});
		return {
			assetId,
			bootstrapId,
			checksum,
			deviceHash,
			draftId,
			now,
			ownerId,
			promotionPeriod,
			sessionId,
			sourceSessionHash,
			validUntil,
		};
	}

	async function finalizeGuestAdmissionResultForReplay(input: {
		fixture: GuestFixture;
		jobId: string;
		resultExpiresAt: Date;
		outputVerification: Partial<{
			provider: string;
			ruleVersion: string;
			policyVersion: string;
		}>;
		appendRejectedEvidence: boolean;
	}) {
		const suffix = randomUUID();
		const assetId = `result-${suffix}`;
		const checksum = hashFixture(`result:${suffix}`);
		const provider = input.outputVerification.provider ?? "test";
		const ruleVersion = input.outputVerification.ruleVersion ?? "media-safety-rule-v1";
		const policyVersion = input.outputVerification.policyVersion ?? "media-safety-policy-v1";
		const providerTaskId = `moderation-${suffix}`;

		await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId: input.fixture.ownerId,
				kind: "OUTPUT",
				status: "VERIFYING",
				retentionClass: "GUEST_TRIAL",
				deleteAfter: input.resultExpiresAt,
				watermarkVersion: "ezpic-watermark-v1",
				watermarkedAt: input.fixture.now,
				cleanStagingDeletedAt: input.fixture.now,
				objectKey: `users/${input.fixture.ownerId}/assets/${assetId}/watermarked.png`,
				mimeType: "image/png",
				byteSize: 1024n,
				checksum,
				finalizedAt: input.fixture.now,
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				verificationProvider: provider,
				verificationProviderTaskId: providerTaskId,
				verificationRuleVersion: ruleVersion,
				verificationPolicyVersion: policyVersion,
				verificationValidUntil: input.resultExpiresAt,
			},
		});
		await client.assetModerationResult.create({
			data: {
				assetId,
				assetChecksum: checksum,
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "OUTPUT",
				provider,
				providerTaskId,
				ruleVersion,
				policyVersion,
				status: "APPROVED",
				reasonCode: "ALLOW",
				categories: {},
				rawEnvelope: {},
				validUntil: input.resultExpiresAt,
			},
		});
		await client.mediaAsset.update({ where: { id: assetId }, data: { status: "READY" } });
		if (input.appendRejectedEvidence) {
			await client.assetModerationResult.create({
				data: {
					assetId,
					assetChecksum: checksum,
					verificationGeneration: 1,
					attemptNumber: 2,
					evidenceKind: "OUTPUT",
					provider,
					providerTaskId: `${providerTaskId}-rejected`,
					ruleVersion,
					policyVersion,
					status: "REJECTED",
					reasonCode: "POLICY_REJECTED",
					categories: {},
					rawEnvelope: {},
					validUntil: null,
				},
			});
		}
		await client.generationJobAsset.create({
			data: {
				jobId: input.jobId,
				assetId,
				assetChecksum: checksum,
				role: "OUTPUT",
				position: 0,
			},
		});
		await client.generationJob.update({
			where: { id: input.jobId },
			data: { status: "SUCCEEDED", terminalAt: input.fixture.now },
		});
		await client.guestMediaTrial.update({
			where: {
				ownerId_promotionPeriod: {
					ownerId: input.fixture.ownerId,
					promotionPeriod: input.fixture.promotionPeriod,
				},
			},
			data: {
				eligibility: "CONSUMED",
				currentJobId: null,
				consumedJobId: input.jobId,
				riskState: "COMMITTED",
				providerBoundaryAt: input.fixture.now,
				consumedAt: input.fixture.now,
				terminalAt: input.fixture.now,
			},
		});
		return assetId;
	}
});

interface GuestFixture {
	assetId: string;
	bootstrapId: string;
	checksum: string;
	deviceHash: string;
	draftId: string;
	now: Date;
	ownerId: string;
	promotionPeriod: string;
	sessionId: string;
	sourceSessionHash: string;
	validUntil: Date;
}

function guestAdmissionInput(
	fixture: GuestFixture,
	overrides: {
		idempotencyKey: string;
		abuseEvidenceTtlMs?: number;
		maximumRequestsPerMinute?: number;
		maximumGlobalRequestsPerMinute?: number;
		maximumGlobalQueueDepth?: number;
		queueTtlMs?: number;
		queueCapacity?: number;
		riskBudgetMicros?: bigint;
		sourceSessionHash?: string;
		deviceHash?: string;
		ipHash?: string;
		subnetHash?: string;
		maximumActiveJobsPerGuest?: number;
		maximumAcceptedTrialsPerSession?: number;
		maximumActiveJobsPerDevice?: number;
		maximumAcceptedTrialsPerDevicePromotion?: number;
		maximumActiveJobsPerIp?: number;
		maximumRequestsPerIpPerTenMinutes?: number;
		maximumRequestsPerIpPerDay?: number;
		maximumRequestsPerSubnetPerDay?: number;
		maximumGlobalRequestsPerHour?: number;
		maximumGlobalRequestsPerDay?: number;
	},
) {
	const quoteBase = {
		ownerType: "USER" as const,
		ownerId: fixture.ownerId,
		submittedByUserId: fixture.ownerId,
		productKey: "image-fast",
		catalogVersion: "catalog-v1",
		pricingVersion: "pricing-v1",
		credits: 4n,
		costMicros: 3500n,
		inputSnapshot: {
			kind: "image-to-image",
			prompt: "Make the sky violet",
			sourceAssetId: fixture.assetId,
		},
		pricingSnapshot: { settlementPolicy: { maxCharge: "4" } },
		expiresAt: new Date(fixture.now.getTime() + 10 * 60_000),
	};
	return {
		ownerId: fixture.ownerId,
		promotionPeriod: fixture.promotionPeriod,
		capabilityVersion: "guest-v7",
		sourceSessionHash: overrides.sourceSessionHash ?? fixture.sourceSessionHash,
		deviceHash: overrides.deviceHash ?? fixture.deviceHash,
		ipHash: overrides.ipHash ?? hashFixture(`ip:${fixture.ownerId}`),
		subnetHash: overrides.subnetHash ?? hashFixture(`subnet:${fixture.ownerId}`),
		idempotencyKey: overrides.idempotencyKey,
		idempotencyFingerprint: hashFixture(`admission:${overrides.idempotencyKey}`),
		turnstile: {
			tokenHash: hashFixture(`turnstile:${overrides.idempotencyKey}`),
			challengeTimestamp: fixture.now,
			expiresAt: new Date(fixture.now.getTime() + 5 * 60_000),
		},
		sourceDraftId: fixture.draftId,
		sourceBootstrapId: fixture.bootstrapId,
		sourceAssetId: fixture.assetId,
		sourceAssetChecksum: fixture.checksum,
		now: fixture.now,
		retentionMs: 24 * 60 * 60_000,
		queueTtlMs: overrides.queueTtlMs ?? 10 * 60_000,
		serviceTimeMs: 60_000,
		queueCapacity: overrides.queueCapacity ?? 1,
		maximumBytes: 10 * 1024 * 1024,
		maximumGlobalQueueDepth: overrides.maximumGlobalQueueDepth ?? 100,
		maximumActiveJobsPerGuest: overrides.maximumActiveJobsPerGuest ?? 1,
		maximumRequestsPerMinute: overrides.maximumRequestsPerMinute ?? 100,
		maximumRequestsPerIpPerHour: 100,
		maximumAcceptedTrialsPerSession: overrides.maximumAcceptedTrialsPerSession ?? 1,
		maximumActiveJobsPerDevice: overrides.maximumActiveJobsPerDevice ?? 1,
		maximumAcceptedTrialsPerDevicePromotion: overrides.maximumAcceptedTrialsPerDevicePromotion ?? 1,
		maximumActiveJobsPerIp: overrides.maximumActiveJobsPerIp ?? 2,
		maximumRequestsPerIpPerTenMinutes: overrides.maximumRequestsPerIpPerTenMinutes ?? 100,
		maximumRequestsPerIpPerDay: overrides.maximumRequestsPerIpPerDay ?? 100,
		maximumRequestsPerSubnetPerDay: overrides.maximumRequestsPerSubnetPerDay ?? 100,
		maximumGlobalRequestsPerMinute:
			overrides.maximumGlobalRequestsPerMinute ?? overrides.maximumRequestsPerMinute ?? 100,
		maximumGlobalRequestsPerHour: overrides.maximumGlobalRequestsPerHour ?? 100,
		maximumGlobalRequestsPerDay: overrides.maximumGlobalRequestsPerDay ?? 100,
		abuseEvidenceTtlMs: overrides.abuseEvidenceTtlMs ?? 30 * 24 * 60 * 60_000,
		riskBudgetMicros: overrides.riskBudgetMicros ?? 350_000n,
		sponsorCredits: 4n,
		assetModeration: {
			provider: "test",
			ruleVersion: "media-safety-rule-v1",
			policyVersion: "media-safety-policy-v1",
		},
		quote: {
			...quoteBase,
			moderation: {
				decision: "ALLOW" as const,
				provider: "test",
				ruleVersion: "text-safety-2026-08-14.1",
				reasonCode: "ALLOW",
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteBase),
			},
		},
	};
}

function createGuestAdmission(input: ReturnType<typeof guestAdmissionInput>) {
	return createGuestGenerationTransaction(input, client, () => ({
		productKey: input.quote.productKey,
		catalogVersion: input.quote.catalogVersion,
		pricingVersion: input.quote.pricingVersion,
		credits: input.quote.credits,
		costMicros: input.quote.costMicros,
		pricingSnapshot: input.quote.pricingSnapshot,
	}));
}

async function countGuestBusinessGraph(ownerId: string) {
	const account = await client.creditAccount.findUnique({
		where: { ownerType_ownerId: { ownerType: "USER", ownerId } },
		select: { id: true },
	});
	const jobIds = (
		await client.generationJob.findMany({ where: { ownerId }, select: { id: true } })
	).map((job) => job.id);
	const [trials, quotes, accounts, lots, ledgers, reservations, jobs, outbox, attempts] =
		await Promise.all([
			client.guestMediaTrial.count({ where: { ownerId } }),
			client.generationQuote.count({ where: { ownerId } }),
			client.creditAccount.count({ where: { ownerId } }),
			account ? client.creditLot.count({ where: { accountId: account.id } }) : 0,
			account ? client.creditLedgerEntry.count({ where: { accountId: account.id } }) : 0,
			jobIds.length ? client.creditReservation.count({ where: { jobId: { in: jobIds } } }) : 0,
			client.generationJob.count({ where: { ownerId } }),
			jobIds.length ? client.outboxEvent.count({ where: { aggregateId: { in: jobIds } } }) : 0,
			client.generationAttempt.count({ where: { job: { ownerId } } }),
		]);
	return { trials, quotes, accounts, lots, ledgers, reservations, jobs, outbox, attempts };
}

function emptyGuestBusinessGraph() {
	return {
		trials: 0,
		quotes: 0,
		accounts: 0,
		lots: 0,
		ledgers: 0,
		reservations: 0,
		jobs: 0,
		outbox: 0,
		attempts: 0,
	};
}

async function concurrentSettledBarrier<T>(operations: Array<() => Promise<T>>) {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const contenders = operations.map(async (operation) => {
		await gate;
		return operation();
	});
	release();
	return Promise.allSettled(contenders);
}

async function concurrentBarrier<T>(count: number, operation: () => Promise<T>): Promise<T[]> {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const contenders = Array.from({ length: count }, async () => {
		await gate;
		return operation();
	});
	release();
	return Promise.all(contenders);
}

function hashFixture(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeTestDatabaseUrl(): string {
	if (!TEST_DATABASE_URL) throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
	if (DATABASE_URL && TEST_DATABASE_URL === DATABASE_URL) {
		throw new Error("UNSAFE_TEST_DATABASE: TEST_DATABASE_URL must not equal DATABASE_URL");
	}
	const parsed = new URL(TEST_DATABASE_URL);
	const databaseName = parsed.pathname.slice(1).toLowerCase();
	if (
		!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
		!/(^|[_-])(test|testing)([_-]|$)/.test(databaseName)
	) {
		throw new Error("UNSAFE_TEST_DATABASE: expected a disposable loopback test database");
	}
	return TEST_DATABASE_URL;
}
