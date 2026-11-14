import { describe, expect, it, vi } from "vitest";

import { getAdminImageContent, listAdminImageContent } from "./admin-content";
import type { MediaTransactionClient } from "./types";

const createdAt = new Date("2026-11-14T01:00:00Z");
function image(patch: Record<string, unknown> = {}) {
	return {
		id: "output",
		ownerType: "USER",
		ownerId: "customer",
		kind: "OUTPUT",
		status: "QUARANTINED",
		mimeType: "image/png",
		objectKey: "private/output",
		checksum: "checksum",
		finalizedAt: createdAt,
		deletedAt: null,
		createdAt,
		verificationGeneration: 1,
		verificationAttemptCount: 2,
		verificationProvider: "seeapi",
		verificationProviderTaskId: "detector-task",
		verificationLastErrorCode: "SEEAPI_CONTENT_NOT_ALLOWED",
		moderationResults: [
			{
				id: "evidence",
				provider: "seeapi",
				providerTaskId: "detector-task",
				status: "REJECTED",
				reasonCode: "SEEAPI_CONTENT_NOT_ALLOWED",
				createdAt,
				assetChecksum: "checksum",
				verificationGeneration: 1,
				attemptNumber: 2,
				evidenceKind: "OUTPUT",
				rawEnvelope: {
					decision: "REJECT",
					evidence: {
						seeapi: {
							flagged: true,
							nsfw: ["sexual_activity"],
							specialCare: ["possible_minor"],
						},
						secret: "never-return",
					},
				},
			},
		],
		...patch,
	};
}
function fixture() {
	const asset = image();
	const tx = {
		mediaAsset: {
			findMany: vi.fn().mockResolvedValue([asset]),
			findFirst: vi.fn().mockResolvedValue(asset),
		},
		generationJobAsset: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
		auditLog: {
			create: vi.fn(),
			findMany: vi.fn().mockResolvedValue([]),
			findFirst: vi.fn().mockResolvedValue(null),
		},
		outboxEvent: { findFirst: vi.fn().mockResolvedValue(null) },
	};
	return { tx: tx as unknown as MediaTransactionClient, mocks: tx };
}

