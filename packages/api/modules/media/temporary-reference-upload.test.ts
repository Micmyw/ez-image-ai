import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai";
import { runWithRequestDefer } from "@repo/utils/request-lifecycle";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@repo/database/client", () => ({ db: {} }));
import { verifyTemporaryReference } from "./lib/temporary-reference-token";
import {
	temporaryReferenceVerificationProfile,
	uploadTemporaryReference,
} from "./temporary-reference-upload";

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
		commit: vi.fn(async () => ({ continuationEventIds: ["review-event"] })),
		verificationProfile: vi.fn(() => ({
			provider: "seeapi",
			ruleVersion: "rule-current",
			policyVersion: "policy-current",
		})),
		dispatch: vi.fn(async (_eventIds: string[], _assetId: string): Promise<unknown> => undefined),
		write: vi.fn(async () => ({ bytes: 100, sha256: "a".repeat(64) })),
		now: () => now,
	};
}
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
beforeEach(() => vi.stubEnv("BETTER_AUTH_SECRET", "reference-upload-test-key"));
afterEach(() => vi.unstubAllEnvs());
describe("temporary reference upload", () => {
	it("writes immutable content before atomic review preparation and dispatches only committed events", async () => {
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
		expect(deps.commit).toHaveBeenCalledWith(
			{
				ownerId: "user-1",
				reservationId: "reservation-1",
				reference: expect.objectContaining({
					assetId: receipt.assetId,
					checksum: "a".repeat(64),
					bytes: 100,
				}),
				verification: deps.verificationProfile(),
			},
			expect.anything(),
		);
		expect(deps.write.mock.invocationCallOrder[0]).toBeLessThan(
			deps.commit.mock.invocationCallOrder[0]!,
		);
		expect(deps.commit.mock.invocationCallOrder[0]).toBeLessThan(
			deps.dispatch.mock.invocationCallOrder[0]!,
		);
		expect(deps.dispatch).toHaveBeenCalledExactlyOnceWith(["review-event"], receipt.assetId);
		expect(Object.keys(receipt).sort()).toEqual(["assetId", "expiresAt", "token"]);
		expect(result.headers.get("cache-control")).toBe("no-store");
	});
	it("keeps pure upload responses and does not wake when preparation returns no event", async () => {
		const deps = dependencies();
		deps.verificationProfile.mockReturnValueOnce(null as never);
		deps.commit.mockResolvedValueOnce({ continuationEventIds: [] });
		expect((await uploadTemporaryReference(request(), deps as never)).status).toBe(200);
		expect(deps.commit).toHaveBeenCalledWith(
			expect.objectContaining({ verification: null }),
			expect.anything(),
		);
		expect(deps.dispatch).not.toHaveBeenCalled();
	});
	it("does not dispatch or issue a receipt when the atomic database commit fails", async () => {
		const deps = dependencies();
		deps.commit.mockRejectedValueOnce(new Error("TEMPORARY_REFERENCE_INVALID"));
		const response = await uploadTemporaryReference(request(), deps as never);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ code: "TEMPORARY_REFERENCE_INVALID" });
		expect(deps.dispatch).not.toHaveBeenCalled();
	});
	it.each([
		{ error: new Error("connection closed after COMMIT"), code: "PROVIDER_UNAVAILABLE" },
		{
			error: Object.assign(new Error("confirmed rollback"), { code: "P2034" }),
			code: "MEDIA_REQUEST_CONFLICT",
		},
	])(
		"does not repeat the immutable PUT or invent a new asset identity after commit failure: $code",
		async ({ error, code }) => {
			const deps = dependencies();
			deps.commit.mockRejectedValueOnce(error);
			const response = await uploadTemporaryReference(request(), deps as never);
			expect(response.status).toBe(400);
			expect(deps.reserve).toHaveBeenCalledOnce();
			expect(deps.write).toHaveBeenCalledOnce();
			expect(deps.commit).toHaveBeenCalledOnce();
			expect(deps.dispatch).not.toHaveBeenCalled();
			const body = await response.json();
			expect(body).not.toHaveProperty("token");
			expect(body.code).toBe(code);
		},
	);
	it("keeps uncertain storage acceptance from creating a second PUT or a review", async () => {
		const deps = dependencies();
		deps.write.mockRejectedValueOnce(new Error("storage connection lost after write"));
		const response = await uploadTemporaryReference(request(), deps as never);
		expect(response.status).toBe(400);
		expect(deps.reserve).toHaveBeenCalledOnce();
		expect(deps.write).toHaveBeenCalledOnce();
		expect(deps.commit).not.toHaveBeenCalled();
		expect(deps.dispatch).not.toHaveBeenCalled();
		expect(await response.json()).not.toHaveProperty("token");
	});
	it("captures the current request defer across async work and returns before the short wake finishes", async () => {
		const deps = dependencies();
		const pending = gate();
		deps.dispatch.mockReturnValueOnce(pending.promise);
		const tasks: Promise<unknown>[] = [];
		const response = await runWithRequestDefer(
			(task) => tasks.push(task),
			() => uploadTemporaryReference(request(), deps as never),
		);
		expect(response.status).toBe(200);
		expect(tasks).toHaveLength(1);
		let completed = false;
		void tasks[0]!.then(() => {
			completed = true;
		});
		await Promise.resolve();
		expect(completed).toBe(false);
		pending.release();
		await Promise.all(tasks);
		expect(deps.dispatch).toHaveBeenCalledOnce();
	});
	it("keeps concurrent upload wake promises in their own request scopes", async () => {
		const deps = [dependencies(), dependencies()];
		const pending = [gate(), gate()];
		const tasks: Promise<unknown>[][] = [[], []];
		const responses = await Promise.all(
			deps.map((dep, index) => {
				dep.dispatch.mockReturnValueOnce(pending[index]!.promise);
				return runWithRequestDefer(
					(task) => tasks[index]!.push(task),
					() => uploadTemporaryReference(request(), dep as never),
				);
			}),
		);
		expect(responses.map((response) => response.status)).toEqual([200, 200]);
		expect(tasks.map((scope) => scope.length)).toEqual([1, 1]);
		pending.forEach((task) => task.release());
		await Promise.all(tasks.flat());
	});
	it.each(["absent", "throws"])(
		"awaits the same wake once when request defer is %s",
		async (mode) => {
			const deps = dependencies();
			const pending = gate();
			deps.dispatch.mockReturnValueOnce(pending.promise);
			let returned = false;
			const defer =
				mode === "throws"
					? () => {
							throw new Error("registration failed");
						}
					: undefined;
			const response = uploadTemporaryReference(request(), deps as never, defer).then((result) => {
				returned = true;
				return result;
			});
			await vi.waitFor(() => expect(deps.dispatch).toHaveBeenCalledOnce());
			expect(returned).toBe(false);
			pending.release();
			expect((await response).status).toBe(200);
			expect(deps.dispatch).toHaveBeenCalledOnce();
		},
	);
	it("keeps the committed receipt valid when the wake fails and durable recovery is needed", async () => {
		const deps = dependencies();
		deps.dispatch.mockRejectedValueOnce(new Error("wake lost"));
		const response = await uploadTemporaryReference(request(), deps as never);
		expect(response.status).toBe(200);
		const receipt = await response.json();
		expect(verifyTemporaryReference(receipt.token, "user-1", receipt.assetId, now).checksum).toBe(
			"a".repeat(64),
		);
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

describe("temporary input review policy", () => {
	it("derives current policy exclusively from the enabled server configuration", () => {
		expect(
			temporaryReferenceVerificationProfile({
				MEDIA_GENERATION_ENABLED: "true",
				MEDIA_SAFETY_ADAPTER: "configured",
				MODERATION_IMAGE_SEEAPI_ENABLED: "true",
			}),
		).toEqual({
			provider: "seeapi",
			ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
		});
	});
	it.each([{}, { MEDIA_GENERATION_ENABLED: "false" }, { MEDIA_GENERATION_ENABLED: "true" }])(
		"preserves pure upload if speculative review is disabled or unconfigured: %s",
		(environment) => {
			expect(temporaryReferenceVerificationProfile(environment)).toBeNull();
		},
	);
});
