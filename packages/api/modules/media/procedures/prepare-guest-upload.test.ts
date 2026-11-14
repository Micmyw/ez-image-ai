import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	load: vi.fn(),
	capability: vi.fn(),
	head: vi.fn(),
	complete: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	loadGuestUploadCompletion: mocks.load,
	recordGrowthEvent: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/storage", () => ({ headObject: mocks.head }));
vi.mock("./complete-upload-session", () => ({ completeOwnedUploadSession: mocks.complete }));
vi.mock("../lib/guest-capability", () => ({
	loadGuestCapability: mocks.capability,
	assertGuestCapabilityVersion: (actual: string, expected: string) => {
		if (actual !== expected) throw new Error("GUEST_CAPABILITY_STALE");
	},
	requireGuestAbuseHmac: () => ({ secretKey: "test", keyVersion: "v1" }),
	hashGuestSecret: (value: string) => `hash:${value}`,
	hashGuestAbuseBinding: (_secret: string, _version: string, scope: string, value: string) =>
		`${scope}:${value}`,
}));

import { prepareGuestDraftUpload } from "./prepare-guest-upload";

const input = {
	sessionId: "same-session",
	completionToken: "c".repeat(43),
	capabilityVersion: "cap-v1",
	sha256: "a".repeat(64),
};
const session = {
	ownerId: "guest-owner",
	assetId: "same-asset",
	status: "PENDING",
	stagingObjectKey: "private-stage",
	contentType: "image/png",
	expectedBytes: 4,
	expectedSha256: input.sha256,
	capabilityVersion: input.capabilityVersion,
};
const invoke = (value = input, origin = "https://ezpic.test") =>
	call(prepareGuestDraftUpload, value, {
		context: { headers: new Headers({ origin }), responseHeaders: new Headers() },
	});

describe("guest upload preparation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://ezpic.test");
		mocks.capability.mockResolvedValue({
			config: { enabled: true, promotionPeriod: "campaign" },
			snapshot: { version: input.capabilityVersion },
		});
		mocks.load.mockResolvedValue(session);
		mocks.head.mockResolvedValue({ contentType: "image/png", contentLength: 4 });
		mocks.complete.mockResolvedValue({ id: session.assetId, status: "VERIFYING" });
	});
	afterEach(() => vi.unstubAllEnvs());
	it("seals without a prompt or a draft and never calls the result approved", async () => {
		const responseHeaders = new Headers();
		expect(
			await call(prepareGuestDraftUpload, input, {
				context: { headers: new Headers({ origin: "https://ezpic.test" }), responseHeaders },
			}),
		).toEqual({ status: "SEALED" });
		expect(responseHeaders.get("Cache-Control")).toBe("no-store");
		expect(mocks.load).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: input.sessionId,
				completionTokenHash: `hash:${input.completionToken}`,
				originHash: "guest-origin:https://ezpic.test",
				expectedSha256: input.sha256,
			}),
			expect.anything(),
		);
		expect(mocks.complete).toHaveBeenCalledWith(
			{ sessionId: input.sessionId, expectedSha256: input.sha256 },
			session.ownerId,
		);
	});
	it("repeated preparation of an already sealed identity does no storage or verification work", async () => {
		mocks.load.mockResolvedValue({ ...session, status: "COMPLETED" });
		await expect(invoke()).resolves.toEqual({ status: "SEALED" });
		expect(mocks.head).not.toHaveBeenCalled();
		expect(mocks.complete).not.toHaveBeenCalled();
	});
	it("ignores malformed optional telemetry and keeps it outside the immutable authorization tuple", async () => {
		await expect(
			invoke({
				...input,
				journey: { actionRef: "not-a-uuid", prompt: "not-telemetry" },
			} as typeof input),
		).resolves.toEqual({ status: "SEALED" });
		expect(mocks.load.mock.calls[0]?.[0]).not.toHaveProperty("journey");
	});
	it("registers confirmation telemetry with the managed request lifetime", async () => {
		const defer = vi.fn();
		await call(prepareGuestDraftUpload, input, {
			context: { headers: new Headers({ origin: "https://ezpic.test" }), defer },
		});
		expect(defer).toHaveBeenCalledWith(expect.any(Promise));
		await defer.mock.calls[0]?.[0];
	});
	it("keeps a concurrent finalization pending on the original session", async () => {
		mocks.load.mockResolvedValue({ ...session, status: "FINALIZING" });
		mocks.complete.mockRejectedValueOnce(new Error("Upload session finalization is in progress"));
		await expect(invoke()).resolves.toEqual({ status: "PENDING", retryAfterMs: 500 });
		expect(mocks.head).not.toHaveBeenCalled();
	});
	it("recovers staging disappearance only through the same authorized completed identity", async () => {
		mocks.head.mockRejectedValue(new Error("NoSuchKey"));
		mocks.load
			.mockResolvedValueOnce(session)
			.mockResolvedValueOnce({ ...session, status: "COMPLETED" });
		await expect(invoke()).resolves.toEqual({ status: "SEALED" });
		expect(mocks.load.mock.calls[0]?.[0]).toEqual(mocks.load.mock.calls[1]?.[0]);
		expect(mocks.complete).not.toHaveBeenCalled();
	});
	it("rejects wrong origin before storage reads", async () => {
		await expect(invoke(input, "https://other.test")).rejects.toThrow("FORBIDDEN_ORIGIN");
		expect(mocks.load).not.toHaveBeenCalled();
	});
	it.each(["token", "hash", "expired", "consumed"])(
		"honors the database authorization denial for %s",
		async () => {
			mocks.load.mockRejectedValue(new Error("GUEST_UPLOAD_UNAVAILABLE"));
			await expect(invoke()).rejects.toThrow("GUEST_UPLOAD_UNAVAILABLE");
			expect(mocks.complete).not.toHaveBeenCalled();
		},
	);
	it("rejects stale capabilities and unsupported additional fields", async () => {
		await expect(invoke({ ...input, capabilityVersion: "old" })).rejects.toThrow(
			"GUEST_CAPABILITY_STALE",
		);
		await expect(
			invoke({ ...input, prompt: "must not create a draft" } as typeof input),
		).rejects.toThrow();
		expect(mocks.complete).not.toHaveBeenCalled();
	});
	it("rejects mismatched uploaded metadata without finalizing", async () => {
		mocks.head.mockResolvedValue({ contentType: "image/png", contentLength: 5 });
		await expect(invoke()).rejects.toThrow("GUEST_UPLOAD_METADATA_MISMATCH");
		expect(mocks.complete).not.toHaveBeenCalled();
	});
	it("preserves an unknown finalization failure for retry rather than starting another identity", async () => {
		mocks.complete.mockRejectedValue(new Error("unknown response"));
		await expect(invoke()).rejects.toThrow("unknown response");
		expect(mocks.complete).toHaveBeenCalledOnce();
	});
});
