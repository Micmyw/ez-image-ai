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
	creditsReserved: 4n,
	productKey: "image-fast",
	inputSnapshot: {
		kind: "image-to-image",
		prompt: "Private prompt",
		sourceAssetId: "asset-input",
	},
	failureCode: null,
	createdAt: new Date("2026-08-25T00:00:00.000Z"),
	updatedAt: new Date("2026-08-25T00:01:00.000Z"),
	reservation: { settledAmount: 4n, releasedAmount: 0n },
	_count: { attempts: 0 },
	attempts: [{ progress: 100, status: "SUCCEEDED", uncertainSubmission: false }],
	assets: [
		{ role: "INPUT", position: 0, asset: asset("asset-input") },
		{ role: "OUTPUT", position: 0, asset: asset("asset-output") },
	],
};

describe("getJob", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSession.mockResolvedValue({
			user: { id: "user-1" },
			session: { id: "session-1" },
		} as never);
	});

	it("returns separately bound input and approved output assets without private URLs or provider data", async () => {
		mocks.findFirst.mockResolvedValue(baseJob as never);

		const result = await call(getJob, { jobId: "job-1" }, { context: { headers: new Headers() } });

		expect(result.inputAssets.map(({ id }) => id)).toEqual(["asset-input"]);
		expect(result.assets.map(({ id }) => id)).toEqual(["asset-output"]);
		expect(result).toMatchObject({ canCancel: false, failureReason: null });
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
			reservation: { settledAmount: 0n, releasedAmount: 4n },
			assets: [
				{ role: "INPUT", position: 0, asset: asset("asset-input") },
				{
					role: "OUTPUT",
					position: 0,
					asset: {
						...asset("asset-quarantined", "QUARANTINED"),
						moderationResults: [{ status: "REJECTED" }],
					},
				},
			],
		} as never);

		const result = await call(getJob, { jobId: "job-1" }, { context: { headers: new Headers() } });

		expect(result.failureReason).toBe("CONTENT_NOT_ALLOWED");
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
});
