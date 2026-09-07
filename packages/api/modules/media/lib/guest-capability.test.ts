import { createHash, createHmac } from "node:crypto";

import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
	createUpload: vi.fn(),
	finalizeDraft: vi.fn(),
	findRuntimeOverrides: vi.fn(),
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
vi.mock("@repo/database/client", () => ({
	db: { runtimeConfigOverride: { findMany: databaseMocks.findRuntimeOverrides } },
}));
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
	MEDIA_GENERATION_ENABLED: "true",
	MEDIA_ENABLED_PROVIDERS: "kie",
	MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: "2026-09-07.2",
	KIE_API_KEY: "test-kie-key",
	GUEST_MEDIA_ENABLED: "true",
	GUEST_PROMOTION_PERIOD: "2026-launch",
	BETTER_AUTH_SECRET: "test-secret",
	GUEST_ABUSE_HMAC_SECRET: "independent-guest-abuse-secret-at-least-32-bytes",
	GUEST_ABUSE_HMAC_VERSION: "launch-key-v1",
	MEDIA_TRUSTED_PROXY_PROVIDER: "cloudflare",
};
const capabilityOverride = {
	enabled: true as const,
	version: 17,
	createdAt: new Date("2026-06-01T00:00:00.000Z"),
	abuseHmacKeyVersion: enabledEnvironment.GUEST_ABUSE_HMAC_VERSION,
	abuseHmacKeyIdentity: createHash("sha256")
		.update(`guest-abuse-hmac-key\0${enabledEnvironment.GUEST_ABUSE_HMAC_SECRET}`, "utf8")
		.digest("hex"),
};

const expectedPublicProductSummaries = [
	{
		key: "image-nano-banana-2-lite",
		label: "Nano Banana 2 Lite",
		credits: "5",
		accessHint: "guest-trial",
		defaultSkuKey: "nano-banana-2-lite-1k",
		skus: [["nano-banana-2-lite-1k", 5]],
	},
	{
		key: "image-nano-banana",
		label: "Nano Banana",
		credits: "5",
		accessHint: "paid-account",
		defaultSkuKey: "nano-banana-default",
		skus: [["nano-banana-default", 5]],
	},
	{
		key: "image-nano-banana-2",
		label: "Nano Banana 2",
		credits: "9",
		accessHint: "paid-account",
		defaultSkuKey: "nano-banana-2-1k",
		skus: [
			["nano-banana-2-1k", 9],
			["nano-banana-2-2k", 13],
			["nano-banana-2-4k", 19],
		],
	},
	{
		key: "image-nano-banana-pro",
		label: "Nano Banana Pro",
		credits: "19",
		accessHint: "paid-account",
		defaultSkuKey: "nano-banana-pro-1k",
		skus: [
			["nano-banana-pro-1k", 19],
			["nano-banana-pro-2k", 19],
			["nano-banana-pro-4k", 25],
		],
	},
	{
		key: "image-gpt-image-1-5",
		label: "GPT Image 1.5",
		credits: "5",
		accessHint: "paid-account",
		defaultSkuKey: "gpt-image-1-5-medium",
		skus: [
			["gpt-image-1-5-medium", 5],
			["gpt-image-1-5-high", 23],
		],
	},
	{
		key: "image-gpt-image-2",
		label: "GPT Image 2",
		credits: "7",
		accessHint: "paid-account",
		defaultSkuKey: "gpt-image-2-1k",
		skus: [
			["gpt-image-2-1k", 7],
			["gpt-image-2-2k", 11],
			["gpt-image-2-4k", 17],
		],
	},
	{
		key: "image-seedream-4-5",
		label: "Seedream 4.5",
		credits: "8",
		accessHint: "paid-account",
		defaultSkuKey: "seedream-4-5-basic-2k",
		skus: [
			["seedream-4-5-basic-2k", 8],
			["seedream-4-5-high-4k", 8],
		],
	},
	{
		key: "image-seedream-5-lite",
		label: "Seedream 5 Lite",
		credits: "7",
		accessHint: "paid-account",
		defaultSkuKey: "seedream-5-lite-basic-2k",
		skus: [
			["seedream-5-lite-basic-2k", 7],
			["seedream-5-lite-high-3k", 7],
			["seedream-5-lite-ultra-4k", 7],
		],
	},
	{
		key: "image-seedream-5-pro",
		label: "Seedream 5 Pro",
		credits: "8",
		accessHint: "paid-account",
		defaultSkuKey: "seedream-5-pro-basic-1k",
		skus: [
			["seedream-5-pro-basic-1k", 8],
			["seedream-5-pro-high-2k", 15],
		],
	},
] as const;

