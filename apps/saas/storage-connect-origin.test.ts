import { describe, expect, it } from "vitest";

import {
	resolveMediaCspTransportPolicy,
	resolveStorageConnectOrigin,
} from "./storage-connect-origin";

const localProductionE2E = {
	NODE_ENV: "production",
	E2E_USE_PRODUCTION_BUILD: "true",
	E2E_TEST_MEDIA_ADAPTERS: "true",
	E2E_RUN_ID: "media-e2e-123",
	DATABASE_URL: "postgresql://media:media@127.0.0.1:55432/media_e2e_testing",
	TEST_DATABASE_URL: "postgresql://media:media@127.0.0.1:55432/media_e2e_testing",
	NEXT_PUBLIC_SAAS_URL: "http://localhost:3000",
	MEDIA_PROVIDER_ADAPTER: "mock",
	MEDIA_SAFETY_ADAPTER: "test",
	MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true",
};

describe("media CSP transport policy", () => {
	it("keeps local production-build avatar redirects on the HTTP MinIO transport", () => {
		expect(
			resolveMediaCspTransportPolicy({
				...localProductionE2E,
				S3_ENDPOINT: "http://127.0.0.1:9000",
			}),
		).toEqual({ storageConnectSource: "http://127.0.0.1:9000", upgradeInsecureRequests: false });
	});

	it("keeps ordinary production connections on HTTPS", () => {
		expect(
			resolveMediaCspTransportPolicy({
				NODE_ENV: "production",
				S3_ENDPOINT: "https://storage.example.com",
			}),
		).toEqual({
			storageConnectSource: "https://storage.example.com",
			upgradeInsecureRequests: true,
		});
	});

	it.each(Object.keys(localProductionE2E).filter((key) => key !== "NODE_ENV"))(
		"keeps production HTTPS enforcement without %s",
		(key) => {
			expect(
				resolveMediaCspTransportPolicy({
					...localProductionE2E,
					[key]: undefined,
					S3_ENDPOINT: "http://127.0.0.1:9000",
				}),
			).toEqual({ storageConnectSource: null, upgradeInsecureRequests: true });
		},
	);

	it.each([
		{ NEXT_PUBLIC_SAAS_URL: "https://ezimageai.com" },
		{ E2E_RUN_ID: "invalid/run" },
		{ MEDIA_PROVIDER_ADAPTER: "kie" },
		{ TEST_DATABASE_URL: "postgresql://media:media@127.0.0.1:55432/different_test" },
		{
			DATABASE_URL: "postgresql://media:media@remote.example.test/media_e2e_testing",
			TEST_DATABASE_URL: "postgresql://media:media@remote.example.test/media_e2e_testing",
		},
		{
			DATABASE_URL:
				"postgresql://media:media@127.0.0.1:55432/media_e2e_testing?host=remote.example.test",
			TEST_DATABASE_URL:
				"postgresql://media:media@127.0.0.1:55432/media_e2e_testing?host=remote.example.test",
		},
	])("keeps production HTTPS enforcement for an invalid E2E identity: %j", (overrides) => {
		expect(
			resolveMediaCspTransportPolicy({
				...localProductionE2E,
				...overrides,
				S3_ENDPOINT: "http://127.0.0.1:9000",
			}),
		).toEqual({ storageConnectSource: null, upgradeInsecureRequests: true });
	});

	it("does not allow a non-loopback HTTP storage origin inside local E2E", () => {
		expect(
			resolveMediaCspTransportPolicy({
				...localProductionE2E,
				S3_ENDPOINT: "http://storage.example.com",
			}),
		).toEqual({ storageConnectSource: null, upgradeInsecureRequests: false });
	});
});

describe("resolveStorageConnectOrigin", () => {
	it("returns a normalized HTTPS origin without its path", () => {
		expect(
			resolveStorageConnectOrigin("https://s3.example.com/uploads/object?signature=secret", {
				allowLoopbackHttp: false,
			}),
		).toBe("https://s3.example.com");
	});

	it.each(["http://localhost:9000/media", "http://127.0.0.1:9000", "http://[::1]:9000"])(
		"allows the loopback HTTP origin %s outside production",
		(value) => {
			expect(resolveStorageConnectOrigin(value, { allowLoopbackHttp: true })).toBe(
				new URL(value).origin,
			);
		},
	);

	it("rejects loopback HTTP unless the caller explicitly enables local development or E2E", () => {
		expect(
			resolveStorageConnectOrigin("http://127.0.0.1:9000/media", { allowLoopbackHttp: false }),
		).toBeNull();
	});

	it("rejects non-loopback HTTP in every environment", () => {
		expect(
			resolveStorageConnectOrigin("http://evil.example.com/media", { allowLoopbackHttp: true }),
		).toBeNull();
	});

	it.each(["javascript:alert(1)", "ftp://s3.example.com/media"])(
		"rejects the unsupported URL %s",
		(value) => {
			expect(resolveStorageConnectOrigin(value, { allowLoopbackHttp: true })).toBeNull();
		},
	);

	it.each(["https://user@example.com", "https://user:pass@example.com"])(
		"rejects a URL containing credentials: %s",
		(value) => {
			expect(resolveStorageConnectOrigin(value, { allowLoopbackHttp: true })).toBeNull();
		},
	);

	it.each([undefined, "", "not a URL"])("rejects an absent or invalid value: %s", (value) => {
		expect(resolveStorageConnectOrigin(value, { allowLoopbackHttp: true })).toBeNull();
	});
});
