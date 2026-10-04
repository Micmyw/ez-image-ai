import { TestMediaSafetyAdapter } from "@repo/ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));

import { listVerificationRecoveryCandidates } from "../orchestration/verification-recovery";
import { createDatabaseVerifyUploadDependencies, createDatabaseDispatchStore } from "../runtime";

function fixture(provider: string, status = "VERIFYING") {
	const asset = {
		id: "retired-asset",
		verificationEngine: "legacy",
		kind: "INPUT",
		status,
		deletedAt: null,
		objectKey: "users/owner/retired.png",
		mimeType: "image/png",
		byteSize: 16n,
		checksum: "a".repeat(64),
		storageEtag: "immutable-etag",
		finalizedAt: new Date(),
		verificationProvider: provider,
		verificationProviderTaskId: "historical-task",
		verificationRuleVersion: "historical-rule",
		verificationPolicyVersion: "historical-policy",
		verificationGeneration: 7,
		verificationAttemptCount: 2,
		verificationLeaseToken: "historical-lease",
		verificationLeasedUntil: new Date(0),
		verificationNextAttemptAt: new Date(0),
		verificationLastErrorCode: null,
	};
	const updateMany = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
		Object.assign(asset, data);
		return { count: 1 };
	});
	const update = vi.fn(async () => {
		throw new Error("MUST_NOT_RESET_HISTORICAL_MODERATION");
	});
	const tx = {
		$executeRaw: vi.fn(async () => 1),
		mediaAsset: { findUnique: async () => asset, updateMany, update },
		assetModerationResult: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
		auditLog: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
	};
	const database = {
		$transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
	};
	const safety = Object.assign(new TestMediaSafetyAdapter("ALLOW"), {
		moderateImage: vi.fn(),
		submitImage: vi.fn(),
		retrieveImage: vi.fn(),
	});
	const inspect = vi.fn();
	const dependencies = createDatabaseVerifyUploadDependencies(database as never, {
		moderationProvider: "seeapi",
		safety,
		inspectPrivateMediaObject: inspect,
		createSignedReadUrl: inspect,
	});
	return { asset, tx, safety, inspect, dependencies };
}

describe("retired Sightengine moderation runtime", () => {
	it("does not dispatch an already reserved historical bypass quote", async () => {
		const update = vi.fn();
		const tx = {
			$executeRaw: vi.fn(async () => 1),
			generationJob: {
				findFirst: vi.fn(async () => ({ quote: { moderationDecision: "BYPASS" } })),
				update,
			},
			moderationReview: { findFirst: vi.fn() },
		};
		const database = {
			$transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
		};
		const store = createDatabaseDispatchStore(database as never, {
			environment: { MEDIA_GENERATION_ENABLED: "true" },
			enabledProviders: new Set(["kie"]),
		});
		expect(await store.claimDispatch({ jobId: "historical", version: 0 })).toBeNull();
		expect(update).not.toHaveBeenCalled();
		expect(tx.moderationReview.findFirst).not.toHaveBeenCalled();
	});
	it.each(["sightengine", "seeapi+sightengine", "sightengine+seeapi"])(
		"holds incomplete %s assets without resetting identity or submitting SeeAPI",
		async (provider) => {
			const f = fixture(provider);
			expect(await f.dependencies.verify(f.asset.id)).toEqual({ outboxCommitted: false });
			expect(f.asset).toMatchObject({
				status: "VERIFYING",
				verificationProvider: provider,
				verificationProviderTaskId: "historical-task",
				verificationGeneration: 7,
				verificationAttemptCount: 2,
				verificationRuleVersion: "historical-rule",
				verificationPolicyVersion: "historical-policy",
				verificationLastErrorCode: "MODERATION_PROVIDER_RETIRED",
				verificationLeaseToken: null,
				verificationLeasedUntil: null,
				verificationNextAttemptAt: null,
			});
			expect(f.tx.mediaAsset.update).not.toHaveBeenCalled();
			expect(f.safety.submitImage).not.toHaveBeenCalled();
			expect(f.safety.retrieveImage).not.toHaveBeenCalled();
			expect(f.safety.moderateImage).not.toHaveBeenCalled();
			expect(f.inspect).not.toHaveBeenCalled();
			expect(f.tx.assetModerationResult.create).not.toHaveBeenCalled();
		},
	);
	it.each(["READY", "QUARANTINED", "VERIFICATION_FAILED"])(
		"leaves historical %s data unchanged",
		async (status) => {
			const f = fixture("sightengine", status);
			const before = structuredClone(f.asset);
			expect(
				await f.dependencies.verify(f.asset.id, { allowQuarantinedReverification: true }),
			).toEqual({ outboxCommitted: false });
			expect(f.asset).toEqual(before);
			expect(f.tx.mediaAsset.updateMany).not.toHaveBeenCalled();
			expect(f.tx.mediaAsset.update).not.toHaveBeenCalled();
			expect(f.safety.submitImage).not.toHaveBeenCalled();
			expect(f.safety.retrieveImage).not.toHaveBeenCalled();
			expect(f.tx.assetModerationResult.create).not.toHaveBeenCalled();
		},
	);
	it("excludes retired provider assets before the recovery batch limit", async () => {
		const findMany = vi.fn(async () => []);
		await listVerificationRecoveryCandidates(
			{ mediaAsset: { findMany } } as never,
			{ limit: 25, now: new Date() },
			{
				MEDIA_SAFETY_ADAPTER: "configured",
				MODERATION_IMAGE_SEEAPI_ENABLED: "true",
			},
		);
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					AND: [
						{
							OR: [
								{ verificationProvider: null },
								{ verificationProvider: { not: { contains: "sightengine" } } },
							],
						},
					],
				}),
				take: 25,
			}),
		);
	});
});
