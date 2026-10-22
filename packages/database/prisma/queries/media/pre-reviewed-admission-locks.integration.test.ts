import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createPreReviewedAdmissionFixture } from "../../../test-support/pre-reviewed-admission-fixture";
import { PrismaClient, type Prisma } from "../../generated/client";
import { markMediaAssetDeletedTransaction } from "./assets";
import { createGenerationJobTransaction } from "./jobs";
import { applyAdminModerationReview } from "./moderation-operations";
import { isDatabaseSerializationConflict } from "./types";

let client: PrismaClient;
type Fixture = Awaited<ReturnType<typeof createPreReviewedAdmissionFixture>>;

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

function barrier() {
	let arrive!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => (arrive = resolve));
	const released = new Promise<void>((resolve) => (release = resolve));
	return {
		entered,
		release,
		async wait() {
			arrive();
			await released;
		},
	};
}

async function reached(gate: ReturnType<typeof barrier>) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			gate.entered,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("TRANSACTION_BARRIER_NOT_REACHED")), 5000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function capture<T>(promise: Promise<T>) {
	return promise.then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
}

function observedClient(
	hooks: {
		isolation?: string[];
		pids?: number[];
		before?: (tx: Prisma.TransactionClient) => Promise<void>;
		beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void>;
		conflict?: () => void;
	} = {},
) {
	return new Proxy(client, {
		get(target, key, receiver) {
			if (key === "$transaction")
				return async (
					operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
					options?: {
						isolationLevel?: Prisma.TransactionIsolationLevel;
						maxWait?: number;
						timeout?: number;
					},
				) => {
					hooks.isolation?.push(options?.isolationLevel ?? "ReadCommitted");
					try {
						return await target.$transaction(async (tx) => {
							const [row] = await tx.$queryRaw<Array<{ pid: number }>>`
								SELECT pg_backend_pid() AS pid`;
							hooks.pids?.push(row!.pid);
							await hooks.before?.(tx);
							const result = await operation(tx);
							await hooks.beforeCommit?.(tx);
							return result;
						}, options);
					} catch (error) {
						if (isDatabaseSerializationConflict(error)) hooks.conflict?.();
						throw error;
					}
				};
			return Reflect.get(target, key, receiver);
		},
	});
}

async function waitForBlocked(pids: number[]) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (pids[0]) {
			const [row] = await client.$queryRaw<Array<{ blocked: boolean }>>`
				SELECT cardinality(pg_blocking_pids(${pids[0]}::integer)) > 0 AS blocked`;
			if (row?.blocked) return;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("EXPECTED_DATABASE_LOCK_WAIT_NOT_OBSERVED");
}

async function expectAdmissionRolledBack(f: Fixture) {
	expect(await client.generationQuote.count({ where: { ownerId: f.ownerId } })).toBe(0);
	expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
	expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
	expect(
		await client.creditLedgerEntry.count({ where: { accountId: f.account.id, type: "RESERVE" } }),
	).toBe(0);
	expect(await client.creditAccount.findUnique({ where: { id: f.account.id } })).toMatchObject({
		spendableCredits: 100n,
		reservedCredits: 0n,
	});
}

async function adminInput(f: Fixture, action: "RECHECK" | "REJECT" | "APPROVE") {
	const now = new Date();
	const review = await client.moderationReview.create({
		data: {
			targetType: "ASSET",
			targetId: f.asset.id,
			provider: "seeapi",
			stage: "IMAGE",
			status: "PENDING_REVIEW",
			attemptEpoch: "1",
			lastErrorCode: "MANUAL_REVIEW_REQUESTED",
			firstFailureAt: now,
			lastFailureAt: now,
		},
	});
	return {
		reviewId: review.id,
		version: review.version,
		action,
		reason: "Exercise the immutable temporary input admission race",
		idempotencyKey: `${f.asset.id}:${action}`,
		actorUserId: "pre-reviewed-lock-test-admin",
		verification: {
			provider: "seeapi",
			ruleVersion: "test-asset-rule",
			policyVersion: "test-asset-policy",
		},
	};
}

