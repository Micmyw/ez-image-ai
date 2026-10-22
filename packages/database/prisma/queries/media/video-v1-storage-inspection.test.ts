import { videoOutputConstraints } from "@repo/config/video-output";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../../client", () => ({ getDatabaseClient: () => state.client }));
vi.mock("./asset-binding-locks", () => ({ lockMediaAssetGenerationBindings: vi.fn() }));
vi.mock("./video-v1-storage", () => ({
	lockVideoOwnerStorage: vi.fn(async () => ({ ownerType: "USER", ownerId: "owner" })),
}));

import { completeVideoOutputStorage, type VerifiedVideoObject } from "./video-v1-fulfillment";

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-21T00:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

function fixture() {
	const asset = {
		id: "asset",
		ownerId: "owner",
		verificationEngine: "video-workflow-v1",
		objectKey: "users/owner/video/immutable.mp4",
		finalizedAt: null as Date | null,
		checksum: null as string | null,
		outputTransferToken: "lease",
		outputTransferLeaseExpiresAt: new Date(Date.now() + 60_000),
	};
	const job = {
		id: "job",
		ownerType: "USER",
		ownerId: "owner",
		executionEngine: "video-workflow-v1",
		inputSnapshot: {
			productKey: "video-kling-3",
			duration: 5,
			sound: false,
			resolution: "720p",
			aspectRatio: "16:9",
			audioSafetyPolicy: { schemaVersion: 1, mode: "not_requested" },
		},
		videoExecution: {
			stage: "STORING",
			stageData: { timings: { providerResultConfirmedAt: new Date().toISOString() } },
		},
		assets: [{ assetId: asset.id, asset }],
	};
	const tx = {
		$executeRaw: vi.fn(async () => 1),
		$queryRaw: vi.fn(async () => [{ id: job.id }]),
		generationJob: { findUnique: vi.fn(async () => job) },
		generationJobAsset: {
			findMany: vi.fn(async () => [{ assetId: asset.id }]),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
		storageUsageReservation: { updateMany: vi.fn(async () => ({ count: 1 })) },
		mediaAsset: { update: vi.fn(async () => asset) },
		videoExecution: {
			update: vi.fn(async (_input: { data: { stageData: Record<string, unknown> } }) => ({})),
		},
	};
	state.client = {
		$transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
	};
	const output: VerifiedVideoObject = {
		bytes: 1000,
		checksum: "a".repeat(64),
		etag: "sealed-etag",
		durationMillis: 5000,
		width: 1280,
		height: 720,
		audioTracks: 0,
		audioTrackIds: [],
		videoTracks: 1,
		inspectionVersion: "video-mp4-stream-v1",
	};
	return { tx, job, asset, output };
}

describe("video complete-stream inspection provenance", () => {
	it("commits the receipt with the leased object, frozen constraints and finalization timestamp", async () => {
		const f = fixture();
		await completeVideoOutputStorage("job", "asset", "lease", f.output);
		const data = f.tx.videoExecution.update.mock.calls[0]![0].data;
		expect(data.stageData).toMatchObject({
			timings: f.job.videoExecution.stageData.timings,
			outputSpec: {
				storageInspection: {
					schemaVersion: 1,
					verifier: "video-mp4-stream-v1",
					assetId: "asset",
					objectKey: f.asset.objectKey,
					checksum: f.output.checksum,
					etag: f.output.etag,
					bytes: 1000,
					checkedAt: new Date().toISOString(),
					constraints: videoOutputConstraints(f.job.inputSnapshot),
					metadata: {
						durationMillis: 5000,
						width: 1280,
						height: 720,
						audioTracks: 0,
						audioTrackIds: [],
						videoTracks: 1,
					},
				},
			},
		});
		expect(f.tx.mediaAsset.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					finalizedAt: new Date(),
					checksum: f.output.checksum,
					storageEtag: f.output.etag,
				}),
			}),
		);
	});
	it.each([undefined, "unknown-inspector"])(
		"does not mint provenance for an unrecognized inspection version %s",
		async (version) => {
			const f = fixture();
			const output = { ...f.output, inspectionVersion: version } as VerifiedVideoObject;
			await completeVideoOutputStorage("job", "asset", "lease", output);
			const spec = f.tx.videoExecution.update.mock.calls[0]![0].data.stageData.outputSpec;
			expect(spec).not.toHaveProperty("storageInspection");
		},
	);
	it("cannot mint a receipt after losing the storage lease", async () => {
		const f = fixture();
		await expect(completeVideoOutputStorage("job", "asset", "stale", f.output)).rejects.toThrow(
			"VIDEO_STORAGE_LEASE_STALE",
		);
		expect(f.tx.videoExecution.update).not.toHaveBeenCalled();
		expect(f.tx.mediaAsset.update).not.toHaveBeenCalled();
	});
	it("does not retroactively attest an already-finalized historical object", async () => {
		const f = fixture();
		f.asset.finalizedAt = new Date(Date.now() - 60_000);
		f.asset.checksum = f.output.checksum;
		await completeVideoOutputStorage("job", "asset", "lease", f.output);
		expect(f.tx.videoExecution.update).not.toHaveBeenCalled();
	});
	it("rejects fractional byte counts instead of creating an ambiguous identity", async () => {
		const f = fixture();
		await expect(
			completeVideoOutputStorage("job", "asset", "lease", { ...f.output, bytes: 1.5 }),
		).rejects.toThrow("VIDEO_STORED_SPECIFICATION_INVALID");
		expect(f.tx.videoExecution.update).not.toHaveBeenCalled();
	});
});
