import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
	createUpload: vi.fn(),
	finalizeDraft: vi.fn(),
	loadCompletion: vi.fn(),
	resolveOverride: vi.fn(),
}));
const storageMocks = vi.hoisted(() => ({
	createSignedUpload: vi.fn(),
	headObject: vi.fn(),
}));
const uploadMocks = vi.hoisted(() => ({ completeOwnedUploadSession: vi.fn() }));
const turnstileMocks = vi.hoisted(() => ({ verifyGuestTurnstileToken: vi.fn() }));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({
	createGuestMediaUploadIntentTransaction: databaseMocks.createUpload,
	finalizeGuestDraftFromReadyUploadTransaction: databaseMocks.finalizeDraft,
	loadGuestUploadCompletion: databaseMocks.loadCompletion,
	resolveGuestRuntimeConfigOverride: databaseMocks.resolveOverride,
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/storage", () => ({
	createFinalAssetObjectKey: vi.fn(
		() => "users/guest_owner/assets/asset_1/versions/version_1/original.png",
	),
	createSignedUpload: storageMocks.createSignedUpload,
	createStagingObjectKey: vi.fn(() => "users/guest_owner/staging/session_1/nonce.png"),
	headObject: storageMocks.headObject,
}));
vi.mock("../procedures/complete-upload-session", () => ({
	completeOwnedUploadSession: uploadMocks.completeOwnedUploadSession,
}));
vi.mock("./turnstile", () => ({
	cloudflareTurnstileVerifier: vi.fn(),
	databaseTurnstileTokenConsumer: vi.fn(),
	verifyGuestTurnstileToken: turnstileMocks.verifyGuestTurnstileToken,
}));

import { completeGuestDraftUpload } from "../procedures/complete-guest-upload";
import { createGuestDraftUploadIntent } from "../procedures/create-guest-upload-intent";
import { assertGuestCapabilityVersion, loadGuestCapabilitySnapshot } from "./guest-capability";

const enabledEnvironment = {
	NODE_ENV: "development",
	GUEST_MEDIA_ENABLED: "true",
	GUEST_PROMOTION_PERIOD: "2026-launch",
	BETTER_AUTH_SECRET: "test-secret",
	NEXT_PUBLIC_MARKETING_URL: "https://marketing.test",
	MEDIA_TRUSTED_PROXY_PROVIDER: "cloudflare",
};
const capabilityOverride = { enabled: true as const, version: 17 };

describe("guest capability snapshot", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		databaseMocks.resolveOverride.mockResolvedValue(capabilityOverride);
	});

	it("requires both the environment gate and active literal-true database override", async () => {
		await expect(loadGuestCapabilitySnapshot(enabledEnvironment)).resolves.toMatchObject({
			enabled: true,
			reason: null,
			upload: { maximumBytes: 10 * 1024 * 1024 },
			product: { key: "image-fast", label: "Standard Edit", credits: "4" },
		});

		databaseMocks.resolveOverride.mockResolvedValue(null);
		await expect(loadGuestCapabilitySnapshot(enabledEnvironment)).resolves.toMatchObject({
			enabled: false,
			reason: "GUEST_RUNTIME_DISABLED",
		});
	});

	it("fails closed when the runtime source throws and exposes only the public contract", async () => {
		databaseMocks.resolveOverride.mockRejectedValue(new Error("database unavailable"));
		const snapshot = await loadGuestCapabilitySnapshot({
			...enabledEnvironment,
			GUEST_TURNSTILE_SECRET_KEY: "private-turnstile-secret",
			GUEST_HARD_BUDGET_MICROS: "1000000",
			GUEST_COST_EVIDENCE_ID: "private-provider-evidence",
		});
		const serialized = JSON.stringify(snapshot);

		expect(snapshot.enabled).toBe(false);
		expect(serialized).not.toMatch(
			/turnstile|secret|budget|provider|model|cost|storageObject|bucketName|hmac|proxy/i,
		);
		expect(Object.keys(snapshot).sort()).toEqual([
			"enabled",
			"product",
			"queueEstimate",
			"reason",
			"upload",
			"version",
		]);
	});

	it("fails closed when the selected and completed capability versions differ", () => {
		expect(() => assertGuestCapabilityVersion("guest-v17", "guest-v16")).toThrow(
			"GUEST_CAPABILITY_CHANGED",
		);
	});
});