async function appendApproval(
	f: Fixture,
	options: { generation?: number; validUntil?: Date; reasonCode?: string } = {},
) {
	const generation = options.generation ?? 1;
	const attemptNumber = generation === 1 ? 2 : 1;
	const validUntil = options.validUntil ?? f.asset.verificationValidUntil!;
	await client.$transaction(async (tx) => {
		await tx.assetModerationResult.create({
			data: {
				assetId: f.asset.id,
				assetChecksum: f.asset.checksum,
				verificationGeneration: generation,
				attemptNumber,
				evidenceKind: "INPUT",
				provider: f.asset.verificationProvider!,
				providerTaskId: f.asset.verificationProviderTaskId,
				ruleVersion: f.asset.verificationRuleVersion!,
				policyVersion: f.asset.verificationPolicyVersion!,
				status: "APPROVED",
				reasonCode: options.reasonCode ?? "NO_POLICY_MATCH",
				categories: {},
				rawEnvelope: { decision: "ALLOW" },
				validUntil,
			},
		});
		await tx.mediaAsset.update({
			where: { id: f.asset.id },
			data: {
				verificationGeneration: generation,
				verificationAttemptCount: attemptNumber,
				verificationValidUntil: validUntil,
			},
		});
	});
}

describe("pre-reviewed temporary admission lock and expiry boundaries", () => {
	beforeAll(() => {
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString: isolatedUrl() }) });
	});
	beforeEach(() => vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", "true"));
	afterEach(() => vi.unstubAllEnvs());
	afterAll(async () => client?.$disconnect());

	it.each(["READY", "PENDING"] as const)(
		"forces an older Serializable deletion snapshot to retry and see the committed %s RC binding",
		async (state) => {
			const f = await createPreReviewedAdmissionFixture(client, {
				prefix: "pre-reviewed-delete-old",
				...(state === "PENDING" ? { reviewStatus: "PENDING" as const } : {}),
			});
			const snapshot = barrier();
			const admissionCommit = barrier();
			const deletingPids: number[] = [];
			let firstAttempt = true;
			let conflicts = 0;
			const deletion = capture(
				markMediaAssetDeletedTransaction(
					{ ownerId: f.ownerId, assetId: f.asset.id },
					observedClient({
						pids: deletingPids,
						conflict: () => conflicts++,
						before: async (tx) => {
							if (!firstAttempt) return;
							firstAttempt = false;
							await tx.$queryRaw`SELECT id FROM media_asset WHERE id = ${f.asset.id}`;
							await snapshot.wait();
						},
					}),
				),
			);
			let admission: Promise<unknown> | undefined;
			try {
				await reached(snapshot);
				const isolation: string[] = [];
				admission = capture(
					createGenerationJobTransaction(
						f.input(),
						observedClient({ isolation, beforeCommit: () => admissionCommit.wait() }),
					),
				);
				await reached(admissionCommit);
				snapshot.release();
				await waitForBlocked(deletingPids);
				admissionCommit.release();
				expect(await admission).toHaveProperty("value");
				expect(await deletion).toMatchObject({
					error: { message: "MEDIA_ASSET_BOUND_TO_ACTIVE_GENERATION_JOB" },
				});
				expect(conflicts).toBeGreaterThan(0);
				expect(isolation).toEqual(["ReadCommitted"]);
				expect(await client.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
					status: state === "PENDING" ? "VERIFYING" : "READY",
					deletedAt: null,
				});
			} finally {
				snapshot.release();
				admissionCommit.release();
				await Promise.allSettled([deletion, admission]);
			}
		},
	);

	it("rolls admission back when deletion commits before the binding lock is granted", async () => {
		const f = await createPreReviewedAdmissionFixture(client, {
			prefix: "pre-reviewed-delete-first",
		});
		const deletionCommit = barrier();
		const deletion = capture(
			markMediaAssetDeletedTransaction(
				{ ownerId: f.ownerId, assetId: f.asset.id },
				observedClient({ beforeCommit: () => deletionCommit.wait() }),
			),
		);
		let admission: Promise<unknown> | undefined;
		try {
			await reached(deletionCommit);
			const pids: number[] = [];
			admission = capture(createGenerationJobTransaction(f.input(), observedClient({ pids })));
			await waitForBlocked(pids);
			deletionCommit.release();
			expect(await deletion).toHaveProperty("value");
			expect(await admission).toMatchObject({ error: { message: "ASSET_NOT_READY" } });
			await expectAdmissionRolledBack(f);
		} finally {
			deletionCommit.release();
			await Promise.allSettled([deletion, admission]);
		}
	});

	it.each(["RECHECK", "REJECT"] as const)(
		"observes an administrator %s committed while admission waits for verification ownership",
		async (action) => {
			const f = await createPreReviewedAdmissionFixture(client, {
				prefix: "pre-reviewed-admin-first",
			});
			const adminCommit = barrier();
			const admin = capture(
				applyAdminModerationReview(
					await adminInput(f, action),
					observedClient({ beforeCommit: () => adminCommit.wait() }),
				),
			);
			let admission: Promise<unknown> | undefined;
			try {
				await reached(adminCommit);
				const pids: number[] = [];
				const isolation: string[] = [];
				admission = capture(
					createGenerationJobTransaction(f.input(), observedClient({ pids, isolation })),
				);
				await waitForBlocked(pids);
				adminCommit.release();
				expect(await admin).toHaveProperty("value");
				if (action === "REJECT") {
					expect(await admission).toMatchObject({ error: { message: "ASSET_NOT_READY" } });
					await expectAdmissionRolledBack(f);
				} else {
					expect(await admission).toMatchObject({
						value: { verificationAssetId: f.asset.id, job: { status: "RESERVED" } },
					});
					expect(isolation).toEqual(["ReadCommitted", "Serializable"]);
					expect(await client.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
						status: "VERIFYING",
						verificationGeneration: 2,
					});
				}
			} finally {
				adminCommit.release();
				await Promise.allSettled([admin, admission]);
			}
		},
	);

	it("rechecks the database-clock review expiry after waiting for the credit account", async () => {
		const f = await createPreReviewedAdmissionFixture(client, {
			prefix: "pre-reviewed-proof-expiry",
		});
		const [clock] = await client.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
		const expiresAt = new Date(clock!.now.getTime() + 2000);
		await appendApproval(f, { validUntil: expiresAt });
		const accountLock = barrier();
		const locker = capture(
			client.$transaction(
				async (tx) => {
					await tx.$queryRaw`SELECT id FROM credit_account WHERE id = ${f.account.id} FOR UPDATE`;
					await accountLock.wait();
				},
				{ timeout: 10_000 },
			),
		);
		let admission: Promise<unknown> | undefined;
		try {
			await reached(accountLock);
			const pids: number[] = [];
			const isolation: string[] = [];
			admission = capture(
				createGenerationJobTransaction(f.input(), observedClient({ pids, isolation })),
			);
			await waitForBlocked(pids);
			for (;;) {
				const [row] = await client.$queryRaw<Array<{ expired: boolean }>>`
					SELECT clock_timestamp() >= ${expiresAt}::timestamptz AS expired`;
				if (row!.expired) break;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			accountLock.release();
			expect(await locker).toHaveProperty("value");
			expect(await admission).toMatchObject({
				error: { message: "ASSET_MODERATION_EVIDENCE_STALE" },
			});
			expect(isolation).toEqual(["ReadCommitted"]);
			await expectAdmissionRolledBack(f);
		} finally {
			accountLock.release();
			await Promise.allSettled([locker, admission]);
		}
	});

	it.each(["generation 2", "manual approval", "active lease", "unknown submission"])(
		"keeps %s on the existing Serializable path",
		async (state) => {
			const f = await createPreReviewedAdmissionFixture(client, {
				prefix: "pre-reviewed-fallback",
			});
			if (state === "generation 2") await appendApproval(f, { generation: 2 });
			if (state === "manual approval")
				await applyAdminModerationReview(await adminInput(f, "APPROVE"), client);
			if (state === "active lease")
				await client.mediaAsset.update({
					where: { id: f.asset.id },
					data: {
						verificationLeaseToken: crypto.randomUUID(),
						verificationLeasedUntil: new Date(Date.now() + 60_000),
					},
				});
			if (state === "unknown submission")
				await client.mediaAsset.update({
					where: { id: f.asset.id },
					data: { verificationSubmissionUncertain: true },
				});
			const isolation: string[] = [];
			const result = await createGenerationJobTransaction(f.input(), observedClient({ isolation }));
			expect(result.job.creditsReserved).toBe(5n);
			expect(isolation).toEqual(["ReadCommitted", "Serializable"]);
		},
	);
});