describe("administrator customer image inspection", () => {
	it("filters guest retention separately and audits every administrator list request", async () => {
		const { tx, mocks } = fixture();
		await listAdminImageContent({ limit: 10, audience: "GUEST" }, tx, "admin");
		expect(mocks.mediaAsset.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ retentionClass: "GUEST_TRIAL" }),
			}),
		);
		expect(mocks.auditLog.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					action: "MEDIA_CUSTOMER_CONTENT_LISTED",
					actorUserId: "admin",
				}),
			}),
		);
	});
	it("lists ordinary rejected output without requiring a moderationReview record", async () => {
		const { tx, mocks } = fixture();
		const result = await listAdminImageContent({ limit: 25, status: "QUARANTINED" }, tx);
		expect(result.items[0]).toMatchObject({
			id: "output",
			kind: "OUTPUT",
			provider: "seeapi",
			reasonCode: "SEEAPI_CONTENT_NOT_ALLOWED",
		});
		expect(mocks.mediaAsset.findMany.mock.calls[0]?.[0]).toMatchObject({
			where: { status: "QUARANTINED", mimeType: { startsWith: "image/" } },
			take: 26,
		});
		expect(JSON.stringify(result)).not.toMatch(/objectKey|rawEnvelope|checksum|never-return/);
	});

	it("shows a sealed input with no generation job and retains saved prompt context", async () => {
		const { tx, mocks } = fixture();
		mocks.mediaAsset.findFirst.mockResolvedValue(
			image({ id: "input", kind: "INPUT", moderationResults: [] }),
		);
		const result = await getAdminImageContent({ assetId: "input" }, "admin", tx);
		expect(result.image).toMatchObject({ id: "input", kind: "INPUT", availability: "AVAILABLE" });
		expect(result.jobs).toEqual([]);
		expect(mocks.auditLog.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					actorUserId: "admin",
					action: "MEDIA_CUSTOMER_CONTENT_VIEWED",
					targetId: "input",
				}),
			}),
		);
	});

	it("returns bounded classifier labels rather than the raw detector envelope", async () => {
		const { tx } = fixture();
		const result = await getAdminImageContent({ assetId: "output" }, "admin", tx);
		expect(result.image.review).toMatchObject({
			current: true,
			flagged: true,
			nsfw: ["sexual_activity"],
			specialCare: ["possible_minor"],
		});
		expect(JSON.stringify(result)).not.toMatch(/rawEnvelope|never-return/);
	});
	it("shows a blocked Waffo prompt attached to an upload even when no job was created", async () => {
		const { tx, mocks } = fixture();
		mocks.auditLog.findMany.mockResolvedValueOnce([
			{
				id: "blocked",
				createdAt,
				metadata: {
					sourceAssetId: "output",
					productKey: "image-minimax-h3",
					prompt: 'Photo editing request api_key="secret"',
				},
				after: {
					provider: "waffo",
					decision: "REJECT",
					reasonCode: "TEXT_CONTENT_NOT_ALLOWED",
					evidence: {
						waffo: { action: "block", semanticStatus: "scored", matchedCategories: ["adult_nsfw"] },
					},
				},
			},
		] as never);
		const result = await getAdminImageContent({ assetId: "output" }, "admin", tx);
		expect(result.jobs).toEqual([]);
		expect(result.promptRecords[0]).toMatchObject({ source: "BLOCKED_REQUEST", jobId: null });
		expect(result.promptReviews[0]).toMatchObject({
			provider: "waffo",
			categories: ["adult_nsfw"],
		});
		expect(JSON.stringify(result)).not.toContain("secret");
	});

	it("does not expose deleted or unfinished object keys as previews", async () => {
		const { tx, mocks } = fixture();
		mocks.mediaAsset.findFirst.mockResolvedValue(
			image({ deletedAt: createdAt, status: "DELETED" }),
		);
		const deleted = await getAdminImageContent({ assetId: "output" }, "admin", tx);
		expect(deleted.image).toMatchObject({ availability: "DELETED", previewKey: null });
		mocks.mediaAsset.findFirst.mockResolvedValue(image({ checksum: null, finalizedAt: null }));
		const unfinished = await getAdminImageContent({ assetId: "output" }, "admin", tx);
		expect(unfinished.image).toMatchObject({ availability: "UNFINALIZED", previewKey: null });
	});

	it("rejects a job that is not bound to the inspected image", async () => {
		const { tx } = fixture();
		await expect(
			getAdminImageContent({ assetId: "output", jobId: "unrelated" }, "admin", tx),
		).rejects.toThrow("ADMIN_CONTENT_JOB_NOT_FOUND");
	});

	it("inspects a bound historical job outside the latest ten and preserves an output reused as input", async () => {
		const { tx, mocks } = fixture();
		const recent = Array.from({ length: 10 }, (_, index) => ({
			job: {
				id: `recent-${index}`,
				status: "SUCCEEDED",
				productKey: "image-minimax-h3",
				failureCode: null,
				createdAt,
			},
		}));
		mocks.generationJobAsset.findMany.mockResolvedValue(recent as never);
		mocks.generationJobAsset.findFirst.mockResolvedValue({
			assetChecksum: "checksum",
			role: "INPUT",
			job: {
				id: "older-job",
				status: "SUCCEEDED",
				productKey: "image-minimax-h3",
				failureCode: null,
				createdAt,
				inputSnapshot: { prompt: "Edit the prior output" },
				assets: [],
			},
		} as never);
		const result = await getAdminImageContent(
			{ assetId: "output", jobId: "older-job" },
			"admin",
			tx,
		);
		expect(result.selectedJobId).toBe("older-job");
		expect(result.jobs).toHaveLength(10);
		expect(result.jobs[0]?.id).toBe("older-job");
		expect(result.image).toMatchObject({
			kind: "OUTPUT",
			role: "INPUT",
			availability: "AVAILABLE",
		});
	});

	it("marks historical classifier evidence and changed job bindings explicitly", async () => {
		const { tx, mocks } = fixture();
		mocks.mediaAsset.findFirst.mockResolvedValue(image({ verificationGeneration: 2 }));
		mocks.generationJobAsset.findMany.mockResolvedValue([
			{
				job: {
					id: "job",
					status: "FAILED",
					productKey: "image-minimax-h3",
					failureCode: "OUTPUT_CONTENT_BLOCKED_WAIVED",
					createdAt,
				},
			},
		] as never);
		mocks.generationJobAsset.findFirst.mockResolvedValue({
			assetChecksum: "checksum",
			job: {
				id: "job",
				inputSnapshot: { prompt: "customer prompt" },
				assets: [
					{
						role: "INPUT",
						assetChecksum: "old-content",
						asset: image({ id: "input", kind: "INPUT" }),
					},
				],
			},
		} as never);
		const result = await getAdminImageContent({ assetId: "output" }, "admin", tx);
		expect(result.image.review?.current).toBe(false);
		expect(result.relatedImages[0]).toMatchObject({ availability: "CHANGED", previewKey: null });
	});
});
