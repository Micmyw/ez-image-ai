import { call, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), findFirst: vi.fn() }));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@repo/database/client", () => ({
	db: { generationJob: { findFirst: mocks.findFirst } },
}));

import { getJob } from "./get-job";

const asset = (id: string, status = "READY") => ({
	id,
	ownerType: "USER",
	ownerId: "user-1",
	kind: "IMAGE",
	status,
	mimeType: "image/png",
	byteSize: 128n,
	width: 64,
	height: 64,
	durationMillis: null,
	deletedAt: null,
	createdAt: new Date("2026-08-25T00:00:00.000Z"),
	moderationResults: [{ status: "APPROVED" }],
});

const baseJob = {
	id: "job-1",
	status: "SUCCEEDED",
	version: 3,
	creditsReserved: 17n,
	productKey: "image-gpt-image-2",
	inputSnapshot: {
		kind: "image-to-image",
		prompt: "Private prompt",
		sourceAssetId: "asset-input",
		skuKey: "gpt-image-2-4k",
		aspectRatio: "4:5",
		providerModelId: "must-not-leak",
		providerCostMicros: 80_000,
	},
	failureCode: null,
	createdAt: new Date("2026-08-25T00:00:00.000Z"),
	updatedAt: new Date("2026-08-25T00:01:00.000Z"),
	reservation: { settledAmount: 17n, releasedAmount: 0n },
	_count: { attempts: 0 },
	attempts: [{ progress: 100, status: "SUCCEEDED", uncertainSubmission: false }],
	assets: [
		{ role: "INPUT", position: 0, asset: asset("asset-input") },
		{ role: "OUTPUT", position: 0, asset: asset("asset-output") },
	],
};

