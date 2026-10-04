import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createSeeapiVideoCallbackUrl, verifySeeapiVideoCallbackUrl } from "./seeapi-callback-url";

const environment: Record<string, string | undefined> = {
	NEXT_PUBLIC_SAAS_URL: "https://video.example.com",
	VIDEO_V1_CALLBACK_BASE_URL: "https://video.example.com",
	VIDEO_SEEAPI_CALLBACK_SECRET: "local-test-seeapi-callback-secret-0123456789",
	SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({
		whkey_test: "whsec_local-test-seeapi-signing-key-0123456789",
	}),
};
const identity = { assetId: "video_asset-123", generation: 2, attemptNumber: 3 };

async function validCallbackUrl() {
	return new URL(await createSeeapiVideoCallbackUrl(identity, environment));
}

describe("SeeAPI video callback URL", () => {
	it("round-trips the asset, generation and attempt on the configured application origin", async () => {
		const url = await validCallbackUrl();

		expect(url.origin).toBe(environment.NEXT_PUBLIC_SAAS_URL);
		expect(url.pathname).toBe("/api/webhooks/video-v1/seeapi/video_asset-123");
		expect(url.searchParams.get("generation")).toBe("2");
		expect(url.searchParams.get("attempt")).toBe("3");
		expect(url.searchParams.get("proof")).toBeTruthy();
		expect([...url.searchParams.keys()].sort()).toEqual(["attempt", "generation", "proof"]);
		await expect(verifySeeapiVideoCallbackUrl(url.href, environment)).resolves.toEqual(identity);
	});

	it("uses the application origin when the callback base is omitted", async () => {
		const env = { ...environment, VIDEO_V1_CALLBACK_BASE_URL: undefined };
		const url = await createSeeapiVideoCallbackUrl(identity, env);

		expect(new URL(url).origin).toBe(environment.NEXT_PUBLIC_SAAS_URL);
		await expect(verifySeeapiVideoCallbackUrl(url, env)).resolves.toEqual(identity);
	});

	it("keeps a proof stable for the same immutable callback identity", async () => {
		await expect(createSeeapiVideoCallbackUrl(identity, environment)).resolves.toBe(
			await createSeeapiVideoCallbackUrl(identity, environment),
		);
	});

	it("accepts the allowed asset length and largest positive safe integer", async () => {
		const boundary = {
			assetId: "a".repeat(160),
			generation: Number.MAX_SAFE_INTEGER,
			attemptNumber: Number.MAX_SAFE_INTEGER,
		};
		const url = await createSeeapiVideoCallbackUrl(boundary, environment);

		await expect(verifySeeapiVideoCallbackUrl(url, environment)).resolves.toEqual(boundary);
	});

	it.each([
		[
			"asset",
			(url: URL) => {
				url.pathname = "/api/webhooks/video-v1/seeapi/another_asset";
			},
		],
		[
			"generation",
			(url: URL) => {
				url.searchParams.set("generation", "3");
			},
		],
		[
			"attempt",
			(url: URL) => {
				url.searchParams.set("attempt", "4");
			},
		],
	] as const)("rejects a valid proof transplanted to a different %s", async (_name, mutate) => {
		const url = await validCallbackUrl();
		mutate(url);

		await expect(verifySeeapiVideoCallbackUrl(url.href, environment)).resolves.toBeNull();
	});

	it("rejects a proof with one changed character", async () => {
		const url = await validCallbackUrl();
		const proof = url.searchParams.get("proof")!;
		url.searchParams.set("proof", `${proof[0] === "a" ? "b" : "a"}${proof.slice(1)}`);

		await expect(verifySeeapiVideoCallbackUrl(url.href, environment)).resolves.toBeNull();
	});

	it("rejects a proof generated with a different callback secret", async () => {
		const url = await validCallbackUrl();

		await expect(
			verifySeeapiVideoCallbackUrl(url.href, {
				...environment,
				VIDEO_SEEAPI_CALLBACK_SECRET: "different-local-callback-secret-0123456789",
			}),
		).resolves.toBeNull();
	});

	it("rejects a valid HMAC without the video callback purpose", async () => {
		const url = await validCallbackUrl();
		const genericProof = createHmac("sha256", environment.VIDEO_SEEAPI_CALLBACK_SECRET!)
			.update(JSON.stringify([identity.assetId, identity.generation, identity.attemptNumber]))
			.digest("hex");
		url.searchParams.set("proof", genericProof);

		await expect(verifySeeapiVideoCallbackUrl(url.href, environment)).resolves.toBeNull();
	});

	it("rejects additional query fields on an otherwise valid callback", async () => {
		const url = await validCallbackUrl();
		url.searchParams.set("taskId", "untrusted-task");

		await expect(verifySeeapiVideoCallbackUrl(url.href, environment)).resolves.toBeNull();
	});

	it.each(["generation", "attempt", "proof"])("rejects missing %s", async (parameter) => {
		const url = await validCallbackUrl();
		url.searchParams.delete(parameter);

		await expect(verifySeeapiVideoCallbackUrl(url.href, environment)).resolves.toBeNull();
	});

	it.each(["generation", "attempt", "proof"])(
		"rejects duplicate %s even with identical values",
		async (parameter) => {
			const url = await validCallbackUrl();
			url.searchParams.append(parameter, url.searchParams.get(parameter)!);

			await expect(verifySeeapiVideoCallbackUrl(url.href, environment)).resolves.toBeNull();
		},
	);

	it.each(["", "a/b", "a b", "a.b", "中文", "a".repeat(161)])(
		"rejects an invalid asset ID %j before signing",
		async (assetId) => {
			await expect(
				createSeeapiVideoCallbackUrl({ ...identity, assetId }, environment),
			).rejects.toThrow();
		},
	);

	it.each([undefined, null, 42])(
		"rejects a non-string asset ID %j before signing",
		async (assetId) => {
			await expect(
				createSeeapiVideoCallbackUrl({ ...identity, assetId: assetId as never }, environment),
			).rejects.toThrow();
		},
	);

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN])(
		"rejects an invalid generation or attempt %s before signing",
		async (value) => {
			await expect(
				createSeeapiVideoCallbackUrl({ ...identity, generation: value }, environment),
			).rejects.toThrow();
			await expect(
				createSeeapiVideoCallbackUrl({ ...identity, attemptNumber: value }, environment),
			).rejects.toThrow();
		},
	);

	it.each(["", "0", "-1", "1.5", "9007199254740992", "Infinity", "NaN"])(
		"rejects invalid numeric callback parameters %j",
		async (value) => {
			for (const parameter of ["generation", "attempt"]) {
				const url = await validCallbackUrl();
				url.searchParams.set(parameter, value);

				await expect(verifySeeapiVideoCallbackUrl(url.href, environment)).resolves.toBeNull();
			}
		},
	);

	it.each([
		"http://video.example.com",
		"https://localhost",
		"https://127.0.0.1",
		"https://[::1]",
		"https://user:password@video.example.com",
		"https://video.example.com/prefix",
		"https://video.example.com?redirect=other",
		"https://video.example.com#fragment",
		"not a URL",
	])("rejects an unsafe callback base %s", async (base) => {
		const env = { ...environment, VIDEO_V1_CALLBACK_BASE_URL: base };
		const url = await validCallbackUrl();

		await expect(createSeeapiVideoCallbackUrl(identity, env)).rejects.toThrow();
		await expect(verifySeeapiVideoCallbackUrl(url.href, env)).resolves.toBeNull();
	});

	it("rejects configuration pointing callbacks at a different application origin", async () => {
		const env = {
			...environment,
			VIDEO_V1_CALLBACK_BASE_URL: "https://different.example.com",
		};
		const url = await validCallbackUrl();

		await expect(createSeeapiVideoCallbackUrl(identity, env)).rejects.toThrow();
		await expect(verifySeeapiVideoCallbackUrl(url.href, env)).resolves.toBeNull();
	});

	it.each([
		[
			"foreign host",
			(url: URL) => {
				url.hostname = "different.example.com";
			},
		],
		[
			"foreign port",
			(url: URL) => {
				url.port = "444";
			},
		],
		[
			"HTTP",
			(url: URL) => {
				url.protocol = "http:";
			},
		],
		[
			"credentials",
			(url: URL) => {
				url.username = "user";
			},
		],
		[
			"other webhook route",
			(url: URL) => {
				url.pathname = "/api/webhooks/video-v1/other/video_asset-123";
			},
		],
	] as const)("rejects a signed callback URL with %s", async (_name, mutate) => {
		const url = await validCallbackUrl();
		mutate(url);

		await expect(verifySeeapiVideoCallbackUrl(url.href, environment)).resolves.toBeNull();
	});

	it.each(["", "not a URL", "/api/webhooks/video-v1/seeapi/video_asset-123"])(
		"rejects malformed or relative callback URLs %j",
		async (url) => {
			await expect(verifySeeapiVideoCallbackUrl(url, environment)).resolves.toBeNull();
		},
	);

	it.each([
		["missing secret", { VIDEO_SEEAPI_CALLBACK_SECRET: undefined }],
		["short secret", { VIDEO_SEEAPI_CALLBACK_SECRET: "short-secret" }],
		["missing signing keys", { SEEAPI_WEBHOOK_SIGNING_KEYS: undefined }],
		["malformed signing keys", { SEEAPI_WEBHOOK_SIGNING_KEYS: "invalid JSON" }],
		["empty signing keys", { SEEAPI_WEBHOOK_SIGNING_KEYS: "{}" }],
		[
			"invalid signing key",
			{
				SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({
					invalid: "whsec_local-test-seeapi-signing-key",
				}),
			},
		],
		["missing origin", { VIDEO_V1_CALLBACK_BASE_URL: undefined, NEXT_PUBLIC_SAAS_URL: undefined }],
	] as const)("fails closed for %s", async (_name, override) => {
		const env = { ...environment, ...override };
		const url = await validCallbackUrl();

		await expect(createSeeapiVideoCallbackUrl(identity, env)).rejects.toThrow();
		await expect(verifySeeapiVideoCallbackUrl(url.href, env)).resolves.toBeNull();
	});
});
