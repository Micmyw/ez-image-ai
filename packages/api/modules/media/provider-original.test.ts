import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai";
import { createProviderOriginalReadUrl } from "@repo/storage/lib/provider-original-access";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
	asset: vi.fn(),
	origin: vi.fn(),
	remote: vi.fn(),
	stored: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({
	db: { mediaAsset: { findUnique: mocks.asset }, mediaOutputOrigin: { findUnique: mocks.origin } },
}));
vi.mock("@repo/storage/lib/provider-original-bytes", () => ({
	readProviderOriginalBytes: mocks.remote,
}));
vi.mock("@repo/storage", async () => ({
	...(await vi.importActual<typeof import("@repo/storage")>("@repo/storage")),
	readArchivedMediaStream: mocks.stored,
}));
import { serveProviderOriginal } from "./provider-original";

const key = "provider-original-v1/users/owner/assets/asset/original.png";
const checksum = "a".repeat(64);
function asset() {
	const validUntil = new Date("2099-01-01");
	return {
		id: "asset",
		ownerId: "owner",
		ownerType: "USER",
		kind: "OUTPUT",
		status: "READY",
		deletedAt: null,
		deleteAfter: null,
		verificationEngine: "legacy",
		mimeType: "image/png",
		checksum,
		byteSize: 3n,
		objectKey: key,
		verificationGeneration: 1,
		verificationAttemptCount: 1,
		verificationProvider: "test",
		verificationProviderTaskId: null,
		verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
		verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
		verificationValidUntil: validUntil,
		moderationResults: [
			{
				assetChecksum: checksum,
				status: "APPROVED",
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "OUTPUT",
				provider: "test",
				providerTaskId: null,
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				validUntil,
			},
		],
	};
}
function request(disposition = "inline") {
	return new Request(
		createProviderOriginalReadUrl({ key, responseContentDisposition: disposition }),
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("WORKFLOWS_DISPATCH_SECRET", "original-access-private-key-test-32-characters");
	vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://app.test");
	vi.stubEnv("MEDIA_SAFETY_ADAPTER", "test");
	vi.stubEnv("MEDIA_ALLOW_TEST_SAFETY_ADAPTER", "true");
	mocks.asset.mockResolvedValue(asset());
	mocks.origin.mockResolvedValue({
		url: "https://tempfile.aiquickdraw.com/original.png",
		archiveState: "PENDING",
	});
	mocks.remote.mockResolvedValue(new Uint8Array([1, 2, 3]));
});
describe("provider original access", () => {
	it("serves the full approved original and attachment before archive without exposing its provider URL", async () => {
		const response = await serveProviderOriginal(request('attachment; filename="asset.png"'));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-disposition")).toBe('attachment; filename="asset.png"');
		expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
		expect(mocks.stored).not.toHaveBeenCalled();
		expect(response.headers.get("location")).toBeNull();
	});
	it.each(["VERIFYING", "QUARANTINED", "VERIFICATION_FAILED", "DELETED"])(
		"denies %s even with an otherwise valid signed capability",
		async (status) => {
			mocks.asset.mockResolvedValue({ ...asset(), status });
			expect((await serveProviderOriginal(request())).status).toBe(404);
			expect(mocks.remote).not.toHaveBeenCalled();
		},
	);
	it("rejects token tampering before any database or provider read", async () => {
		const url = new URL(request().url);
		url.searchParams.set("key", key.replace("owner", "other"));
		expect((await serveProviderOriginal(new Request(url))).status).toBe(403);
		expect(mocks.asset).not.toHaveBeenCalled();
	});
	it("does not allow a customer capability to escalate to administrator scope", async () => {
		const url = new URL(request().url);
		url.searchParams.set("scope", "admin");
		expect((await serveProviderOriginal(new Request(url))).status).toBe(403);
		expect(mocks.asset).not.toHaveBeenCalled();
	});
	it("allows an independently signed administrator grant to inspect rejected output", async () => {
		mocks.asset.mockResolvedValue({ ...asset(), status: "QUARANTINED" });
		const response = await serveProviderOriginal(
			new Request(createProviderOriginalReadUrl({ key, scope: "admin" })),
		);
		expect(response.status).toBe(200);
		expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
	});
	it("withdraws an expired review even when a matching archived copy exists", async () => {
		mocks.origin.mockResolvedValue({
			url: "https://tempfile.aiquickdraw.com/original.png",
			archiveState: "ARCHIVED",
			archiveChecksum: checksum,
			archiveBytes: 3n,
		});
		const cancel = vi.fn();
		mocks.stored.mockResolvedValue({
			contentLength: 3,
			contentType: "image/png",
			body: new ReadableStream({ cancel }),
		});
		mocks.asset
			.mockResolvedValueOnce(asset())
			.mockResolvedValueOnce({ ...asset(), verificationValidUntil: new Date(0) });
		expect((await serveProviderOriginal(request())).status).toBe(404);
		expect(cancel).toHaveBeenCalledOnce();
	});
	it("uses only a matching archived identity and falls back during storage outage", async () => {
		mocks.origin.mockResolvedValue({
			url: "https://tempfile.aiquickdraw.com/original.png",
			archiveState: "ARCHIVED",
			archiveChecksum: checksum,
			archiveBytes: 3n,
		});
		mocks.stored.mockRejectedValue(new Error("unavailable"));
		expect((await serveProviderOriginal(request())).status).toBe(200);
		expect(mocks.remote).toHaveBeenCalledOnce();
	});
	it("never sends provider bytes after identity failure or deletion during the fetch", async () => {
		mocks.remote.mockRejectedValueOnce(new Error("ORIGINAL_IDENTITY_CHANGED"));
		expect((await serveProviderOriginal(request())).status).toBe(503);
		mocks.asset
			.mockResolvedValueOnce(asset())
			.mockResolvedValueOnce({ ...asset(), status: "DELETED" });
		expect((await serveProviderOriginal(request())).status).toBe(404);
	});
});
