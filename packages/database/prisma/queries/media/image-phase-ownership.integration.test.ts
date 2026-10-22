import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient, type Prisma } from "../../generated/client";
import { wakeImageModerationWithOwner } from "./image-moderation-callback";
import {
	claimImagePhaseOwnerInTransaction,
	deleteExpiredImagePhaseOwners,
	getImagePhaseOwner,
	isImagePhaseOwnerCurrent,
	type ImagePhaseOwner,
	type ImageWorkflowPhase,
} from "./image-phase-ownership";
import {
	KIE_IMAGE_COMPLETION_NOTICE_PROVIDER,
	wakeKieGenerationAttemptWithOwner,
} from "./kie-callback";

describe("image phase ownership with real PostgreSQL transactions", () => {
	let client: PrismaClient;
	const subjectIds: string[] = [];
	const assetIds: string[] = [];
	const jobIds: string[] = [];
	const quoteIds: string[] = [];
	const accountIds: string[] = [];
	const attemptIds: string[] = [];

	beforeAll(() => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString) throw new Error("EXPLICIT_TEST_DATABASE_REQUIRED");
		const url = new URL(connectionString);
		if (
			!["postgres:", "postgresql:"].includes(url.protocol) ||
			url.hostname !== "127.0.0.1" ||
			url.port !== "55432" ||
			(url.pathname !== "/ai_media_foundation_test" &&
				url.pathname !== "/scanless_phase_owner_migration_test" &&
				!/^\/ezpic_[a-z0-9_]+_test$/.test(url.pathname)) ||
			url.search !== "" ||
			url.hash !== ""
		)
			throw new Error("UNSAFE_TEST_DATABASE");
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 6 }) });
	});

	afterAll(async () => {
		if (!client) return;
		try {
			await client.mediaWorkflowPhaseOwner.deleteMany({
				where: { subjectId: { in: subjectIds } },
			});
			if (attemptIds.length) {
				await client.providerWebhookEvent.deleteMany({
					where: {
						provider: KIE_IMAGE_COMPLETION_NOTICE_PROVIDER,
						OR: attemptIds.map((id) => ({ envelope: { path: ["attemptId"], equals: id } })),
					},
				});
			}
			await client.outboxEvent.deleteMany({
				where: { aggregateId: { in: [...assetIds, ...jobIds] } },
			});
			await client.creditReservation.deleteMany({ where: { jobId: { in: jobIds } } });
			await client.generationJob.deleteMany({ where: { id: { in: jobIds } } });
			await client.generationQuote.deleteMany({ where: { id: { in: quoteIds } } });
			await client.creditAccount.deleteMany({ where: { id: { in: accountIds } } });
			await client.mediaAsset.deleteMany({ where: { id: { in: assetIds } } });
		} finally {
			await client.$disconnect();
		}
	});

	function phase(): ImageWorkflowPhase {
		const assetId = crypto.randomUUID();
		subjectIds.push(assetId);
		return { kind: "verification", assetId, generation: 1 };
	}

	async function lock(tx: Prisma.TransactionClient, subject: ImageWorkflowPhase) {
		if (subject.kind === "verification") {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${subject.assetId}`}, 0))`;
		} else {
			await tx.$queryRaw`SELECT "id" FROM "generation_attempt" WHERE "id" = ${subject.attemptId} FOR UPDATE`;
		}
	}

	async function claim(
		subject: ImageWorkflowPhase,
		workflowId: string,
		options: { expectedOwner?: ImagePhaseOwner; businessLeasedUntil?: Date | null } = {},
	) {
		return client.$transaction(async (tx) => {
			await lock(tx, subject);
			return claimImagePhaseOwnerInTransaction({ phase: subject, workflowId, ...options }, tx);
		});
	}

	async function owned(
		subject: ImageWorkflowPhase,
		workflowId = `workflow-${crypto.randomUUID()}`,
	) {
		const result = await claim(subject, workflowId);
		expect(result.owned).toBe(true);
		if (!result.phaseOwner) throw new Error("MISSING_TEST_PHASE_OWNER");
		return result.phaseOwner;
	}

	async function expire(owner: ImagePhaseOwner, tx: Prisma.TransactionClient = client) {
		await tx.$executeRaw`UPDATE "media_workflow_phase_owner" SET "leasedUntil" = clock_timestamp() - INTERVAL '1 second' WHERE "phaseKey" = ${owner.phaseKey}`;
	}

	async function assetFixture(patch: Partial<Prisma.MediaAssetCreateInput> = {}) {
		const id = crypto.randomUUID();
		const submissionToken = crypto.randomUUID();
		const asset = await client.mediaAsset.create({
			data: {
				id,
				ownerType: "USER",
				ownerId: `phase-owner-${id}`,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `users/phase-owner/assets/${id}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum: "c".repeat(64),
				finalizedAt: new Date(),
				verificationEngine: "legacy",
				verificationProvider: "seeapi",
				verificationGeneration: 1,
				verificationSubmissionToken: submissionToken,
				verificationProviderTaskId: `review-${id}`,
				verificationNextAttemptAt: new Date(Date.now() + 60_000),
				...patch,
			},
		});
		assetIds.push(id);
		subjectIds.push(id);
		return {
			asset,
			phase: { kind: "verification", assetId: id, generation: 1 } as const,
			identity: { assetId: id, generation: 1, submissionToken },
		};
	}

	async function generationFixture(uncertain = false) {
		const id = crypto.randomUUID();
		const taskId = `task-${id}`;
		const snapshot = {
			ownerType: "USER" as const,
			ownerId: id,
			submittedByUserId: id,
			productKey: "image-nano-banana-2-lite",
			catalogVersion: "phase-owner-test",
			pricingVersion: "phase-owner-test",
			inputSnapshot: {},
			pricingSnapshot: {},
		};
		const job = await client.generationJob.create({
			data: {
				...snapshot,
				quote: { create: { ...snapshot, credits: 5n, costMicros: 10n, expiresAt: new Date() } },
				idempotencyKey: id,
				creditsReserved: 5n,
				status: uncertain ? "SUBMITTING" : "PROVIDER_PENDING",
				executionEngine: "legacy",
				attempts: {
					create: {
						id,
						attemptNumber: 1,
						provider: "kie",
						providerModelId: "nano-banana-2-lite",
						providerTaskId: uncertain ? null : taskId,
						status: uncertain ? "SUBMISSION_UNCERTAIN" : "SUBMITTED",
						uncertainSubmission: uncertain,
						requestSnapshot: {},
						submittedAt: new Date(),
						nextReconcileAt: new Date(Date.now() + 60_000),
					},
				},
				reservation: {
					create: {
						amount: 5n,
						account: { create: { ownerType: "USER", ownerId: id, reservedCredits: 5n } },
					},
				},
			},
			include: { reservation: true },
		});
		jobIds.push(job.id);
		quoteIds.push(job.quoteId);
		accountIds.push(job.reservation!.accountId);
		attemptIds.push(id);
		subjectIds.push(id);
		return { job, taskId, phase: { kind: "generation", attemptId: id } as const };
	}

	function gate() {
		let resolve!: () => void;
		const promise = new Promise<void>((done) => (resolve = done));
		return { promise, resolve };
	}

	async function expectBlocked(pid: number) {
		for (let i = 0; i < 100; i++) {
			const [row] = await client.$queryRaw<Array<{ blocked: boolean }>>`
				SELECT cardinality(pg_blocking_pids(${pid}::integer)) > 0 AS blocked`;
			if (row?.blocked) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error("EXPECTED_REAL_POSTGRES_LOCK_CONTENTION");
	}

	it("uses database time for the lease and renews only the same live identity", async () => {
		const subject = phase();
		const owner = await owned(subject);
		const [clock] = await client.$queryRaw<Array<{ remaining: number }>>`
			SELECT EXTRACT(EPOCH FROM ("leasedUntil" - clock_timestamp())) * 1000 AS remaining
			FROM "media_workflow_phase_owner" WHERE "phaseKey" = ${owner.phaseKey}`;
		expect(Number(clock!.remaining)).toBeGreaterThan(590_000);
		expect(Number(clock!.remaining)).toBeLessThanOrEqual(600_000);
		await expect(claim(subject, owner.workflowId, { expectedOwner: owner })).resolves.toEqual({
			owned: true,
			phaseOwner: owner,
		});
		const before = await client.mediaWorkflowPhaseOwner.findUniqueOrThrow({
			where: { phaseKey: owner.phaseKey },
		});
		await expect(claim(subject, "foreign-workflow")).resolves.toEqual({
			owned: false,
			phaseOwner: owner,
		});
		expect(
			await client.mediaWorkflowPhaseOwner.findUniqueOrThrow({
				where: { phaseKey: owner.phaseKey },
			}),
		).toEqual(before);
		await expect(getImagePhaseOwner(subject, client)).resolves.toEqual(owner);
		await expect(
			isImagePhaseOwnerCurrent(subject, { ...owner, epoch: owner.epoch + 1 }, client),
		).resolves.toBe(false);
	});

	it("serializes two real claim transactions under the subject lock", async () => {
		const subject = phase();
		const held = gate();
		const release = gate();
		const waiting = gate();
		let waiterPid = 0;
		const first = client.$transaction(
			async (tx) => {
				await lock(tx, subject);
				const result = await claimImagePhaseOwnerInTransaction(
					{ phase: subject, workflowId: "winner" },
					tx,
				);
				held.resolve();
				await release.promise;
				return result;
			},
			{ timeout: 10_000 },
		);
		await held.promise;
		const second = client.$transaction(
			async (tx) => {
				const [backend] = await tx.$queryRaw<
					Array<{ pid: number }>
				>`SELECT pg_backend_pid() AS pid`;
				waiterPid = backend!.pid;
				waiting.resolve();
				await lock(tx, subject);
				return claimImagePhaseOwnerInTransaction({ phase: subject, workflowId: "loser" }, tx);
			},
			{ timeout: 10_000 },
		);
		try {
			await waiting.promise;
			await expectBlocked(waiterPid);
		} finally {
			release.resolve();
		}
		const [winner, loser] = await Promise.all([first, second]);
		expect(winner.owned).toBe(true);
		expect(loser).toEqual({ owned: false, phaseOwner: winner.phaseOwner });
	});

	it("does not let a skewed application clock expire or extend the database owner", async () => {
		const subject = phase();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
		try {
			const owner = await owned(subject);
			await expect(getImagePhaseOwner(subject, client)).resolves.toEqual(owner);
			await expect(isImagePhaseOwnerCurrent(subject, owner, client)).resolves.toBe(true);
			const [clock] = await client.$queryRaw<Array<{ remaining: number }>>`
				SELECT EXTRACT(EPOCH FROM ("leasedUntil" - clock_timestamp())) * 1000 AS remaining
				FROM "media_workflow_phase_owner" WHERE "phaseKey" = ${owner.phaseKey}`;
			expect(Number(clock!.remaining)).toBeGreaterThan(590_000);
			expect(Number(clock!.remaining)).toBeLessThanOrEqual(600_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not expose an owner whose enclosing business transaction rolled back", async () => {
		const subject = phase();
		const rollback = new Error("TEST_BUSINESS_ROLLBACK");
		await expect(
			client.$transaction(async (tx) => {
				await lock(tx, subject);
				await claimImagePhaseOwnerInTransaction({ phase: subject, workflowId: "rolled-back" }, tx);
				throw rollback;
			}),
		).rejects.toBe(rollback);
		await expect(getImagePhaseOwner(subject, client)).resolves.toBeUndefined();
		expect(await owned(subject, "committed")).toMatchObject({ workflowId: "committed", epoch: 1 });
	});

	it("rejects an expired expected receipt, then increments the epoch on a fresh takeover", async () => {
		const subject = phase();
		const owner = await owned(subject);
		await expire(owner);
		await expect(claim(subject, owner.workflowId, { expectedOwner: owner })).resolves.toEqual({
			owned: false,
		});
		const replacement = await owned(subject, "replacement");
		expect(replacement).toEqual({ ...owner, workflowId: "replacement", epoch: owner.epoch + 1 });
		await expect(isImagePhaseOwnerCurrent(subject, owner, client)).resolves.toBe(false);
		await expect(isImagePhaseOwnerCurrent(subject, replacement, client)).resolves.toBe(true);
		await expect(claim(subject, owner.workflowId, { expectedOwner: owner })).resolves.toEqual({
			owned: false,
			phaseOwner: replacement,
		});
	});

	it.each(["verification", "generation"] as const)(
		"retains an expired %s owner while the business lease is active",
		async (kind) => {
			const subject =
				kind === "verification" ? (await assetFixture()).phase : (await generationFixture()).phase;
			const owner = await owned(subject);
			await expire(owner);
			const [clock] = await client.$queryRaw<
				Array<{ leasedUntil: Date }>
			>`SELECT clock_timestamp() + INTERVAL '1 minute' AS "leasedUntil"`;
			const businessLeasedUntil = clock!.leasedUntil;
			if (subject.kind === "verification") {
				await client.mediaAsset.update({
					where: { id: subject.assetId },
					data: {
						verificationLeasedUntil: businessLeasedUntil,
						verificationLeaseToken: crypto.randomUUID(),
					},
				});
			} else {
				await client.generationAttempt.update({
					where: { id: subject.attemptId },
					data: {
						reconcileLeasedUntil: businessLeasedUntil,
						reconcileLeaseToken: crypto.randomUUID(),
					},
				});
			}
			const before = await client.mediaWorkflowPhaseOwner.findUniqueOrThrow({
				where: { phaseKey: owner.phaseKey },
			});
			await expect(claim(subject, "takeover", { businessLeasedUntil })).resolves.toEqual({
				owned: false,
			});
			expect(
				await client.mediaWorkflowPhaseOwner.findUniqueOrThrow({
					where: { phaseKey: owner.phaseKey },
				}),
			).toEqual(before);
			if (subject.kind === "verification") {
				await client.mediaAsset.update({
					where: { id: subject.assetId },
					data: { verificationLeasedUntil: new Date(0) },
				});
			} else {
				await client.generationAttempt.update({
					where: { id: subject.attemptId },
					data: { reconcileLeasedUntil: new Date(0) },
				});
			}
			await expect(
				claim(subject, "takeover", { businessLeasedUntil: new Date(0) }),
			).resolves.toMatchObject({ owned: true, phaseOwner: { epoch: owner.epoch + 1 } });
		},
	);

	it("keeps separate ownership for two review generations of one immutable asset", async () => {
		const subject = phase();
		if (subject.kind !== "verification") throw new Error("UNEXPECTED_TEST_PHASE");
		const first = await owned(subject, "generation-one");
		const nextSubject = { ...subject, generation: 2 };
		const second = await owned(nextSubject, "generation-two");
		expect(second.phaseKey).not.toBe(first.phaseKey);
		await expect(isImagePhaseOwnerCurrent(nextSubject, first, client)).resolves.toBe(false);
		await expect(getImagePhaseOwner(subject, client)).resolves.toEqual(first);
		await expect(getImagePhaseOwner(nextSubject, client)).resolves.toEqual(second);
	});

	it("returns only the committed review owner after recording a callback under the same lock", async () => {
		const f = await assetFixture();
		const held = gate();
		const release = gate();
		const ownerCommit = client.$transaction(
			async (tx) => {
				await lock(tx, f.phase);
				const result = await claimImagePhaseOwnerInTransaction(
					{ phase: f.phase, workflowId: "review-workflow" },
					tx,
				);
				held.resolve();
				await release.promise;
				return result;
			},
			{ timeout: 10_000 },
		);
		await held.promise;
		const callback = wakeImageModerationWithOwner(f.identity, client);
		release.resolve();
		const [owner, result] = await Promise.all([ownerCommit, callback]);
		expect(result).toEqual({ status: "ready", phaseOwner: owner.phaseOwner });
		const saved = await client.mediaAsset.findUniqueOrThrow({ where: { id: f.asset.id } });
		expect(saved.verificationCallbackReceivedAt).toBeInstanceOf(Date);
		expect(saved.verificationNextAttemptAt).toEqual(saved.verificationCallbackReceivedAt);
		expect(saved.status).toBe("VERIFYING");
		expect(await client.assetModerationResult.count({ where: { assetId: f.asset.id } })).toBe(0);
		expect(await client.outboxEvent.count({ where: { aggregateId: f.asset.id } })).toBe(0);
	});

	it("records an early review callback without returning an executable owner or resolving uncertainty", async () => {
		const f = await assetFixture({
			verificationProviderTaskId: null,
			verificationSubmissionUncertain: true,
		});
		await owned(f.phase);
		await expect(wakeImageModerationWithOwner(f.identity, client)).resolves.toEqual({
			status: "recorded",
		});
		const saved = await client.mediaAsset.findUniqueOrThrow({ where: { id: f.asset.id } });
		expect(saved.verificationCallbackReceivedAt).toBeInstanceOf(Date);
		expect({
			...saved,
			verificationCallbackReceivedAt: null,
			updatedAt: f.asset.updatedAt,
		}).toEqual(f.asset);
	});

	it("returns the model owner after the notice commits without changing financial or business state", async () => {
		const f = await generationFixture();
		const owner = await owned(f.phase);
		const before = await client.generationAttempt.findUniqueOrThrow({
			where: { id: f.phase.attemptId },
		});
		await expect(
			wakeKieGenerationAttemptWithOwner(
				{ attemptId: f.phase.attemptId, providerTaskId: f.taskId },
				client,
			),
		).resolves.toEqual({ status: "ready", phaseOwner: owner });
		const after = await client.generationAttempt.findUniqueOrThrow({
			where: { id: f.phase.attemptId },
		});
		expect(after.nextReconcileAt!.getTime()).toBeLessThan(before.nextReconcileAt!.getTime());
		expect({
			...after,
			nextReconcileAt: before.nextReconcileAt,
			updatedAt: before.updatedAt,
		}).toEqual(before);
		expect(await client.creditReservation.findUnique({ where: { jobId: f.job.id } })).toEqual(
			f.job.reservation,
		);
		expect(
			await client.creditLedgerEntry.count({ where: { accountId: f.job.reservation!.accountId } }),
		).toBe(0);
		expect(
			await client.providerWebhookEvent.count({
				where: {
					provider: KIE_IMAGE_COMPLETION_NOTICE_PROVIDER,
					envelope: { path: ["attemptId"], equals: f.phase.attemptId },
				},
			}),
		).toBe(1);
	});

	it("preserves an unknown model acceptance and its reservation through phase takeover and callback", async () => {
		const f = await generationFixture(true);
		const prior = await owned(f.phase);
		const before = await client.generationAttempt.findUniqueOrThrow({
			where: { id: f.phase.attemptId },
		});
		await expire(prior);
		const replacement = await owned(f.phase, "recovery-workflow");
		expect(replacement.epoch).toBe(prior.epoch + 1);
		await expect(
			wakeKieGenerationAttemptWithOwner(
				{ attemptId: f.phase.attemptId, providerTaskId: f.taskId },
				client,
			),
		).resolves.toEqual({ status: "recorded" });
		expect(
			await client.generationAttempt.findUniqueOrThrow({ where: { id: f.phase.attemptId } }),
		).toEqual(before);
		expect(await client.creditReservation.findUnique({ where: { jobId: f.job.id } })).toEqual(
			f.job.reservation,
		);
		expect(
			await client.generationJob.findUniqueOrThrow({
				where: { id: f.job.id },
				select: { status: true },
			}),
		).toEqual({ status: "SUBMITTING" });
		expect(
			await client.creditLedgerEntry.count({ where: { accountId: f.job.reservation!.accountId } }),
		).toBe(0);
	});

	it("cleanup retains active business leases and recent owners, and replacement rejects pre-cleanup receipts", async () => {
		const expiredSubject = phase();
		const expiredOwner = await owned(expiredSubject);
		const recent = await owned(phase());
		const review = await assetFixture({
			verificationLeasedUntil: new Date(Date.now() + 60_000),
			verificationLeaseToken: crypto.randomUUID(),
		});
		const reviewOwner = await owned(review.phase);
		const model = await generationFixture();
		const modelOwner = await owned(model.phase);
		await client.generationAttempt.update({
			where: { id: model.phase.attemptId },
			data: {
				reconcileLeasedUntil: new Date(Date.now() + 60_000),
				reconcileLeaseToken: crypto.randomUUID(),
			},
		});
		const rollback = new Error("ROLLBACK_MAINTENANCE_FIXTURE");
		await expect(
			client.$transaction(
				async (tx) => {
					for (const owner of [expiredOwner, reviewOwner, modelOwner]) {
						await tx.$executeRaw`UPDATE "media_workflow_phase_owner" SET "leasedUntil" = clock_timestamp() - INTERVAL '25 hours' WHERE "phaseKey" = ${owner.phaseKey}`;
					}
					await deleteExpiredImagePhaseOwners({ limit: 1000 }, tx);
					expect(
						await tx.mediaWorkflowPhaseOwner.findUnique({
							where: { phaseKey: expiredOwner.phaseKey },
						}),
					).toBeNull();
					for (const owner of [recent, reviewOwner, modelOwner]) {
						expect(
							await tx.mediaWorkflowPhaseOwner.findUnique({ where: { phaseKey: owner.phaseKey } }),
						).not.toBeNull();
					}
					await lock(tx, expiredSubject);
					const replacement = await claimImagePhaseOwnerInTransaction(
						{ phase: expiredSubject, workflowId: expiredOwner.workflowId },
						tx,
					);
					expect(replacement.phaseOwner!.phaseKey).not.toBe(expiredOwner.phaseKey);
					expect(replacement.phaseOwner!.epoch).toBe(1);
					expect(await isImagePhaseOwnerCurrent(expiredSubject, expiredOwner, tx)).toBe(false);
					expect(
						await claimImagePhaseOwnerInTransaction(
							{
								phase: expiredSubject,
								workflowId: expiredOwner.workflowId,
								expectedOwner: expiredOwner,
							},
							tx,
						),
					).toEqual({ owned: false, phaseOwner: replacement.phaseOwner });
					throw rollback;
				},
				{ timeout: 15_000 },
			),
		).rejects.toBe(rollback);
	});

	it("cleanup skips a row locked by another transaction instead of waiting on its execution", async () => {
		const lockedOwner = await owned(phase());
		const freeOwner = await owned(phase());
		for (const owner of [lockedOwner, freeOwner]) {
			await client.$executeRaw`UPDATE "media_workflow_phase_owner" SET "leasedUntil" = clock_timestamp() - INTERVAL '25 hours' WHERE "phaseKey" = ${owner.phaseKey}`;
		}
		const held = gate();
		const release = gate();
		const holder = client.$transaction(
			async (tx) => {
				await tx.$queryRaw`SELECT "phaseKey" FROM "media_workflow_phase_owner" WHERE "phaseKey" = ${lockedOwner.phaseKey} FOR UPDATE`;
				held.resolve();
				await release.promise;
			},
			{ timeout: 10_000 },
		);
		await held.promise;
		const rollback = new Error("ROLLBACK_SKIPPED_LOCK_FIXTURE");
		try {
			await expect(
				client.$transaction(async (tx) => {
					await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
					await deleteExpiredImagePhaseOwners({ limit: 1000 }, tx);
					expect(
						await tx.mediaWorkflowPhaseOwner.findUnique({
							where: { phaseKey: lockedOwner.phaseKey },
						}),
					).not.toBeNull();
					expect(
						await tx.mediaWorkflowPhaseOwner.findUnique({
							where: { phaseKey: freeOwner.phaseKey },
						}),
					).toBeNull();
					throw rollback;
				}),
			).rejects.toBe(rollback);
		} finally {
			release.resolve();
			await holder;
		}
	});
});