describe("guest private upload handoff", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("NODE_ENV", "development");
		vi.stubEnv("GUEST_MEDIA_ENABLED", "true");
		vi.stubEnv("GUEST_PROMOTION_PERIOD", "2026-launch");
		vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
		vi.stubEnv("NEXT_PUBLIC_MARKETING_URL", "https://marketing.test");
		vi.stubEnv("MEDIA_TRUSTED_PROXY_PROVIDER", "cloudflare");
		databaseMocks.resolveOverride.mockResolvedValue(capabilityOverride);
		turnstileMocks.verifyGuestTurnstileToken.mockResolvedValue({ tokenHash: "f".repeat(64) });
		storageMocks.createSignedUpload.mockResolvedValue("https://storage.test/private-signed-put");
		databaseMocks.createUpload.mockResolvedValue(undefined);
		databaseMocks.loadCompletion.mockResolvedValue({
			ownerId: "guest_owner",
			assetId: "asset_1",
			status: "PENDING",
			stagingObjectKey: "users/guest_owner/staging/session_1/nonce.png",
			contentType: "image/png",
			expectedBytes: 8,
			expectedSha256: "a".repeat(64),
			capabilityVersion: "guest-v17",
		});
		storageMocks.headObject.mockResolvedValue({
			contentLength: 8,
			contentType: "image/png",
			etag: "etag",
			metadata: {},
		});
		uploadMocks.completeOwnedUploadSession.mockResolvedValue({
			id: "asset_1",
			status: "VERIFYING",
			mimeType: "image/png",
			byteSize: 8n,
		});
		databaseMocks.finalizeDraft.mockResolvedValue({ claimToken: "c".repeat(43) });
	});

	afterEach(() => vi.unstubAllEnvs());

	it("allocates only a private staging PUT and binds the separate completion credential", async () => {
		const result = await call(
			createGuestDraftUploadIntent,
			{
				capabilityVersion: "guest-v17",
				contentType: "image/png",
				bytes: 8,
				sha256: "a".repeat(64),
				turnstileToken: "turnstile-proof",
			},
			{
				context: {
					headers: new Headers({
						origin: "https://marketing.test",
						"cf-connecting-ip": "203.0.113.9",
					}),
					responseHeaders: new Headers(),
				},
			},
		);

		expect(result).toMatchObject({
			uploadUrl: "https://storage.test/private-signed-put",
			completionToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
		});
		expect(result.completionToken).not.toBe("turnstile-proof");
		expect(storageMocks.createSignedUpload).toHaveBeenCalledWith(
			expect.objectContaining({
				bucket: "media",
				key: expect.stringContaining("/staging/"),
				contentLength: 8,
				contentType: "image/png",
			}),
		);
		expect(databaseMocks.createUpload).toHaveBeenCalledWith(
			expect.objectContaining({
				capabilityVersion: "guest-v17",
				expectedSha256: "a".repeat(64),
				completionTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
				deleteAfter: expect.any(Date),
			}),
			expect.anything(),
		);
	});

	it("checks HEAD and readiness before returning a distinct one-use draft claim", async () => {
		const result = await call(
			completeGuestDraftUpload,
			{
				sessionId: "session_1",
				completionToken: "b".repeat(43),
				capabilityVersion: "guest-v17",
				sha256: "a".repeat(64),
				prompt: "Replace the background",
			},
			{
				context: {
					headers: new Headers({ origin: "https://marketing.test" }),
					responseHeaders: new Headers(),
				},
			},
		);

		expect(storageMocks.headObject).toHaveBeenCalledWith({
			bucket: "media",
			key: "users/guest_owner/staging/session_1/nonce.png",
		});
		expect(uploadMocks.completeOwnedUploadSession).toHaveBeenCalledWith(
			expect.objectContaining({ expectedSha256: "a".repeat(64), sessionId: "session_1" }),
			"guest_owner",
		);
		expect(result).toEqual({
			status: "READY",
			claimToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			continueUrl: "/draft/continue",
		});
		if (result.status !== "READY") throw new Error("expected ready completion");
		expect(result.claimToken).not.toBe("b".repeat(43));
	});

	it("keeps completion retryable without repeating upload finalization while moderation becomes READY", async () => {
		databaseMocks.finalizeDraft
			.mockRejectedValueOnce(new Error("GUEST_UPLOAD_NOT_READY"))
			.mockResolvedValueOnce({ id: "draft_1", expiresAt: new Date() });
		databaseMocks.loadCompletion
			.mockResolvedValueOnce({
				ownerId: "guest_owner",
				assetId: "asset_1",
				status: "PENDING",
				stagingObjectKey: "users/guest_owner/staging/session_1/nonce.png",
				contentType: "image/png",
				expectedBytes: 8,
				expectedSha256: "a".repeat(64),
				capabilityVersion: "guest-v17",
			})
			.mockResolvedValueOnce({
				ownerId: "guest_owner",
				assetId: "asset_1",
				status: "COMPLETED",
				stagingObjectKey: "users/guest_owner/staging/session_1/nonce.png",
				contentType: "image/png",
				expectedBytes: 8,
				expectedSha256: "a".repeat(64),
				capabilityVersion: "guest-v17",
			});
		const request = {
			sessionId: "session_1",
			completionToken: "b".repeat(43),
			capabilityVersion: "guest-v17",
			sha256: "a".repeat(64),
			prompt: "Replace the background",
		};
		const context = {
			context: {
				headers: new Headers({ origin: "https://marketing.test" }),
				responseHeaders: new Headers(),
			},
		};

		await expect(call(completeGuestDraftUpload, request, context)).resolves.toEqual({
			status: "PENDING",
			retryAfterMs: expect.any(Number),
		});
		await expect(call(completeGuestDraftUpload, request, context)).resolves.toEqual({
			status: "READY",
			claimToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			continueUrl: "/draft/continue",
		});
		expect(uploadMocks.completeOwnedUploadSession).toHaveBeenCalledOnce();
		expect(storageMocks.headObject).toHaveBeenCalledOnce();
		expect(databaseMocks.finalizeDraft).toHaveBeenCalledTimes(2);
	});
});