const prohibitedCapabilityFields = [
	"abuseHmac",
	"apiKey",
	"bucketName",
	"costEvidenceId",
	"costMicros",
	"hardBudgetMicros",
	"keyIdentity",
	"modelId",
	"provider",
	"providerCostMicros",
	"providerModelId",
	"routes",
	"secretKey",
	"siteKey",
	"storageObjectKey",
	"trustedProxyPolicy",
	"weight",
] as const;

function collectCapabilityKeys(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(collectCapabilityKeys);
	if (!value || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, nested]) => [key, ...collectCapabilityKeys(nested)]);
}

function collectCapabilityStrings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(collectCapabilityStrings);
	if (!value || typeof value !== "object") return [];
	return Object.values(value).flatMap(collectCapabilityStrings);
}

function expectNoPrivateCapabilityData(
	value: unknown,
	privateValues: readonly string[] = [],
): void {
	const keys = collectCapabilityKeys(value);
	const strings = collectCapabilityStrings(value).map((entry) => entry.toLowerCase());
	const serialized = JSON.stringify(value);

	for (const field of prohibitedCapabilityFields) expect(keys).not.toContain(field);
	for (const provider of ["kie", "openrouter", "replicate", "gemini"]) {
		expect(strings).not.toContain(provider);
	}
	for (const privateValue of privateValues) expect(serialized).not.toContain(privateValue);
}

