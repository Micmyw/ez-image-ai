import { temporaryReferenceObjectKey, type TemporaryReference } from "@repo/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	adoptTemporaryReference,
	commitTemporaryReferenceVerificationTransaction,
	reserveTemporaryReference,
	unexpiredStorageReservations,
} from "./temporary-references";

const now = new Date("2026-10-22T04:00:00Z");
const reference: TemporaryReference = {
	v: 1,
	ownerId: "temporary-owner",
	assetId: "83c3d232-19aa-4be3-9eed-c88a73456789",
	contentType: "image/png",
	bytes: 100,
	checksum: "a".repeat(64),
	createdAt: now.toISOString(),
	expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
};
const verification = {
	provider: "seeapi",
	ruleVersion: "rule-current",
	policyVersion: "policy-current",
};

function store() {
	const state = {
		reservation: {
			id: "reservation",
			ownerType: "USER",
			ownerId: reference.ownerId,
			status: "ACTIVE",
			bytes: BigInt(reference.bytes),
			referenceKey: `temporary-reference:${reference.assetId}`,
			expiresAt: new Date(reference.expiresAt),
		},
		asset: null as Record<string, unknown> | null,
		events: [] as Array<Record<string, unknown>>,
		blocked: false,
		clock: now,
	};
	const tx = {
		$executeRaw: vi.fn(async () => 1),
		$queryRaw: vi.fn(async () => [{ now: state.clock }]),
		storageUsageReservation: {
			aggregate: vi.fn(async () => ({ _sum: { bytes: 0n } })),
			count: vi.fn(async () => 0),
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
				id: "reservation",
				...data,
			})),
			findUnique: vi.fn(async () => state.reservation),
			updateMany: vi.fn(async () => {
				state.reservation.status = "COMMITTED";
				return { count: 1 };
			}),
		},
		subscription: { findMany: vi.fn(async () => []) },
		billingPeriod: { fields: { paidAmount: "paidAmount" } },
		runtimeConfigOverride: {
			findFirst: vi.fn(async () => (state.blocked ? { id: "disabled" } : null)),
		},
		mediaAsset: {
			findUnique: vi.fn(async () => state.asset),
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				state.asset = {
					verificationEngine: "legacy",
					verificationAttemptCount: 0,
					verificationProviderTaskId: null,
					verificationSubmissionToken: null,
					verificationSubmissionUncertain: false,
					deletedAt: null,
					...data,
				};
				return state.asset;
			}),
		},
		outboxEvent: {
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				state.events.push({ id: "verification-event", ...data });
				return { id: "verification-event" };
			}),
		},
	};
	const client = {
		$transaction: vi.fn(
			async (
				operation: (value: typeof tx) => Promise<unknown>,
				_options?: Record<string, unknown>,
			) => {
				const before = structuredClone(state);
				try {
					return await operation(tx);
				} catch (error) {
					Object.assign(state, before);
					throw error;
				}
			},
		),
	};
	const commit = (profile: typeof verification | null = verification) =>
		commitTemporaryReferenceVerificationTransaction(
			{
				ownerId: reference.ownerId,
				reservationId: "reservation",
				reference,
				verification: profile,
			},
			client as never,
		);
	const adopt = () =>
		adoptTemporaryReference(
			{
				value: reference,
				ownerId: reference.ownerId,
				assetIds: [reference.assetId],
				now: state.clock,
				expectedRuleVersion: verification.ruleVersion,
				expectedPolicyVersion: verification.policyVersion,
			},
			tx as never,
		);
	const reserve = () =>
		reserveTemporaryReference(
			{
				ownerId: reference.ownerId,
				assetId: reference.assetId,
				bytes: reference.bytes,
				expiresAt: new Date(reference.expiresAt),
				maximumBytes: 100n,
			},
			client as never,
		);
	return { state, tx, client, commit, adopt, reserve };
}

afterEach(() => vi.unstubAllEnvs());

describe("retained temporary reference quota", () => {
	it("retains committed and unknown-upload temporary bytes after access expiry while deletion is paused", () => {
		vi.stubEnv("MEDIA_IMAGE_AUTO_DELETE_ENABLED", undefined);
		expect(unexpiredStorageReservations(now).OR).toContainEqual({
			status: { in: ["ACTIVE", "COMMITTED"] },
		});
	});
	it("keeps the prior temporary quota policy after explicit deletion enablement", () => {
		vi.stubEnv("MEDIA_IMAGE_AUTO_DELETE_ENABLED", "true");
		expect(unexpiredStorageReservations(now).OR).not.toContainEqual({
			status: { in: ["ACTIVE", "COMMITTED"] },
		});
	});
});

