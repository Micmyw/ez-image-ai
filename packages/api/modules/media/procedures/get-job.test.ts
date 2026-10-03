import { call, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	findFirst: vi.fn(),
	sign: vi.fn(async () => "https://private.test/preview"),
}));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@repo/database/client", () => ({
	db: { generationJob: { findFirst: mocks.findFirst } },
}));
vi.mock("@repo/storage", () => ({ createSignedReadUrl: mocks.sign }));

import { currentMediaAssetVerificationBoundary } from "../lib/asset-authorization";
import { getJob } from "./get-job";

const boundary = currentMediaAssetVerificationBoundary();
const validUntil = new Date("2099-01-01T00:00:00Z");

const asset = (id: string, status = "READY") => ({
	id,
	ownerType: "USER",
	ownerId: "user-1",
	kind: id.includes("input") ? "INPUT" : "OUTPUT",
	status,
	mimeType: "image/png",
	byteSize: 128n,
	width: 64,
	height: 64,
	durationMillis: null,
	objectKey: `private/${id}`,
	checksum: "a".repeat(64),
	verificationGeneration: 1,
	verificationAttemptCount: 1,
	verificationProvider: boundary.provider,
	verificationProviderTaskId: "audit-1",
	verificationRuleVersion: boundary.ruleVersion,
	verificationPolicyVersion: boundary.policyVersion,
	verificationValidUntil: validUntil,
	deleteAfter: null,
	deletedAt: null,
	updatedAt: new Date("2026-08-25T00:00:00.000Z"),
	createdAt: new Date("2026-08-25T00:00:00.000Z"),
	moderationResults: [
		{
			id: "audit-1",
			status: "APPROVED",
			assetChecksum: "a".repeat(64),
			verificationGeneration: 1,
			attemptNumber: 1,
			evidenceKind: id.includes("input") ? "INPUT" : "OUTPUT",
			provider: boundary.provider,
			providerTaskId: "audit-1",
			ruleVersion: boundary.ruleVersion,
			policyVersion: boundary.policyVersion,
			validUntil,
			createdAt: new Date("2026-08-25T00:00:00.000Z"),
		},
	],
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
	it("projects only required database fields and includes an authorized preview in one response", async () => {
		mocks.findFirst.mockResolvedValue(baseJob);
		const responseHeaders = new Headers();
		const result = await call(
			getJob,
			{ jobId: "job-1" },
			{ context: { headers: new Headers(), responseHeaders, requestId: "request-1" } },
		);
		expect(responseHeaders.get("Cache-Control")).toBe("private, no-store");
		expect(result.assets[0]).toMatchObject({
			preview: { url: "https://private.test/preview" },
			contentVersion: expect.any(String),
		});
		expect(result).toMatchObject({
			requestId: "request-1",
			displayVersion: expect.any(String),
			observedAt: expect.any(Number),
		});
		const query = mocks.findFirst.mock.calls[0][0];
		expect(query).not.toHaveProperty("include");
		expect(query.select.reservation).toEqual({
			select: { status: true, settledAmount: true, releasedAmount: true },
		});
		expect(query.select.assets.select.asset.select).not.toHaveProperty("rawEnvelope");
		expect(query.select.assets.select.asset.select).not.toHaveProperty("verificationLastError");
	});
	it.each(["PENDING", "REJECTED", "ERROR", "REVIEW", "BYPASSED"])(
		"does not sign %s as approved",
		async (status) => {
			const output = asset("blocked");
			output.moderationResults[0].status = status;
			mocks.findFirst.mockResolvedValue({
				...baseJob,
				assets: [{ role: "OUTPUT", asset: output }],
			});
			const result = await call(
				getJob,
				{ jobId: "job-1" },
				{ context: { headers: new Headers() } },
			);
			expect(result.assets).toEqual([]);
			expect(mocks.sign).not.toHaveBeenCalled();
		},
	);
	it("retains only the existing technical-outage bypass policy", async () => {
		const { MODERATION_BYPASS_REASON } = await import("@repo/config");
		const output = asset("bypassed");
		Object.assign(output.moderationResults[0], {
			status: "BYPASSED",
			reasonCode: MODERATION_BYPASS_REASON,
		});
		mocks.findFirst.mockResolvedValue({ ...baseJob, assets: [{ role: "OUTPUT", asset: output }] });
		const result = await call(getJob, { jobId: "job-1" }, { context: { headers: new Headers() } });
		expect(result.assets[0]).toHaveProperty("preview.url");
	});
	it.each([
		{ deleteAfter: new Date(0) },
		{ deletedAt: new Date() },
		{ status: "QUARANTINED" },
		{ verificationValidUntil: new Date(0) },
		{ verificationGeneration: 2 },
		{ checksum: "b".repeat(64) },
		{ verificationPolicyVersion: "old-policy" },
		{ ownerType: "GUEST" },
	])("never signs expired, revoked, mismatched or guest assets: %j", async (changes) => {
		mocks.findFirst.mockResolvedValue({
			...baseJob,
			assets: [{ role: "OUTPUT", asset: { ...asset("blocked"), ...changes } }],
		});
		expect(
			(await call(getJob, { jobId: "job-1" }, { context: { headers: new Headers() } })).assets,
		).toEqual([]);
		expect(mocks.sign).not.toHaveBeenCalled();
	});
	it("changes displayVersion on revocation even without job.version changing", async () => {
		mocks.findFirst.mockResolvedValue(baseJob);
		const before = await call(getJob, { jobId: "job-1" }, { context: { headers: new Headers() } });
		mocks.findFirst.mockResolvedValue({ ...baseJob, assets: [] });
		const after = await call(getJob, { jobId: "job-1" }, { context: { headers: new Headers() } });
		expect(after.version).toBe(before.version);
		expect(after.displayVersion).not.toBe(before.displayVersion);
	});
	it.each(["GENERATION_TIMEOUT", "GENERATION_SERVICE_UNAVAILABLE"])(
		"returns %s with retry only after credits settle",
		async (failureCode) => {
			const failed = {
				...baseJob,
				status: "FAILED",
				failureCode,
				assets: [{ role: "INPUT", position: 0, asset: asset("asset-input") }],
				reservation: { status: "ACTIVE", settledAmount: 0n, releasedAmount: 0n },
			};
			mocks.findFirst.mockResolvedValue(failed);
			expect(
				await call(getJob, { jobId: "job-1" }, { context: { headers: new Headers() } }),
			).toMatchObject({ failureReason: failureCode, creditsReleased: "0", canRetry: false });
			mocks.findFirst.mockResolvedValue({
				...failed,
				reservation: { status: "SETTLED", settledAmount: 0n, releasedAmount: 17n },
			});
			expect(
				await call(getJob, { jobId: "job-1" }, { context: { headers: new Headers() } }),
			).toMatchObject({ failureReason: failureCode, creditsReleased: "17", canRetry: true });
			mocks.findFirst.mockResolvedValue({ ...failed, status: "NEEDS_RECONCILIATION" });
			expect(
				await call(getJob, { jobId: "job-1" }, { context: { headers: new Headers() } }),
			).toMatchObject({ canRetry: false });
		},
	);

	it("does not offer one-click retry after the reference expires", async () => {
		mocks.findFirst.mockResolvedValue({
			...baseJob,
			status: "FAILED",
			failureCode: "GENERATION_TIMEOUT",
			reservation: { status: "SETTLED", settledAmount: 0n, releasedAmount: 17n },
			assets: [{ role: "INPUT", asset: { ...asset("asset-input"), deleteAfter: new Date(0) } }],
		});
		expect(
			await call(getJob, { jobId: "job-1" }, { context: { headers: new Headers() } }),
		).toMatchObject({
			failureReason: "GENERATION_TIMEOUT",
			canRetry: false,
			inputReferenceState: "EXPIRED",
		});
	});
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

	it.each(["FINALIZING", "SUCCEEDED"])(
		"returns approved %s outputs independently of settlement without private routing data",
		async (status) => {
			mocks.findFirst.mockResolvedValue({
				...baseJob,
				status,
				...(status === "FINALIZING"
					? { reservation: { settledAmount: 0n, releasedAmount: 0n } }
					: {}),
			});

			const result = await call(
				getJob,
				{ jobId: "job-1" },
				{ context: { headers: new Headers() } },
			);

			expect(result.inputAssets.map(({ id }) => id)).toEqual(["asset-input"]);
			expect(result.assets.map(({ id }) => id)).toEqual(["asset-output"]);
			expect(result).toMatchObject({
				status,
				creditsCharged: status === "FINALIZING" ? "0" : "17",
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
			expect(JSON.stringify(result)).not.toMatch(
				/must-not-leak|providerModelId|providerCostMicros|objectKey|assetChecksum/,
			);
			expect(mocks.findFirst).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { id: "job-1", ownerType: "USER", ownerId: "user-1" },
				}),
			);
		},
	);

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