describe("getJob", () => {
	it.each(["WAIVED", "CHARGED"])(
		"preserves the %s moderation billing outcome after output cleanup",
		async (outcome) => {
			mocks.findFirst.mockResolvedValue({
				...baseJob,
				status: "FAILED",
				failureCode: `OUTPUT_CONTENT_BLOCKED_${outcome}`,
				assets: [],
				reservation: {
					settledAmount: outcome === "CHARGED" ? 17n : 0n,
					releasedAmount: outcome === "WAIVED" ? 17n : 0n,
				},
			});
			const result = await call(
				getJob,
				{ jobId: "job-1" },
				{ context: { headers: new Headers() } },
			);
			expect(result).toMatchObject({
				failureReason: "CONTENT_NOT_ALLOWED",
				moderationBilling: outcome,
			});
		},
	);

	it("does not describe a review requirement as a confirmed content violation", async () => {
		mocks.findFirst.mockResolvedValue({
			...baseJob,
			status: "FAILED",
			assets: [
				{
					role: "OUTPUT",
					asset: { ...asset("review", "QUARANTINED"), moderationResults: [{ status: "REVIEW" }] },
				},
			],
		});
		const result = await call(getJob, { jobId: "job-1" }, { context: { headers: new Headers() } });
		expect(result.failureReason).toBe("SAFETY_CHECK_UNAVAILABLE");
		expect(result).toHaveProperty("moderationReason", null);
		expect(result.assets).toEqual([]);
	});
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSession.mockResolvedValue({
			user: { id: "user-1" },
			session: { id: "session-1" },
		} as never);
	});

	it("preserves terminal job charges after the test ledger is archived", async () => {
		mocks.findFirst.mockResolvedValue({
			...baseJob,
			reservation: null,
			archivedCreditsCharged: 12n,
			archivedCreditsReleased: 5n,
		} as never);
		const result = await call(getJob, { jobId: "job-1" }, { context: { headers: new Headers() } });
		expect(result).toMatchObject({ creditsCharged: "12", creditsReleased: "5", canCancel: false });
		expect(result.assets.map(({ id }) => id)).toEqual(["asset-output"]);
	});

	it("returns separately bound input and approved output assets without private URLs or provider data", async () => {
		mocks.findFirst.mockResolvedValue(baseJob as never);

		const result = await call(getJob, { jobId: "job-1" }, { context: { headers: new Headers() } });

		expect(result.inputAssets.map(({ id }) => id)).toEqual(["asset-input"]);
		expect(result.assets.map(({ id }) => id)).toEqual(["asset-output"]);
		expect(result).toMatchObject({
			canCancel: false,
			failureReason: null,
			skuKey: "gpt-image-2-4k",
			aspectRatio: "4:5",
			input: {
				kind: "image-to-image",
				prompt: "Private prompt",
				sourceAssetId: "asset-input",
				skuKey: "gpt-image-2-4k",
				aspectRatio: "4:5",
			},
		});
		expect(JSON.stringify(result)).not.toMatch(/signed|https?:|provider|model/i);
		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "job-1", ownerType: "USER", ownerId: "user-1" },
			}),
		);
	});

	it("marks only server-cancelable states as cancelable", async () => {
		mocks.findFirst.mockResolvedValue({
			...baseJob,
			status: "PROVIDER_RUNNING",
			attempts: [{ progress: 42, status: "RUNNING", uncertainSubmission: false }],
		} as never);

		await expect(
			call(getJob, { jobId: "job-1" }, { context: { headers: new Headers() } }),
		).resolves.toMatchObject({ canCancel: true });

		mocks.findFirst.mockResolvedValue({
			...baseJob,
			status: "SUBMITTING",
			attempts: [{ progress: null, status: "SUBMITTING", uncertainSubmission: false }],
		} as never);
		await expect(
			call(getJob, { jobId: "job-1" }, { context: { headers: new Headers() } }),
		).resolves.toMatchObject({ canCancel: false });
	});

	it("disables cancellation when any attempt still requires reconciliation", async () => {
		mocks.findFirst.mockResolvedValue({
			...baseJob,
			status: "PROVIDER_RUNNING",
			attempts: [{ progress: 42, status: "RUNNING", uncertainSubmission: false }],
			_count: { attempts: 1 },
		} as never);

		await expect(
			call(getJob, { jobId: "job-1" }, { context: { headers: new Headers() } }),
		).resolves.toMatchObject({ canCancel: false });
	});

	it("exposes a safe moderation-rejection reason without returning the quarantined output", async () => {
		mocks.findFirst.mockResolvedValue({
			...baseJob,
			status: "FAILED",
			reservation: { settledAmount: 0n, releasedAmount: 17n },
			assets: [
				{ role: "INPUT", position: 0, asset: asset("asset-input") },
				{
					role: "OUTPUT",
					position: 0,
					asset: {
						...asset("asset-quarantined", "QUARANTINED"),
						moderationResults: [{ status: "REJECTED", reasonCode: "SEXUAL_CONTENT" }],
					},
				},
			],
		} as never);

		const result = await call(getJob, { jobId: "job-1" }, { context: { headers: new Headers() } });

		expect(result.failureReason).toBe("CONTENT_NOT_ALLOWED");
		expect(result).toHaveProperty("moderationReason", "sexualContent");
		expect(result.assets).toEqual([]);
		expect(JSON.stringify(result)).not.toContain("asset-quarantined");
	});

	it("returns not found for a job outside the authenticated tenant boundary", async () => {
		mocks.findFirst.mockResolvedValue(null);

		await expect(
			call(getJob, { jobId: "job-other" }, { context: { headers: new Headers() } }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "job-other", ownerType: "USER", ownerId: "user-1" },
			}),
		);
	});

	it("does not expose an asset binding owned by another tenant", async () => {
		mocks.findFirst.mockResolvedValue({
			...baseJob,
			assets: [
				{
					role: "INPUT",
					position: 0,
					asset: { ...asset("asset-foreign-input"), ownerId: "user-2" },
				},
				{
					role: "OUTPUT",
					position: 0,
					asset: { ...asset("asset-foreign-output"), ownerId: "user-2" },
				},
			],
		} as never);

		const result = await call(getJob, { jobId: "job-1" }, { context: { headers: new Headers() } });

		expect(result.inputAssets).toEqual([]);
		expect(result.assets).toEqual([]);
		expect(JSON.stringify(result)).not.toContain("asset-foreign");
	});

	it("does not present a legacy job as a current Kie SKU", async () => {
		mocks.findFirst.mockResolvedValue({
			...baseJob,
			productKey: "image-fast",
			inputSnapshot: {
				kind: "image-to-image",
				prompt: "Legacy prompt",
				sourceAssetId: "asset-input",
				aspectRatio: "16:9",
			},
		} as never);

		await expect(
			call(getJob, { jobId: "job-1" }, { context: { headers: new Headers() } }),
		).resolves.toMatchObject({
			productKey: "image-fast",
			skuKey: null,
			aspectRatio: null,
		});
	});
});
