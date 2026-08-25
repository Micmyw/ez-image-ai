import { call, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	getImageEditSessionForOwner: vi.fn(),
}));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@repo/database", () => ({
	getImageEditSessionForOwner: mocks.getImageEditSessionForOwner,
}));
vi.mock("@repo/database/client", () => ({ db: {} }));

import { getEditSession } from "./get-edit-session";

const readyOutput = {
	id: "asset-output-1",
	ownerType: "USER",
	ownerId: "user-1",
	status: "READY",
	deletedAt: null,
	mimeType: "image/png",
	objectKey: "users/user-1/private/output.png",
	moderationResults: [{ status: "APPROVED", provider: "private-provider" }],
};

describe("getEditSession", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSession.mockResolvedValue({
			user: { id: "user-1" },
			session: { id: "auth-session-1" },
		} as never);
	});

	it("returns a private image-only prompt timeline without provider, model, cost, or signed URLs", async () => {
		mocks.getImageEditSessionForOwner.mockResolvedValue({
			id: "session-1",
			ownerType: "USER",
			ownerId: "user-1",
			rootAssetId: "asset-root",
			title: "Hero revisions",
			createdAt: new Date("2026-08-25T00:00:00.000Z"),
			updatedAt: new Date("2026-08-25T02:00:00.000Z"),
			jobs: [
				{
					id: "job-root",
					parentJobId: null,
					productKey: "image-fast",
					status: "SUCCEEDED",
					creditsReserved: 4n,
					inputSnapshot: {
						kind: "image-to-image",
						prompt: "Make the background warm",
						sourceAssetId: "asset-root",
					},
					pricingSnapshot: { providerModelId: "must-not-leak", costMicros: "42" },
					createdAt: new Date("2026-08-25T00:01:00.000Z"),
					reservation: { settledAmount: 4n, releasedAmount: 0n },
					assets: [{ role: "OUTPUT", position: 0, asset: readyOutput }],
				},
				{
					id: "job-child-failed",
					parentJobId: "job-root",
					productKey: "image-quality",
					status: "FAILED",
					creditsReserved: 8n,
					inputSnapshot: {
						kind: "image-to-image",
						prompt: "Try a softer shadow",
						sourceAssetId: "asset-output-1",
					},
					createdAt: new Date("2026-08-25T00:02:00.000Z"),
					reservation: { settledAmount: 0n, releasedAmount: 8n },
					assets: [
						{
							role: "OUTPUT",
							position: 0,
							asset: {
								...readyOutput,
								id: "asset-deleted",
								status: "DELETED",
								deletedAt: new Date("2026-08-25T01:00:00.000Z"),
							},
						},
					],
				},
			],
		});

		const result = await call(
			getEditSession,
			{ sessionId: "session-1" },
			{ context: { headers: new Headers() } },
		);

		expect(result).toMatchObject({
			id: "session-1",
			title: "Hero revisions",
			rootAssetId: "asset-root",
			versions: [
				{
					id: "job-root",
					parentJobId: null,
					productKey: "image-fast",
					prompt: "Make the background warm",
					sourceAssetId: "asset-root",
					credits: "4",
					status: "SUCCEEDED",
					output: { state: "READY", assetId: "asset-output-1" },
					canEditAgain: true,
				},
				{
					id: "job-child-failed",
					parentJobId: "job-root",
					productKey: "image-quality",
					prompt: "Try a softer shadow",
					credits: "8",
					status: "FAILED",
					output: { state: "DELETED", assetId: null },
					canEditAgain: false,
				},
			],
		});
		const serialized = JSON.stringify(result);
		expect(serialized).not.toMatch(/provider|model|cost|objectKey|https?:\/\//i);
		expect(mocks.getImageEditSessionForOwner).toHaveBeenCalledWith(
			{ ownerType: "USER", ownerId: "user-1", sessionId: "session-1" },
			expect.anything(),
		);
	});

	it("returns the same NOT_FOUND boundary for a session outside the current owner", async () => {
		mocks.getImageEditSessionForOwner.mockResolvedValue(null);

		await expect(
			call(
				getEditSession,
				{ sessionId: "session-foreign" },
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" } satisfies Partial<ORPCError<string, unknown>>);
	});
});
