import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createPreReviewedAdmissionFixture } from "../../../test-support/pre-reviewed-admission-fixture";
import { PrismaClient, type Prisma } from "../../generated/client";
import { getCreditInvariantReport } from "./credits";
import { claimImagePhaseOwnerInTransaction } from "./image-phase-ownership";
import { createGenerationJobTransaction } from "./jobs";
import { applyAdminModerationReview } from "./moderation-operations";
import { fingerprintGenerationQuoteSecurityPayload } from "./quotes";
import type { MediaTransactionClient } from "./types";

let client: PrismaClient;
const states = ["unstarted", "claimed", "submitting", "bound", "pending", "querying"] as const;
type PendingState = (typeof states)[number];
type Fixture = Awaited<ReturnType<typeof createPreReviewedAdmissionFixture>>;

function isolatedUrl() {
	const value = process.env.TEST_DATABASE_URL;
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const url = new URL(value);
	if (
		!["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
		!/(^|[_-])test([_-]|$)/.test(url.pathname.slice(1)) ||
		value === process.env.DATABASE_URL
	)
		throw new Error("ISOLATED_LOCAL_TEST_DATABASE_REQUIRED");
	return value;
}

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function observed(
	isolation: string[],
	hooks: {
		pid?: (value: number) => void;
		beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void>;
	} = {},
): MediaTransactionClient {
	return new Proxy(client, {
		get(target, key, receiver) {
			if (key === "$transaction")
				return (
					operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
					options?: {
						isolationLevel?: Prisma.TransactionIsolationLevel;
						maxWait?: number;
						timeout?: number;
					},
				) => {
					isolation.push(options?.isolationLevel ?? "default");
					return target.$transaction(async (tx) => {
						if (hooks.pid) {
							const [row] = await tx.$queryRaw<
								Array<{ pid: number }>
							>`SELECT pg_backend_pid() AS pid`;
							hooks.pid(row!.pid);
						}
						const result = await operation(tx);
						await hooks.beforeCommit?.(tx);
						return result;
					}, options);
				};
			return Reflect.get(target, key, receiver);
		},
	}) as MediaTransactionClient;
}

async function waitForLock(pids: number[]) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (pids[0]) {
			const [row] = await client.$queryRaw<Array<{ blocked: boolean }>>`
				SELECT cardinality(pg_blocking_pids(${pids[0]}::integer)) > 0 AS blocked`;
			if (row?.blocked) return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("PENDING_ADMISSION_LOCK_WAIT_NOT_OBSERVED");
}

async function pendingFixture(state: PendingState = "pending", amount = 100n) {
	const f = await createPreReviewedAdmissionFixture(client, {
		prefix: "pending-admission",
		amount,
		reviewStatus: state === "pending" || state === "querying" ? "PENDING" : "NOT_STARTED",
	});
	const [clock] = await client.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
	if (["claimed", "submitting", "bound", "querying"].includes(state)) {
		await client.mediaAsset.update({
			where: { id: f.asset.id },
			data: {
				verificationAttemptCount: state === "querying" ? 2 : 1,
				verificationLeaseToken: crypto.randomUUID(),
				verificationLeasedUntil: new Date(clock!.now.getTime() + 60_000),
				verificationNextAttemptAt: null,
				verificationLastErrorCode: null,
				...(state === "submitting" || state === "bound"
					? {
							verificationSubmissionToken: crypto.randomUUID(),
							verificationSubmittedAt: clock!.now,
							verificationSubmissionUncertain: state === "submitting",
							verificationProviderTaskId: state === "bound" ? `${f.asset.id}:review` : null,
						}
					: {}),
			},
		});
	}
	if (state !== "unstarted") {
		await client.$transaction(async (tx) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${f.asset.id}`}, 0))`;
			await claimImagePhaseOwnerInTransaction(
				{
					phase: { kind: "verification", assetId: f.asset.id, generation: 1 },
					workflowId: `original-review-${f.asset.id}`,
				},
				tx,
			);
		});
	}
	return f;
}

