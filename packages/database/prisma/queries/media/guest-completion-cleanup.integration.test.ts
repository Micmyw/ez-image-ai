import { createHash, randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient, type Prisma } from "../../generated/client";
import { executeAdminContentCleanup, previewAdminContentCleanup } from "./admin-content-cleanup";
import { finalizeGuestDraftFromReadyUploadTransaction } from "./drafts";
import type { MediaTransactionClient } from "./types";

let db: PrismaClient;
const prefix = `guest-completion-cleanup-${randomUUID()}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

beforeAll(async () => {
	const connectionString = process.env.TEST_DATABASE_URL;
	if (!connectionString || connectionString === process.env.DATABASE_URL)
		throw new Error("UNSAFE_TEST_DATABASE");
	const url = new URL(connectionString);
	if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname))
		throw new Error("UNSAFE_TEST_DATABASE");
	db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
	await db.$connect();
});

afterAll(async () => {
	// Unique fixtures retain immutable proof rows in the explicitly isolated test database.
	await db?.$disconnect();
});

async function fixture() {
	const id = `${prefix}-${randomUUID()}`;
	const ownerId = `${id}-owner`;
	const now = new Date();
	const expiresAt = new Date(now.getTime() + 60_000);
	const checksum = hash(id);
	await db.mediaAsset.create({
		data: {
			id,
			ownerType: "USER",
			ownerId,
			kind: "INPUT",
			status: "VERIFYING",
			retentionClass: "GUEST_TRIAL",
			objectKey: `test/${id}.png`,
			byteSize: 512n,
			mimeType: "image/png",
			checksum,
			finalizedAt: now,
			deleteAfter: expiresAt,
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "seeapi",
			verificationProviderTaskId: id,
			verificationRuleVersion: "test-rule",
			verificationPolicyVersion: "test-policy",
			verificationValidUntil: expiresAt,
		},
	});
	await db.assetModerationResult.create({
		data: {
			assetId: id,
			assetChecksum: checksum,
			verificationGeneration: 1,
			attemptNumber: 1,
			evidenceKind: "INPUT",
			provider: "seeapi",
			providerTaskId: id,
			ruleVersion: "test-rule",
			policyVersion: "test-policy",
			status: "APPROVED",
			reasonCode: "ALLOW",
			categories: [],
			rawEnvelope: { fixture: true },
			validUntil: expiresAt,
		},
	});
	await db.mediaAsset.update({ where: { id }, data: { status: "READY" } });
	const input: Parameters<typeof finalizeGuestDraftFromReadyUploadTransaction>[0] = {
		sessionId: `${id}-session`,
		completionTokenHash: hash(`${id}-completion`),
		consumedTokenHash: hash(`${id}-consumed`),
		claimTokenHash: hash(`${id}-claim`),
		capabilityVersion: "test-v1",
		promotionPeriod: prefix,
		maximumOutstandingBootstraps: 100,
		productKey: "image-minimax-h3",
		skuKey: "minimax-h3-1k",
		prompt: "Preserve this photo",
		expiresAt,
		verification: {
			provider: "seeapi",
			ruleVersion: "test-rule",
			policyVersion: "test-policy",
			now,
		},
	};
	return {
		id,
		input,
		createCompletedSession: (sessionExpiresAt: Date) =>
			db.mediaUploadSession.create({
				data: {
					id: input.sessionId,
					assetId: id,
					tokenHash: input.completionTokenHash,
					status: "COMPLETED",
					expectedBytes: 512n,
					completedAt: now,
					expiresAt: sessionExpiresAt,
					guestCapabilityVersion: input.capabilityVersion,
				},
			}),
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

/** Pause after a real database write while its actual PostgreSQL locks remain held. */
function pauseWriter(model: "mediaAsset" | "generationDraft", method: "update" | "create") {
	const entered = deferred<number>();
	const release = deferred<void>();
	const started = deferred<number>();
	const client = {
		$transaction: <T>(
			operation: (tx: Prisma.TransactionClient) => Promise<T>,
			options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
		) =>
			db.$transaction(
				async (tx) => {
					const [backend] = await tx.$queryRaw<
						Array<{ pid: number }>
					>`SELECT pg_backend_pid() AS pid`;
					started.resolve(backend!.pid);
					const wrapped = new Proxy(tx, {
						get(target, key) {
							const value = Reflect.get(target, key);
							if (key !== model) return typeof value === "function" ? value.bind(target) : value;
							return new Proxy(value, {
								get(delegate, action) {
									const call = Reflect.get(delegate, action);
									if (action !== method)
										return typeof call === "function" ? call.bind(delegate) : call;
									return async (...args: unknown[]) => {
										const result = await Reflect.apply(call, delegate, args);
										entered.resolve(backend!.pid);
										await release.promise;
										return result;
									};
								},
							});
						},
					});
					return operation(wrapped);
				},
				{ ...options, timeout: 10_000 },
			),
	} as MediaTransactionClient;
	return {
		client,
		entered: entered.promise,
		started: started.promise,
		release: () => release.resolve(),
	};
}

async function waitUntilBlocked(pid: number) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const [row] = await db.$queryRaw<
			Array<{ blockers: number }>
		>`SELECT cardinality(pg_blocking_pids(${pid}::integer))::integer AS blockers`;
		if (row!.blockers > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("EXPECTED_REAL_DATABASE_LOCK_WAIT");
}

function preview(assetId: string) {
	return previewAdminContentCleanup(
		{
			assetIds: [assetId],
			includeExpiredInternalDiagnostics: false,
			reason: "Delete exact concurrency fixture",
		},
		`${prefix}-admin`,
		db,
	);
}
function execute(plan: Awaited<ReturnType<typeof preview>>, client: MediaTransactionClient) {
	return executeAdminContentCleanup(
		{ planId: plan.planId, planHash: plan.planHash, confirmation: plan.confirmation },
		`${prefix}-admin`,
		client,
	);
}

describe("guest completion and administrator cleanup locking", () => {
	it("rejects the original completion after cleanup commits a tombstone and consumes no claim", async () => {
		const item = await fixture();
		const expiredAt = new Date(Date.now() - 1000);
		await item.createCompletedSession(expiredAt);
		// A stale ingress clock used to keep this expired session admissible.
		item.input.verification.now = new Date(expiredAt.getTime() - 1000);
		const plan = await preview(item.id);
		expect(plan.assetCount).toBe(1);
		const cleanup = pauseWriter("mediaAsset", "update");
		const completion = pauseWriter("generationDraft", "create");
		const deleting = execute(plan, cleanup.client);
		await cleanup.entered;
		const completing = finalizeGuestDraftFromReadyUploadTransaction(item.input, completion.client);
		const rejected = expect(completing).rejects.toThrow("GUEST_UPLOAD_UNAVAILABLE");
		try {
			await waitUntilBlocked(await completion.started);
		} finally {
			cleanup.release();
			completion.release();
			await Promise.allSettled([deleting, completing]);
		}
		await rejected;
		expect((await deleting).queuedAssets).toBe(1);
		expect(await db.generationDraft.count({ where: { assetId: item.id } })).toBe(0);
		expect(await db.guestSessionBootstrap.count({ where: { sourceAssetId: item.id } })).toBe(0);
		expect(
			await db.mediaUploadSession.findUnique({ where: { id: item.input.sessionId } }),
		).toMatchObject({ tokenHash: item.input.completionTokenHash, guestCompletionConsumedAt: null });
		expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
			"DELETED",
		);
	});

	it("lets completion create one active draft before cleanup rechecks and rolls its plan back", async () => {
		const item = await fixture();
		// The valid preview predates the new completion session; execution must recheck it.
		const plan = await preview(item.id);
		expect(plan.assetCount).toBe(1);
		await item.createCompletedSession(item.input.expiresAt);
		const completion = pauseWriter("generationDraft", "create");
		const cleanup = pauseWriter("mediaAsset", "update");
		const completing = finalizeGuestDraftFromReadyUploadTransaction(item.input, completion.client);
		await completion.entered;
		const deleting = execute(plan, cleanup.client);
		const rejected = expect(deleting).rejects.toThrow("ADMIN_CLEANUP_PLAN_STALE");
		try {
			await waitUntilBlocked(await cleanup.started);
		} finally {
			completion.release();
			cleanup.release();
			await Promise.allSettled([completing, deleting]);
		}
		await rejected;
		const draft = await completing;
		expect(
			await db.generationDraft.count({
				where: { id: draft.id, assetId: item.id, status: "ACTIVE" },
			}),
		).toBe(1);
		expect(await db.guestSessionBootstrap.count({ where: { claimedDraftId: draft.id } })).toBe(1);
		expect(
			await db.mediaUploadSession.findUnique({ where: { id: item.input.sessionId } }),
		).toMatchObject({
			tokenHash: item.input.consumedTokenHash,
			guestCompletionConsumedAt: expect.any(Date),
		});
		expect(
			await db.outboxEvent.count({
				where: { aggregateId: item.id, eventType: "MEDIA_OBJECT_DELETE" },
			}),
		).toBe(0);
		expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
			"READY",
		);
		expect((await preview(item.id)).assets[0]?.blocked).toContain("ACTIVE_DRAFT");
	});
});
