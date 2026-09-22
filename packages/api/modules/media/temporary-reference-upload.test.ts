import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@repo/database/client", () => ({ db: {} }));
import { verifyTemporaryReference } from "./lib/temporary-reference-token";
import { uploadTemporaryReference } from "./temporary-reference-upload";

const now = new Date("2026-09-22T12:00:00Z");
function request(headers: Record<string, string> = {}) {
	return new Request("https://app.test/api/media/temporary-references", {
		method: "POST",
		body: new Uint8Array(100),
		headers: {
			origin: "https://app.test",
			"content-type": "image/png",
			"x-upload-size": "100",
			...headers,
		},
	});
}
function dependencies() {
	return {
		getUser: vi.fn(async () => ({ id: "user-1" })),
		enforceRateLimit: vi.fn(async () => undefined),
		maximumInputBytes: vi.fn(async () => 1000),
		reserve: vi.fn(async () => ({ id: "reservation-1" })),
		commit: vi.fn(async () => undefined),
		write: vi.fn(async () => ({ bytes: 100, sha256: "a".repeat(64) })),
		now: () => now,
	};
}
afterEach(() => vi.unstubAllEnvs());
describe("temporary reference upload", () => {
	it("returns a signed receipt after one write, without any asset or moderation API", async () => {
		vi.stubEnv("BETTER_AUTH_SECRET", "reference-upload-test-key");
		const deps = dependencies();
		const result = await uploadTemporaryReference(request(), deps as never);
		expect(result.status).toBe(200);
		const receipt = await result.json();
		expect(verifyTemporaryReference(receipt.token, "user-1", receipt.assetId, now)).toMatchObject({
			bytes: 100,
			checksum: "a".repeat(64),
			expiresAt: "2026-09-23T12:00:00.000Z",
		});
		expect(deps.reserve).toHaveBeenCalledOnce();
		expect(deps.write).toHaveBeenCalledOnce();
		expect(deps.commit).toHaveBeenCalledOnce();
	});
	it.each<Record<string, string>>([
		{ origin: "https://evil.test" },
		{ "content-type": "image/svg+xml" },
		{ "x-upload-size": "2001" },
		{ "content-length": "99" },
	])("rejects invalid requests without a storage write: %s", async (headers) => {
		const deps = dependencies();
		expect(
			(await uploadTemporaryReference(request(headers), deps as never)).status,
		).toBeGreaterThanOrEqual(400);
		expect(deps.reserve).not.toHaveBeenCalled();
		expect(deps.write).not.toHaveBeenCalled();
	});
	it("refuses unauthenticated, over-quota and uncertain writes", async () => {
		const deps = dependencies();
		deps.getUser.mockResolvedValueOnce(null as never);
		expect((await uploadTemporaryReference(request(), deps as never)).status).toBe(401);
		deps.reserve.mockRejectedValueOnce(new Error("STORAGE_QUOTA_EXCEEDED"));
		expect((await uploadTemporaryReference(request(), deps as never)).status).toBe(400);
		expect(deps.write).not.toHaveBeenCalled();
		deps.write.mockRejectedValueOnce(new Error("connection lost"));
		expect((await uploadTemporaryReference(request(), deps as never)).status).toBe(400);
		expect(deps.commit).not.toHaveBeenCalled();
	});
});
