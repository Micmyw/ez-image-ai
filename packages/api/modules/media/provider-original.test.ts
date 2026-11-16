import { Readable } from "node:stream";

import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai";
import { imageResultFixture } from "@repo/jobs/realtime/image-result.fixture";
import { createProviderOriginalReadUrl } from "@repo/storage/lib/provider-original-access";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { signImageResultReadUrl } from "./lib/image-result";
const mocks = vi.hoisted(() => ({
	asset: vi.fn(),
	origin: vi.fn(),
	remote: vi.fn(),
	stored: vi.fn(),
	result: vi.fn(),
	access: vi.fn(),
	open: vi.fn(),
	candidate: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({
	db: { mediaAsset: { findUnique: mocks.asset }, mediaOutputOrigin: { findUnique: mocks.origin } },
}));
vi.mock("@repo/storage/lib/provider-original-bytes", () => ({
	readProviderOriginalBytes: mocks.remote,
	readProviderCandidateBytes: mocks.candidate,
}));
vi.mock("@repo/database/media-image-result-access", () => ({ getImageResultAccess: mocks.access }));
vi.mock("@repo/jobs/realtime/image-result", async () => ({
	...(await vi.importActual<typeof import("@repo/jobs/realtime/image-result")>(
		"@repo/jobs/realtime/image-result",
	)),
	readImageResult: mocks.result,
}));
vi.mock("@repo/storage", async () => ({
	...(await vi.importActual<typeof import("@repo/storage")>("@repo/storage")),
	readArchivedMediaStream: mocks.stored,
	openInspectedRemoteMedia: mocks.open,
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
	it("streams an approved callback source before bytes finish and without R2 or hash reads", async () => {
		const receipt = imageResultFixture();
		mocks.result.mockResolvedValue(receipt);
		mocks.access.mockResolvedValue({
			ownerId: "user-1",
			status: "PROVIDER_RUNNING",
			attemptId: "attempt-1",
			providerTaskId: "remote-1",
			uncertainSubmission: false,
		});
		const source = new Readable({ read() {} });
		mocks.open.mockResolvedValue({ contentType: "image/png", headers: {}, stream: source });
		const response = await serveProviderOriginal(new Request(signImageResultReadUrl(receipt).url));
		expect(response.status).toBe(200);
		expect(source.readableEnded).toBe(false);
		expect(mocks.remote).not.toHaveBeenCalled();
		expect(mocks.stored).not.toHaveBeenCalled();
		expect(mocks.asset).not.toHaveBeenCalled();
		expect(mocks.origin).not.toHaveBeenCalled();
		source.push(Buffer.from([1, 2, 3]));
		source.push(null);
		expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
	});
	it.each(["DELETED", "QUARANTINED", "REVERIFY"])(
		"checks %s after source setup using one fresh authorization",
		async (change) => {
			const receipt = imageResultFixture();
			mocks.result.mockResolvedValue(receipt);
			const access = {
				ownerId: "user-1",
				status: "FINALIZING",
				attemptId: "attempt-1",
				providerTaskId: "remote-1",
				assetStatus: "VERIFYING",
				verificationGeneration: 1,
			};
			mocks.access.mockImplementation(async () => access);
			const source = new Readable({ read() {} });
			mocks.open.mockImplementationOnce(async () => {
				expect(mocks.access).not.toHaveBeenCalled();
				if (change === "REVERIFY") access.verificationGeneration = 2;
				else access.assetStatus = change;
				return { contentType: "image/png", headers: {}, stream: source };
			});
			expect(
				(await serveProviderOriginal(new Request(signImageResultReadUrl(receipt).url))).status,
			).toBe(404);
			expect(source.destroyed).toBe(true);
			expect(mocks.access).toHaveBeenCalledOnce();
		},
	);
	it("denies an old policy receipt and keeps registered guest delivery watermarked", async () => {
		const receipt = imageResultFixture();
		receipt.context.guest = true;
		mocks.result.mockResolvedValue(receipt);
		mocks.candidate.mockResolvedValue(new Uint8Array([1, 2, 3]));
		mocks.access.mockResolvedValue({
			ownerId: "user-1",
			status: "FINALIZING",
			attemptId: "attempt-1",
			providerTaskId: "remote-1",
			grantedUserId: "registered-1",
			guestExpiresAt: new Date(receipt.context.expiresAt),
		});
		const url = signImageResultReadUrl(receipt, "attachment", "registered-1").url;
		const response = await serveProviderOriginal(new Request(url));
		expect(response.status).toBe(200);
		expect(mocks.candidate).toHaveBeenCalledWith(expect.objectContaining({ watermark: true }));
		expect(mocks.access).toHaveBeenCalledWith(
			"job-1",
			receipt.assetId,
			expect.anything(),
			"registered-1",
		);
		expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
		mocks.result.mockResolvedValue({ ...receipt, policyVersion: "obsolete-policy" });
		expect((await serveProviderOriginal(new Request(url))).status).toBe(404);
		mocks.result.mockResolvedValue(receipt);
		mocks.access.mockResolvedValue({
			ownerId: "user-1",
			status: "FINALIZING",
			attemptId: "attempt-1",
			providerTaskId: "remote-1",
			guestExpiresAt: new Date(receipt.context.expiresAt),
			grantedUserId: "different-user",
		});
		expect((await serveProviderOriginal(new Request(url))).status).toBe(404);
	});
	it.each(["svg", "gif"] as const)(
		"serves an approved %s original before archival",
		async (format) => {
			const originalKey = key.replace(".png", `.${format}`);
			const mimeType = format === "svg" ? "image/svg+xml" : "image/gif";
			mocks.asset.mockResolvedValue({ ...asset(), mimeType, objectKey: originalKey });
			const response = await serveProviderOriginal(
				new Request(
					createProviderOriginalReadUrl({
						key: originalKey,
						responseContentDisposition: `attachment; filename="asset.${format}"`,
					}),
				),
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe(mimeType);
			expect(response.headers.get("content-disposition")).toBe(
				`attachment; filename="asset.${format}"`,
			);
			if (format === "svg")
				expect(response.headers.get("content-security-policy")).toContain("sandbox");
			expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
			expect(mocks.remote).toHaveBeenCalledWith(expect.objectContaining({ mimeType }));
			expect(mocks.stored).not.toHaveBeenCalled();
		},
	);
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