async function reviewState(f: Fixture) {
	return {
		asset: await client.mediaAsset.findUniqueOrThrow({ where: { id: f.asset.id } }),
		events: await client.outboxEvent.findMany({
			where: { aggregateId: f.asset.id },
			orderBy: { id: "asc" },
		}),
		evidence: await client.assetModerationResult.findMany({
			where: { assetId: f.asset.id },
			orderBy: { id: "asc" },
		}),
		owners: await client.mediaWorkflowPhaseOwner.findMany({ where: { subjectId: f.asset.id } }),
	};
}

async function expectNoAdmission(f: Fixture) {
	expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
	expect(await client.generationQuote.count({ where: { ownerId: f.ownerId } })).toBe(0);
	expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
	expect(
		await client.creditLedgerEntry.count({ where: { accountId: f.account.id, type: "RESERVE" } }),
	).toBe(0);
	expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
}

describe("pending temporary image admission with PostgreSQL", () => {
	beforeEach(() => vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", "true"));
	afterEach(() => vi.unstubAllEnvs());
	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: isolatedUrl(), max: 60 }),
		});
	});
	afterAll(async () => {
		await client?.$disconnect();
	});

	it.each(states)(
		"binds a waiting job in the %s review phase without changing its attempt, owner or evidence",
		async (state) => {
			const f = await pendingFixture(state);
			const before = await reviewState(f);
			const isolation: string[] = [];
			const result = await createGenerationJobTransaction(f.input(), observed(isolation));
			expect(isolation).toEqual(["ReadCommitted"]);
			expect(result).toMatchObject({
				job: { status: "RESERVED", creditsReserved: 5n },
				verificationAssetId: f.asset.id,
				continuationEventIds: [f.reviewEvent!.id],
				replayed: false,
			});
			expect(await reviewState(f)).toEqual(before);
			expect(await client.generationAttempt.count({ where: { jobId: result.job.id } })).toBe(0);
			expect(
				await client.generationJobAsset.findMany({ where: { jobId: result.job.id } }),
			).toMatchObject([
				{ assetId: f.asset.id, assetChecksum: f.reference.checksum, role: "INPUT" },
			]);
			expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({
				valid: true,
				account: { spendable: 95n, reserved: 5n, debt: 0n },
			});
			// An unknown submission may already have crashed or timed out. Admission
			// only adds a waiter; it cannot prove HTTP liveness or clear that uncertainty.
			if (state === "submitting") expect(before.asset.verificationSubmissionUncertain).toBe(true);
		},
	);

	it("admits 50 independent owners across real pending phases without a Serializable restart", async () => {
		const fixtures: Fixture[] = [];
		for (let index = 0; index < 50; index++)
			fixtures.push(await pendingFixture(states[index % states.length]!));
		const before = await Promise.all(fixtures.map(reviewState));
		const isolation = fixtures.map(() => [] as string[]);
		const results = await Promise.allSettled(
			fixtures.map((f, index) =>
				createGenerationJobTransaction(f.input(), observed(isolation[index]!)),
			),
		);
		expect(
			results
				.filter((result) => result.status === "rejected")
				.map((result) => ({ code: result.reason?.code, message: result.reason?.message })),
		).toEqual([]);
		for (const [index, result] of results.entries()) {
			if (result.status !== "fulfilled") throw result.reason;
			const f = fixtures[index]!;
			expect(isolation[index]).toEqual(["ReadCommitted"]);
			expect(result.value).toMatchObject({
				verificationAssetId: f.asset.id,
				continuationEventIds: [f.reviewEvent!.id],
				job: { status: "RESERVED" },
			});
			expect(await reviewState(f)).toEqual(before[index]);
			expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(1);
			expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
			expect(await client.generationAttempt.count({ where: { jobId: result.value.job.id } })).toBe(
				0,
			);
			expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
		}
	});

	it("replays the same pending request with one reservation and the original review event", async () => {
		const f = await pendingFixture("submitting");
		const before = await reviewState(f);
		const input = f.input();
		const isolation: string[] = [];
		const results = await Promise.allSettled([
			createGenerationJobTransaction(input, observed(isolation)),
			createGenerationJobTransaction(input, observed(isolation)),
		]);
		expect(results.every((result) => result.status === "fulfilled")).toBe(true);
		expect(
			new Set(
				results.flatMap((result) => (result.status === "fulfilled" ? [result.value.job.id] : [])),
			),
		).toHaveProperty("size", 1);
		expect(
			results.filter((result) => result.status === "fulfilled" && result.value.replayed),
		).toHaveLength(1);
		expect(isolation).toEqual(["ReadCommitted", "ReadCommitted"]);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
		expect(await reviewState(f)).toEqual(before);
	});

	it("keeps the last-credit account bound when pending admissions race", async () => {
		const f = await pendingFixture("pending", 5n);
		const isolation: string[] = [];
		const results = await Promise.allSettled([
			createGenerationJobTransaction(f.input(), observed(isolation)),
			createGenerationJobTransaction(f.input(f.prepare(":second")), observed(isolation)),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(
			results
				.filter((result) => result.status === "rejected")
				.map((result) => result.reason.message),
		).toEqual(["INSUFFICIENT_CREDITS"]);
		expect(isolation).toEqual(["ReadCommitted", "ReadCommitted"]);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({
			valid: true,
			account: { spendable: 0n, reserved: 5n, debt: 0n },
		});
	});

	it.each([
		"expired unknown lease",
		"durable error history",
		"mismatched pending evidence",
		"disabled rollout",
	])("retains the historical isolation for %s without resetting review identity", async (state) => {
		const f = await pendingFixture(state === "expired unknown lease" ? "submitting" : "pending");
		if (state === "disabled rollout") vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", "false");
		if (state === "expired unknown lease") {
			const [clock] = await client.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
			await client.mediaAsset.update({
				where: { id: f.asset.id },
				data: { verificationLeasedUntil: new Date(clock!.now.getTime() - 1000) },
			});
		}
		if (state === "durable error history" || state === "mismatched pending evidence") {
			const asset = await client.mediaAsset.findUniqueOrThrow({ where: { id: f.asset.id } });
			await client.assetModerationResult.create({
				data: {
					assetId: asset.id,
					assetChecksum: state === "mismatched pending evidence" ? "f".repeat(64) : asset.checksum,
					verificationGeneration: 1,
					attemptNumber: 2,
					evidenceKind: "INPUT",
					provider: asset.verificationProvider!,
					providerTaskId: asset.verificationProviderTaskId,
					ruleVersion: asset.verificationRuleVersion!,
					policyVersion: asset.verificationPolicyVersion!,
					status: state === "durable error history" ? "ERROR" : "PENDING",
					reasonCode:
						state === "durable error history"
							? "MODERATION_PROVIDER_UNAVAILABLE"
							: "IMAGE_PROCESSING",
					categories: {},
					rawEnvelope: {},
				},
			});
			await client.mediaAsset.update({
				where: { id: asset.id },
				data: {
					verificationAttemptCount: 2,
					...(state === "durable error history"
						? { verificationLastErrorCode: "MODERATION_PROVIDER_UNAVAILABLE" }
						: {}),
				},
			});
		}
		const before = await reviewState(f);
		const isolation: string[] = [];
		const result = await createGenerationJobTransaction(f.input(), observed(isolation));
		expect(isolation).toEqual(
			state === "disabled rollout" ? ["Serializable"] : ["ReadCommitted", "Serializable"],
		);
		expect(result.verificationAssetId).toBe(f.asset.id);
		expect(await reviewState(f)).toEqual(before);
		expect(await client.generationAttempt.count({ where: { jobId: result.job.id } })).toBe(0);
	});

	it.each([
		{ checksum: "c".repeat(64) },
		{ ownerId: "another-owner" },
		{ verificationPolicyVersion: "stale-policy" },
		{ status: "QUARANTINED" as const },
	])(
		"rejects changed pending identity or terminal state before reserving credits: %s",
		async (change) => {
			const f = await pendingFixture();
			await client.mediaAsset.update({ where: { id: f.asset.id }, data: change });
			await expect(createGenerationJobTransaction(f.input(), client)).rejects.toThrow();
			await expectNoAdmission(f);
		},
	);

	it.each(["RECHECK", "REJECT"] as const)(
		"observes an administrator %s committed before its verification fence",
		async (action) => {
			const f = await pendingFixture();
			const review = await client.moderationReview.create({
				data: {
					targetType: "ASSET",
					targetId: f.asset.id,
					provider: "seeapi",
					stage: "IMAGE",
					status: "PENDING_REVIEW",
					attemptEpoch: "1",
					lastErrorCode: "MANUAL_REVIEW_REQUESTED",
					firstFailureAt: new Date(),
					lastFailureAt: new Date(),
				},
			});
			const entered = gate();
			const release = gate();
			const admin = applyAdminModerationReview(
				{
					reviewId: review.id,
					version: review.version,
					action,
					reason: "Pending admission race",
					idempotencyKey: `${f.asset.id}:${action}`,
					actorUserId: "fixture-admin",
					verification: {
						provider: "seeapi",
						ruleVersion: "test-asset-rule",
						policyVersion: "test-asset-policy",
					},
				},
				observed([], {
					beforeCommit: async () => {
						entered.release();
						await release.promise;
					},
				}),
			);
			const adminOutcome = Promise.allSettled([admin]);
			let admission:
				| Promise<
						PromiseSettledResult<Awaited<ReturnType<typeof createGenerationJobTransaction>>>[]
				  >
				| undefined;
			const isolation: string[] = [];
			try {
				await Promise.race([
					entered.promise,
					admin.then(() => {
						throw new Error("ADMIN_BARRIER_NOT_REACHED");
					}),
				]);
				const pids: number[] = [];
				admission = Promise.allSettled([
					createGenerationJobTransaction(
						f.input(),
						observed(isolation, { pid: (pid) => pids.push(pid) }),
					),
				]);
				await waitForLock(pids);
			} finally {
				release.release();
				await Promise.all([adminOutcome, admission]);
			}
			expect((await adminOutcome)[0]!.status).toBe("fulfilled");
			const result = (await admission!)[0]!;
			if (action === "REJECT") {
				expect(result).toMatchObject({ status: "rejected" });
				await expectNoAdmission(f);
			} else {
				expect(result).toMatchObject({
					status: "fulfilled",
					value: { verificationAssetId: f.asset.id },
				});
				expect(isolation).toEqual(["ReadCommitted", "Serializable"]);
				expect(await client.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
					verificationGeneration: 2,
					status: "VERIFYING",
				});
			}
		},
	);

	it.each(["APPROVE", "REJECT"] as const)(
		"lets a waiting terminal %s writer observe the newly committed job binding",
		async (action) => {
			const f = await pendingFixture();
			const review = await client.moderationReview.create({
				data: {
					targetType: "ASSET",
					targetId: f.asset.id,
					provider: "seeapi",
					stage: "IMAGE",
					status: "PENDING_REVIEW",
					attemptEpoch: "1",
					lastErrorCode: "MANUAL_REVIEW_REQUESTED",
					firstFailureAt: new Date(),
					lastFailureAt: new Date(),
				},
			});
			const entered = gate();
			const release = gate();
			const admission = createGenerationJobTransaction(
				f.input(),
				observed([], {
					beforeCommit: async () => {
						entered.release();
						await release.promise;
					},
				}),
			);
			const admissionOutcome = Promise.allSettled([admission]);
			let terminal:
				| Promise<PromiseSettledResult<Awaited<ReturnType<typeof applyAdminModerationReview>>>[]>
				| undefined;
			const idempotencyKey = `${f.asset.id}:after-admission:${action}`;
			try {
				await Promise.race([
					entered.promise,
					admission.then(() => {
						throw new Error("ADMISSION_BARRIER_NOT_REACHED");
					}),
				]);
				const pids: number[] = [];
				terminal = Promise.allSettled([
					applyAdminModerationReview(
						{
							reviewId: review.id,
							version: review.version,
							action,
							reason: "Terminal verdict after pending admission",
							idempotencyKey,
							actorUserId: "fixture-admin",
							verification: {
								provider: "seeapi",
								ruleVersion: "test-asset-rule",
								policyVersion: "test-asset-policy",
							},
						},
						observed([], { pid: (pid) => pids.push(pid) }),
					),
				]);
				await waitForLock(pids);
			} finally {
				release.release();
				await Promise.all([admissionOutcome, terminal]);
			}
			expect((await terminal!)[0]!.status).toBe("fulfilled");
			const result = (await admissionOutcome)[0]!;
			if (result.status !== "fulfilled") throw result.reason;
			expect(
				await client.outboxEvent.findUnique({
					where: { dedupeKey: `moderation-resume:${idempotencyKey}:${result.value.job.id}` },
				}),
			).toMatchObject({ aggregateId: result.value.job.id });
			expect(await client.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
				status: action === "APPROVE" ? "READY" : "QUARANTINED",
			});
			expect(await client.generationAttempt.count({ where: { jobId: result.value.job.id } })).toBe(
				0,
			);
			expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
		},
	);

	it.each(["review deadline", "quote deadline", "reference deadline"])(
		"rejects a %s crossed while waiting for credits",
		async (deadline) => {
			const f = await pendingFixture();
			const [clock] = await client.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
			const expiresAt = new Date(clock!.now.getTime() + 1000);
			if (deadline === "reference deadline") {
				f.reference.expiresAt = expiresAt.toISOString();
				f.reference.createdAt = new Date(expiresAt.getTime() - 86_400_000).toISOString();
				await client.storageUsageReservation.update({
					where: { referenceKey: `temporary-reference:${f.asset.id}` },
					data: { expiresAt },
				});
				await client.mediaAsset.update({
					where: { id: f.asset.id },
					data: { deleteAfter: expiresAt },
				});
			}
			const input = f.input();
			if (deadline === "review deadline")
				await client.mediaAsset.update({
					where: { id: f.asset.id },
					data: { verificationDeadlineAt: expiresAt },
				});
			else if (deadline === "quote deadline") {
				input.preparedQuote!.expiresAt = expiresAt;
				input.preparedQuote!.moderation.inputFingerprint =
					fingerprintGenerationQuoteSecurityPayload(input.preparedQuote!);
			}
			const entered = gate();
			const release = gate();
			const holder = client.$transaction(
				async (tx) => {
					await tx.$queryRaw`SELECT id FROM credit_account WHERE id = ${f.account.id} FOR UPDATE`;
					entered.release();
					await release.promise;
				},
				{ timeout: 20_000 },
			);
			const holderOutcome = Promise.allSettled([holder]);
			let admission:
				| Promise<
						PromiseSettledResult<Awaited<ReturnType<typeof createGenerationJobTransaction>>>[]
				  >
				| undefined;
			try {
				await Promise.race([
					entered.promise,
					holder.then(() => {
						throw new Error("CREDIT_BARRIER_NOT_REACHED");
					}),
				]);
				const pids: number[] = [];
				admission = Promise.allSettled([
					createGenerationJobTransaction(input, observed([], { pid: (pid) => pids.push(pid) })),
				]);
				await waitForLock(pids);
				for (;;) {
					const [clock] = await client.$queryRaw<
						Array<{ expired: boolean }>
					>`SELECT clock_timestamp() >= ${expiresAt}::timestamptz AS expired`;
					if (clock!.expired) break;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
			} finally {
				release.release();
				await Promise.all([holderOutcome, admission]);
			}
			expect((await admission!)[0]).toMatchObject({
				status: "rejected",
				reason: {
					message:
						deadline === "review deadline"
							? "ASSET_MODERATION_EVIDENCE_STALE"
							: deadline === "reference deadline"
								? "TEMPORARY_REFERENCE_EXPIRED"
								: "Quote expired",
				},
			});
			await expectNoAdmission(f);
		},
	);
});