describe.each(["false", "true"])(
	"temporary reference pre-review preparation (fresh read=%s)",
	(enabled) => {
		beforeEach(() => vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", enabled));
		it("atomically commits immutable upload, VERIFYING asset and one durable event before Generate", async () => {
			const f = store();
			expect(await f.commit()).toEqual({ reference, continuationEventIds: ["verification-event"] });
			expect(f.state.reservation.status).toBe("COMMITTED");
			expect(f.state.asset).toMatchObject({
				id: reference.assetId,
				ownerId: reference.ownerId,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: temporaryReferenceObjectKey(reference),
				checksum: reference.checksum,
				verificationGeneration: 1,
				verificationProvider: verification.provider,
				verificationRuleVersion: verification.ruleVersion,
				verificationPolicyVersion: verification.policyVersion,
				deleteAfter: new Date(reference.expiresAt),
			});
			expect(f.state.events).toMatchObject([
				{ eventType: "MEDIA_ASSET_VERIFY", aggregateId: reference.assetId },
			]);
			expect(f.tx.storageUsageReservation.updateMany).toHaveBeenCalledExactlyOnceWith({
				where: {
					id: "reservation",
					status: "ACTIVE",
					ownerType: "USER",
					ownerId: reference.ownerId,
					referenceKey: `temporary-reference:${reference.assetId}`,
					bytes: BigInt(reference.bytes),
					expiresAt: new Date(reference.expiresAt),
				},
				data: { status: "COMMITTED" },
			});
		});

		it("rolls back the quota commit and asset if durable event creation fails", async () => {
			const f = store();
			f.tx.outboxEvent.create.mockRejectedValueOnce(new Error("commit failed"));
			await expect(f.commit()).rejects.toThrow("commit failed");
			expect(f.state.reservation.status).toBe("ACTIVE");
			expect(f.state.asset).toBeNull();
		});

		it("duplicate commit and Generate reuse the pending generation without another event or reset", async () => {
			const f = store();
			await f.commit();
			Object.assign(f.state.asset!, {
				verificationProviderTaskId: "pending-task",
				verificationAttemptCount: 1,
			});
			const before = structuredClone(f.state.asset);
			expect(await f.commit()).toEqual({ reference, continuationEventIds: [] });
			expect(await f.adopt()).toEqual({ reference });
			expect(f.state.asset).toEqual(before);
			expect(f.tx.mediaAsset.create).toHaveBeenCalledOnce();
			expect(f.tx.outboxEvent.create).toHaveBeenCalledOnce();
		});

		it.each(["environment", "runtime"])(
			"keeps pure uploads when generation is disabled by %s",
			async (source) => {
				const f = store();
				f.state.blocked = source === "runtime";
				expect(await f.commit(source === "environment" ? null : verification)).toEqual({
					reference,
					continuationEventIds: [],
				});
				expect(f.state.reservation.status).toBe("COMMITTED");
				expect(f.state.asset).toBeNull();
				expect(f.state.events).toEqual([]);
			},
		);

		it.each([
			{ ownerId: "other" },
			{ ownerType: "ORGANIZATION" },
			{ bytes: 99n },
			{ referenceKey: "temporary-reference:other" },
			{ status: "RELEASED" },
			{ expiresAt: new Date(now.getTime() + 5000) },
		])("rejects a mismatched reservation before preparation: %s", async (change) => {
			const f = store();
			Object.assign(f.state.reservation, change);
			await expect(f.commit()).rejects.toThrow("TEMPORARY_REFERENCE_INVALID");
			expect(f.tx.mediaAsset.create).not.toHaveBeenCalled();
		});

		it("checks the database clock after admission locks and retains expiry for abandoned uploads", async () => {
			const f = store();
			await f.commit();
			expect(f.state.asset?.deleteAfter).toEqual(new Date(reference.expiresAt));
			expect(f.state.asset?.objectKey).toMatch(/^users\/temporary-references\/v1\//);
			f.state.clock = new Date(reference.expiresAt);
			await expect(f.commit()).rejects.toThrow("TEMPORARY_REFERENCE_EXPIRED");
			await expect(f.adopt()).rejects.toThrow("TEMPORARY_REFERENCE_EXPIRED");
			expect(unexpiredStorageReservations(f.state.clock).OR).toContainEqual({
				expiresAt: { gt: f.state.clock },
			});
		});

		it.each([
			{ ownerId: "other" },
			{ objectKey: "users/other/object" },
			{ checksum: "b".repeat(64) },
			{ byteSize: 99n },
			{ mimeType: "image/jpeg" },
			{ verificationGeneration: 0 },
			{ verificationEngine: "video-workflow-v1" },
			{ deleteAfter: new Date(now.getTime() + 1000) },
			{ deletedAt: now },
			{ status: "QUARANTINED" },
		])("cannot adopt mismatched immutable objects or terminal verification: %s", async (change) => {
			const f = store();
			await f.commit();
			Object.assign(f.state.asset!, change);
			await expect(f.adopt()).rejects.toThrow("ASSET_NOT_READY");
			await expect(f.commit()).rejects.toThrow("ASSET_NOT_READY");
			expect(f.tx.outboxEvent.create).toHaveBeenCalledOnce();
		});

		it.each([{ verificationRuleVersion: "old-rule" }, { verificationPolicyVersion: "old-policy" }])(
			"refuses stale policy while preserving the same pending provider task: %s",
			async (change) => {
				const f = store();
				await f.commit();
				Object.assign(f.state.asset!, { verificationProviderTaskId: "pending-task", ...change });
				await expect(f.adopt()).rejects.toThrow("ASSET_MODERATION_EVIDENCE_STALE");
				await expect(f.commit()).rejects.toThrow("ASSET_MODERATION_EVIDENCE_STALE");
				expect(f.state.asset?.verificationProviderTaskId).toBe("pending-task");
				expect(f.tx.outboxEvent.create).toHaveBeenCalledOnce();
			},
		);

		it("preserves untouched legacy g1 inputs during receiver-first deployment", async () => {
			const f = store();
			await f.commit();
			Object.assign(f.state.asset!, {
				verificationProvider: null,
				verificationRuleVersion: null,
				verificationPolicyVersion: null,
			});
			const before = structuredClone(f.state.asset);
			expect(await f.adopt()).toEqual({ reference });
			expect(f.state.asset).toEqual(before);
			expect(f.tx.outboxEvent.create).toHaveBeenCalledOnce();
		});

		it.each([
			{ verificationAttemptCount: 1 },
			{ verificationProviderTaskId: "accepted-task" },
			{ verificationSubmissionToken: "uncertain-submission" },
			{ verificationSubmissionUncertain: true },
			{ verificationLeaseToken: "active-lease" },
			{ verificationProvider: "retired-provider" },
		])(
			"does not extend legacy empty-policy compatibility to review work that has started: %s",
			async (started) => {
				const f = store();
				await f.commit();
				Object.assign(f.state.asset!, {
					verificationProvider: null,
					verificationRuleVersion: null,
					verificationPolicyVersion: null,
					...started,
				});
				const before = structuredClone(f.state.asset);
				await expect(f.adopt()).rejects.toThrow("ASSET_MODERATION_EVIDENCE_STALE");
				expect(f.state.asset).toEqual(before);
			},
		);
	},
);

describe("temporary reference isolation and rollback boundaries", () => {
	it.each([undefined, "false", "TRUE", "1", "true"])(
		"uses fresh reads only for exact opt-in %s",
		async (enabled) => {
			vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", enabled);
			const f = store();
			await f.reserve();
			await f.commit();
			expect(f.client.$transaction).toHaveBeenCalledTimes(2);
			for (const call of f.client.$transaction.mock.calls) {
				expect(call[1]).toMatchObject({
					isolationLevel: enabled === "true" ? "ReadCommitted" : "Serializable",
					maxWait: 5000,
					timeout: 20_000,
				});
			}
		},
	);

	it.each(["false", "true"])(
		"does not replay an unknown commit under fresh read=%s",
		async (enabled) => {
			vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", enabled);
			const f = store();
			const unknown = new Error("connection closed after COMMIT");
			f.client.$transaction.mockRejectedValueOnce(unknown);
			await expect(f.commit()).rejects.toBe(unknown);
			expect(f.client.$transaction).toHaveBeenCalledOnce();
		},
	);

	it.each(["false", "true"])(
		"preserves finite legacy rollback retries only for fresh read=%s",
		async (enabled) => {
			vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", enabled);
			const f = store();
			const conflict = Object.assign(new Error("confirmed transaction rollback"), {
				code: "P2034",
			});
			f.client.$transaction.mockRejectedValueOnce(conflict);
			if (enabled === "true") {
				await expect(f.commit()).rejects.toBe(conflict);
				expect(f.client.$transaction).toHaveBeenCalledOnce();
			} else {
				await expect(f.commit()).resolves.toMatchObject({
					continuationEventIds: ["verification-event"],
				});
				expect(f.client.$transaction).toHaveBeenCalledTimes(2);
			}
		},
	);

	it("uses the post-lock database time to reject an expired reservation before quota writes", async () => {
		vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", "true");
		const f = store();
		f.state.clock = new Date(reference.expiresAt);
		await expect(f.reserve()).rejects.toThrow("TEMPORARY_REFERENCE_EXPIRED");
		expect(f.tx.storageUsageReservation.create).not.toHaveBeenCalled();
	});

	it("rolls back preparation when a competing ACTIVE reservation transition wins", async () => {
		vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", "true");
		const f = store();
		f.tx.storageUsageReservation.updateMany.mockResolvedValueOnce({ count: 0 });
		await expect(f.commit()).rejects.toThrow("TEMPORARY_REFERENCE_INVALID");
		expect(f.state.reservation.status).toBe("ACTIVE");
		expect(f.tx.mediaAsset.create).not.toHaveBeenCalled();
		expect(f.tx.outboxEvent.create).not.toHaveBeenCalled();
	});
});
