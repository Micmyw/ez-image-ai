import { describe, expect, it, vi } from "vitest";

// These transaction tests explicitly supply their database boundary. Never
// load or replace the absent generated Prisma runtime.
vi.mock("../../client", () => ({
	getDatabaseClient: vi.fn(() => {
		throw new Error("UNEXPECTED_DEFAULT_CLIENT");
	}),
}));
import { finalizeGuestDraftFromReadyUploadTransaction } from "./drafts";
import { loadGuestUploadCompletion } from "./guest-bootstrap";

const now = new Date("2026-10-19T12:00:00Z");
const validUntil = new Date("2026-10-20T12:00:00Z");
const request = {
	sessionId: "session-1",
	completionTokenHash: "b".repeat(64),
	consumedTokenHash: "c".repeat(64),
	claimTokenHash: "d".repeat(64),
	capabilityVersion: "capability-v1",
	promotionPeriod: "launch",
	maximumOutstandingBootstraps: 25,
	productKey: "image-nano-banana-2-lite" as const,
	skuKey: "nano-banana-2-lite-1k" as const,
	prompt: "Preserve the reference",
	expiresAt: validUntil,
	verification: { provider: "seeapi", ruleVersion: "rule-v1", policyVersion: "policy-v1", now },
};
function asset(
	status: string,
	evidenceStatus = "REJECTED",
	reasonCode = "SEEAPI_CONTENT_NOT_ALLOWED",
) {
	return {
		id: "asset-1",
		ownerType: "USER",
		ownerId: "guest-owner",
		kind: "INPUT",
		mimeType: "image/png",
		status,
		deletedAt: null,
		checksum: "a".repeat(64),
		verificationGeneration: 1,
		verificationAttemptCount: 1,
		verificationProvider: "seeapi",
		verificationProviderTaskId: "task-1",
		verificationRuleVersion: "rule-v1",
		verificationPolicyVersion: "policy-v1",
		verificationValidUntil: validUntil,
		moderationResults: [
			{
				status: evidenceStatus,
				reasonCode,
				assetChecksum: "a".repeat(64),
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "INPUT",
				provider: "seeapi",
				providerTaskId: "task-1",
				ruleVersion: "rule-v1",
				policyVersion: "policy-v1",
				validUntil,
			},
		],
		jobBindings: [],
	};
}
function fixture(value: ReturnType<typeof asset> | null) {
	const tx = {
		$executeRaw: vi.fn(),
		mediaUploadSession: {
			findFirst: vi
				.fn()
				.mockResolvedValue(value ? { id: "session-1", assetId: value.id, asset: value } : null),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		generationDraft: {
			create: vi.fn().mockResolvedValue({ id: "draft-1", expiresAt: validUntil }),
		},
		guestSessionBootstrap: {
			count: vi.fn().mockResolvedValue(0),
			create: vi.fn().mockResolvedValue({ id: "bootstrap-1" }),
		},
	};
	return {
		tx,
		client: { $transaction: async (operation: (tx: unknown) => unknown) => operation(tx) },
	};
}
describe("guest upload terminal projection", () => {
	it("retains the original current-approved authorization and one-use claim consumption", async () => {
		const { tx, client } = fixture(asset("READY", "APPROVED", "ALLOW"));
		await expect(
			finalizeGuestDraftFromReadyUploadTransaction(request, client as never),
		).resolves.toEqual({ id: "draft-1", expiresAt: validUntil });
		expect(tx.mediaUploadSession.updateMany).toHaveBeenCalledOnce();
		expect(tx.generationDraft.create).toHaveBeenCalledOnce();
	});
	it.each([{ deletedAt: now }, { deleteAfter: now }])(
		"rejects a no-longer-available asset even with an otherwise valid approval %s",
		async (patch) => {
			const value = asset("READY", "APPROVED", "ALLOW");
			Object.assign(value, patch);
			const { tx, client } = fixture(value);
			await expect(
				finalizeGuestDraftFromReadyUploadTransaction(request, client as never),
			).rejects.toThrow("GUEST_UPLOAD_UNAVAILABLE");
			expect(tx.generationDraft.create).not.toHaveBeenCalled();
		},
	);
	it("does not label an unrecognized technical rejection as prohibited content", async () => {
		const { client } = fixture(asset("QUARANTINED", "REJECTED", "PROVIDER_REQUEST_FAILED"));
		await expect(
			finalizeGuestDraftFromReadyUploadTransaction(request, client as never),
		).rejects.toThrow("GUEST_UPLOAD_SAFETY_UNAVAILABLE");
	});
	it.each([
		["QUARANTINED", "REJECTED", "SEEAPI_CONTENT_NOT_ALLOWED", "GUEST_UPLOAD_CONTENT_REJECTED"],
		["QUARANTINED", "REVIEW", "IMAGE_MANUAL_REVIEW", "GUEST_UPLOAD_REVIEW_REQUIRED"],
		["VERIFICATION_FAILED", "ERROR", "SERVICE_UNAVAILABLE", "GUEST_UPLOAD_SAFETY_UNAVAILABLE"],
	] as const)(
		"returns a stable terminal outcome for %s/%s",
		async (status, evidenceStatus, reason, error) => {
			const { tx, client } = fixture(asset(status, evidenceStatus, reason));
			await expect(
				finalizeGuestDraftFromReadyUploadTransaction(request, client as never),
			).rejects.toThrow(error);
			expect(tx.mediaUploadSession.updateMany).not.toHaveBeenCalled();
			expect(tx.generationDraft.create).not.toHaveBeenCalled();
		},
	);
	it("keeps a genuinely unfinished review pending", async () => {
		const { client } = fixture(asset("VERIFYING", "PENDING", "IMAGE_PROCESSING"));
		await expect(
			finalizeGuestDraftFromReadyUploadTransaction(request, client as never),
		).rejects.toThrow("GUEST_UPLOAD_NOT_READY");
	});
	it.each(["assetChecksum", "providerTaskId", "policyVersion", "verificationGeneration"])(
		"does not call stale %s evidence a content violation",
		async (field) => {
			const value = asset("QUARANTINED");
			Object.assign(value.moderationResults[0]!, {
				[field]: field === "verificationGeneration" ? 0 : "stale",
			});
			const { client } = fixture(value);
			await expect(
				finalizeGuestDraftFromReadyUploadTransaction(request, client as never),
			).rejects.toThrow("GUEST_UPLOAD_SAFETY_UNAVAILABLE");
		},
	);
	it("refuses an expired, consumed or unavailable session before creating a draft", async () => {
		const { tx, client } = fixture(null);
		await expect(
			finalizeGuestDraftFromReadyUploadTransaction(request, client as never),
		).rejects.toThrow("GUEST_UPLOAD_UNAVAILABLE");
		expect(tx.mediaUploadSession.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					tokenHash: request.completionTokenHash,
					guestCompletionConsumedAt: null,
					expiresAt: { gt: now },
				}),
			}),
		);
	});
	it("retains the original secret/origin/content and expiry checks on completion retry", async () => {
		const findFirst = vi.fn().mockResolvedValue(null);
		const input = {
			sessionId: "session-1",
			completionTokenHash: "owner-token-hash",
			capabilityVersion: "capability-v1",
			originHash: "origin-hash",
			expectedSha256: "a".repeat(64),
			now,
		};
		await expect(
			loadGuestUploadCompletion(input, { mediaUploadSession: { findFirst } } as never),
		).rejects.toThrow("GUEST_UPLOAD_UNAVAILABLE");
		expect(findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: input.sessionId,
					tokenHash: input.completionTokenHash,
					guestOriginHash: input.originHash,
					guestExpectedSha256: input.expectedSha256,
					expiresAt: { gt: now },
					guestCompletionConsumedAt: null,
					asset: { retentionClass: "GUEST_TRIAL", deletedAt: null },
				}),
			}),
		);
	});
});