describe("guest capability snapshot", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		databaseMocks.resolveOverride.mockResolvedValue(capabilityOverride);
		databaseMocks.findRuntimeOverrides.mockResolvedValue([]);
	});

	it("requires both the environment gate and active literal-true database override", async () => {
		const enabled = await loadGuestCapabilitySnapshot(enabledEnvironment);
		expect(enabled).toMatchObject({
			enabled: true,
			reason: null,
			upload: { maximumBytes: 10 * 1024 * 1024 },
		});
		expect(enabled.products.map((product) => product.key)).toEqual(
			expectedPublicProductSummaries.map((product) => product.key),
		);

		databaseMocks.resolveOverride.mockResolvedValue(null);
		await expect(loadGuestCapabilitySnapshot(enabledEnvironment)).resolves.toMatchObject({
			enabled: false,
			reason: "GUEST_RUNTIME_DISABLED",
		});
	});

	it("advertises only executable stable image tiers with truthful access hints", async () => {
		const snapshot = await loadGuestCapabilitySnapshot(enabledEnvironment);

		expect(
			snapshot.products.map((product) => ({
				key: product.key,
				label: product.label,
				credits: product.credits,
				accessHint: product.accessHint,
				defaultSkuKey: product.skuMatrix.defaultSkuKey,
				skus: product.skuMatrix.cells.map((cell) => [cell.skuKey, cell.credits]),
			})),
		).toEqual(expectedPublicProductSummaries);
		expect(snapshot.products.flatMap((product) => product.skuMatrix.cells)).toHaveLength(20);
		const unavailable = await loadGuestCapabilitySnapshot({
			...enabledEnvironment,
			MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: "",
		});
		expect(unavailable).toMatchObject({
			enabled: false,
			reason: "GUEST_PRODUCTS_UNAVAILABLE",
			products: [],
		});
		expect(unavailable.version).not.toBe(snapshot.version);
		expectNoPrivateCapabilityData(snapshot, [enabledEnvironment.KIE_API_KEY]);
	});

	it("removes a runtime-disabled tier from the same executable catalog used by quotes", async () => {
		databaseMocks.findRuntimeOverrides.mockResolvedValue([
			{ configKey: "media.model.image-gpt-image-2.enabled" },
		]);

		const snapshot = await loadGuestCapabilitySnapshot(enabledEnvironment);

		expect(snapshot.products.map((product) => product.key)).toEqual([
			"image-nano-banana-2-lite",
			"image-nano-banana",
			"image-nano-banana-2",
			"image-nano-banana-pro",
			"image-gpt-image-1-5",
			"image-seedream-4-5",
			"image-seedream-5-lite",
			"image-seedream-5-pro",
		]);
	});

	it("fails closed when the runtime source throws and exposes only the public contract", async () => {
		databaseMocks.resolveOverride.mockRejectedValue(new Error("database unavailable"));
		const snapshot = await loadGuestCapabilitySnapshot({
			...enabledEnvironment,
			GUEST_TURNSTILE_SECRET_KEY: "private-turnstile-secret",
			GUEST_HARD_BUDGET_MICROS: "1000000",
			GUEST_COST_EVIDENCE_ID: "private-provider-evidence",
		});
		expect(snapshot.enabled).toBe(false);
		expectNoPrivateCapabilityData(snapshot, [
			enabledEnvironment.KIE_API_KEY,
			enabledEnvironment.GUEST_ABUSE_HMAC_SECRET,
			capabilityOverride.abuseHmacKeyIdentity,
			"private-turnstile-secret",
			"private-provider-evidence",
			"1000000",
		]);
		expect(Object.keys(snapshot).sort()).toEqual([
			"enabled",
			"products",
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

	it("binds promotion, effective security configuration, and abuse-key identity into the version", async () => {
		const baseline = await loadGuestCapabilitySnapshot(enabledEnvironment);
		const changedPromotion = await loadGuestCapabilitySnapshot({
			...enabledEnvironment,
			GUEST_PROMOTION_PERIOD: "2026-launch-b",
		});
		const changedRiskBudget = await loadGuestCapabilitySnapshot({
			...enabledEnvironment,
			GUEST_RISK_BUDGET_MICROS: "349999",
		});
		const changedSecret = await loadGuestCapabilitySnapshot({
			...enabledEnvironment,
			GUEST_ABUSE_HMAC_SECRET: "rotated-independent-guest-abuse-secret-32-bytes",
		});
		const changedKeyVersion = await loadGuestCapabilitySnapshot({
			...enabledEnvironment,
			GUEST_ABUSE_HMAC_VERSION: "launch-key-v2",
		});

		expect(baseline.version).toMatch(/^guest-v17-[a-f0-9]{64}$/);
		expect(
			new Set([
				baseline.version,
				changedPromotion.version,
				changedRiskBudget.version,
				changedSecret.version,
				changedKeyVersion.version,
			]),
		).toHaveLength(5);
	});

	it("keeps capability identity stable across irrelevant environment and object-key ordering", async () => {
		const baseline = await loadGuestCapabilitySnapshot(enabledEnvironment);
		const reorderedWithNoise = Object.fromEntries([
			["UNRELATED_RUNTIME_NOISE", "ignored"],
			...Object.entries(enabledEnvironment).reverse(),
		]);

		await expect(loadGuestCapabilitySnapshot(reorderedWithNoise)).resolves.toMatchObject({
			version: baseline.version,
		});
	});

	it("never serializes raw abuse or Turnstile secrets or their private identities", async () => {
		const snapshot = await loadGuestCapabilitySnapshot({
			...enabledEnvironment,
			GUEST_TURNSTILE_SECRET_KEY: "private-turnstile-secret",
		});
		const serialized = JSON.stringify(snapshot);

		expect(serialized).not.toContain(enabledEnvironment.GUEST_ABUSE_HMAC_SECRET);
		expect(serialized).not.toContain(capabilityOverride.abuseHmacKeyIdentity);
		expect(serialized).not.toContain("private-turnstile-secret");
		expect(Object.keys(snapshot).sort()).toEqual([
			"enabled",
			"products",
			"queueEstimate",
			"reason",
			"upload",
			"version",
		]);
	});
});

describe("guest private upload handoff", () => {
	let capabilityVersion: string;

	beforeEach(async () => {
		vi.clearAllMocks();
		vi.stubEnv("NODE_ENV", "development");
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://saas.test");
		vi.stubEnv("GUEST_MEDIA_ENABLED", "true");
		vi.stubEnv("GUEST_PROMOTION_PERIOD", "2026-launch");
		vi.stubEnv("MEDIA_GENERATION_ENABLED", "true");
		vi.stubEnv("MEDIA_ENABLED_PROVIDERS", "kie");
		vi.stubEnv("MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS", "2026-09-07.2");
		vi.stubEnv("KIE_API_KEY", "test-kie-key");
		vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
		vi.stubEnv("GUEST_ABUSE_HMAC_SECRET", enabledEnvironment.GUEST_ABUSE_HMAC_SECRET);
		vi.stubEnv("GUEST_ABUSE_HMAC_VERSION", enabledEnvironment.GUEST_ABUSE_HMAC_VERSION);
		vi.stubEnv("MEDIA_TRUSTED_PROXY_PROVIDER", "cloudflare");
		databaseMocks.resolveOverride.mockResolvedValue(capabilityOverride);
		databaseMocks.findRuntimeOverrides.mockResolvedValue([]);
		capabilityVersion = (await loadGuestCapabilitySnapshot(process.env)).version;
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
			capabilityVersion,
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
				capabilityVersion,
				productKey: "image-nano-banana-2-lite",
				contentType: "image/png",
				bytes: 8,
				sha256: "a".repeat(64),
				turnstileToken: "turnstile-proof",
			},
			{
				context: {
					headers: new Headers({
						origin: "https://saas.test",
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
				capabilityVersion,
				originHash: testGuestAbuseBinding(
					enabledEnvironment.GUEST_ABUSE_HMAC_SECRET,
					enabledEnvironment.GUEST_ABUSE_HMAC_VERSION,
					"guest-origin",
					"https://saas.test",
				),
				ipHash: testGuestAbuseBinding(
					enabledEnvironment.GUEST_ABUSE_HMAC_SECRET,
					enabledEnvironment.GUEST_ABUSE_HMAC_VERSION,
					"guest-ip",
					"203.0.113.9",
				),
				subnetHash: testGuestAbuseBinding(
					enabledEnvironment.GUEST_ABUSE_HMAC_SECRET,
					enabledEnvironment.GUEST_ABUSE_HMAC_VERSION,
					"guest-subnet",
					"203.0.113.0/24",
				),
				promotionPeriod: "2026-launch",
				expectedSha256: "a".repeat(64),
				completionTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
				deleteAfter: expect.any(Date),
			}),
			expect.anything(),
		);
	});

	it("does not sign an upload when the database admission boundary rejects", async () => {
		databaseMocks.createUpload.mockRejectedValueOnce(new Error("GUEST_UPLOAD_RATE_LIMITED"));

		await expect(
			call(
				createGuestDraftUploadIntent,
				{
					capabilityVersion,
					productKey: "image-nano-banana-2-lite",
					contentType: "image/png",
					bytes: 8,
					sha256: "a".repeat(64),
					turnstileToken: "turnstile-proof",
				},
				{
					context: {
						headers: new Headers({
							origin: "https://saas.test",
							"cf-connecting-ip": "203.0.113.9",
						}),
						responseHeaders: new Headers(),
					},
				},
			),
		).rejects.toThrow("GUEST_UPLOAD_RATE_LIMITED");
		expect(storageMocks.createSignedUpload).not.toHaveBeenCalled();
	});

	it("rejects forged or currently unavailable product keys before allocating storage", async () => {
		await expect(
			call(
				createGuestDraftUploadIntent,
				{
					capabilityVersion,
					productKey: "video-fast" as never,
					contentType: "image/png",
					bytes: 8,
					sha256: "a".repeat(64),
					turnstileToken: "turnstile-proof",
				},
				{
					context: {
						headers: new Headers({
							origin: "https://saas.test",
							"cf-connecting-ip": "203.0.113.9",
						}),
						responseHeaders: new Headers(),
					},
				},
			),
		).rejects.toThrow("GUEST_PRODUCT_UNAVAILABLE");
		expect(storageMocks.createSignedUpload).not.toHaveBeenCalled();
		expect(databaseMocks.createUpload).not.toHaveBeenCalled();
	});

	it("persists a selected GPT Image SKU plus its non-billing cell control", async () => {
		const result = await call(
			completeGuestDraftUpload,
			{
				sessionId: "session_1",
				completionToken: "b".repeat(43),
				capabilityVersion,
				productKey: "image-gpt-image-2",
				skuKey: "gpt-image-2-1k",
				sha256: "a".repeat(64),
				prompt: "Preserve every product detail",
				aspectRatio: "5:4",
				background: "transparent",
			},
			{
				context: {
					headers: new Headers({ origin: "https://saas.test" }),
					responseHeaders: new Headers(),
				},
			},
		);

		expect(databaseMocks.finalizeDraft).toHaveBeenCalledWith(
			expect.objectContaining({
				productKey: "image-gpt-image-2",
				skuKey: "gpt-image-2-1k",
				aspectRatio: "5:4",
				background: "transparent",
			}),
			expect.anything(),
		);
		expect(result).toMatchObject({
			status: "READY",
			productKey: "image-gpt-image-2",
			skuKey: "gpt-image-2-1k",
			accessHint: "paid-account",
		});
	});

	it("rejects a non-billing control that the selected cell does not expose", async () => {
		await expect(
			call(
				completeGuestDraftUpload,
				{
					sessionId: "session_1",
					completionToken: "b".repeat(43),
					capabilityVersion,
					productKey: "image-gpt-image-2",
					skuKey: "gpt-image-2-2k",
					sha256: "a".repeat(64),
					prompt: "Preserve every product detail",
					aspectRatio: "1:1",
					background: "transparent",
				},
				{
					context: {
						headers: new Headers({ origin: "https://saas.test" }),
						responseHeaders: new Headers(),
					},
				},
			),
		).rejects.toThrow("GUEST_PRODUCT_UNAVAILABLE");
		expect(databaseMocks.loadCompletion).not.toHaveBeenCalled();
		expect(databaseMocks.finalizeDraft).not.toHaveBeenCalled();
	});

	it("allocates a generation-compatible opaque asset ID for the guest source", async () => {
		const result = await call(
			createGuestDraftUploadIntent,
			{
				capabilityVersion,
				productKey: "image-nano-banana-2-lite",
				contentType: "image/png",
				bytes: 8,
				sha256: "a".repeat(64),
				turnstileToken: "turnstile-proof",
			},
			{
				context: {
					headers: new Headers({
						origin: "https://saas.test",
						"cf-connecting-ip": "203.0.113.9",
					}),
					responseHeaders: new Headers(),
				},
			},
		);

		expect(result.assetId).toMatch(/^asset_[A-Za-z0-9_-]{16,64}$/);
		expect(databaseMocks.createUpload).toHaveBeenCalledWith(
			expect.objectContaining({ assetId: result.assetId }),
			expect.anything(),
		);
	});

	it("checks HEAD and readiness before returning a distinct one-use draft claim", async () => {
		const result = await call(
			completeGuestDraftUpload,
			{
				sessionId: "session_1",
				completionToken: "b".repeat(43),
				capabilityVersion,
				productKey: "image-nano-banana-2-lite",
				skuKey: "nano-banana-2-lite-1k",
				sha256: "a".repeat(64),
				prompt: "Replace the background",
			},
			{
				context: {
					headers: new Headers({ origin: "https://saas.test" }),
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
		expect(databaseMocks.loadCompletion).toHaveBeenCalledWith(
			expect.objectContaining({
				originHash: testGuestAbuseBinding(
					enabledEnvironment.GUEST_ABUSE_HMAC_SECRET,
					enabledEnvironment.GUEST_ABUSE_HMAC_VERSION,
					"guest-origin",
					"https://saas.test",
				),
			}),
			expect.anything(),
		);
		expect(databaseMocks.finalizeDraft).toHaveBeenCalledWith(
			expect.objectContaining({ maximumOutstandingBootstraps: 25 }),
			expect.anything(),
		);
		expect(result).toEqual({
			status: "READY",
			claimToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			continueUrl: "/draft/continue",
			productKey: "image-nano-banana-2-lite",
			skuKey: "nano-banana-2-lite-1k",
			accessHint: "guest-trial",
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
				capabilityVersion,
			})
			.mockResolvedValueOnce({
				ownerId: "guest_owner",
				assetId: "asset_1",
				status: "COMPLETED",
				stagingObjectKey: "users/guest_owner/staging/session_1/nonce.png",
				contentType: "image/png",
				expectedBytes: 8,
				expectedSha256: "a".repeat(64),
				capabilityVersion,
			});
		const request = {
			sessionId: "session_1",
			completionToken: "b".repeat(43),
			capabilityVersion,
			productKey: "image-nano-banana-2-lite" as const,
			skuKey: "nano-banana-2-lite-1k" as const,
			sha256: "a".repeat(64),
			prompt: "Replace the background",
		};
		const context = {
			context: {
				headers: new Headers({ origin: "https://saas.test" }),
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
			productKey: "image-nano-banana-2-lite",
			skuKey: "nano-banana-2-lite-1k",
			accessHint: "guest-trial",
		});
		expect(uploadMocks.completeOwnedUploadSession).toHaveBeenCalledOnce();
		expect(storageMocks.headObject).toHaveBeenCalledOnce();
		expect(databaseMocks.finalizeDraft).toHaveBeenCalledTimes(2);
	});

	it("maps the internal bootstrap ceiling to one stable public capacity error", async () => {
		databaseMocks.finalizeDraft.mockRejectedValueOnce(
			new Error("GUEST_OUTSTANDING_BOOTSTRAP_CAP_EXCEEDED"),
		);

		await expect(
			call(
				completeGuestDraftUpload,
				{
					sessionId: "session_1",
					completionToken: "b".repeat(43),
					capabilityVersion,
					productKey: "image-nano-banana-2-lite",
					skuKey: "nano-banana-2-lite-1k",
					sha256: "a".repeat(64),
					prompt: "Replace the background",
				},
				{
					context: {
						headers: new Headers({ origin: "https://saas.test" }),
						responseHeaders: new Headers(),
					},
				},
			),
		).rejects.toThrow("GUEST_CAPACITY_UNAVAILABLE");
	});
});

function testGuestAbuseBinding(
	secret: string,
	keyVersion: string,
	purpose: string,
	value: string,
): string {
	return createHmac("sha256", secret)
		.update(`${keyVersion}:${purpose}:${value}`, "utf8")
		.digest("hex");
}
