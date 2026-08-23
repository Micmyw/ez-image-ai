import { describe, expect, it } from "vitest";

import { resolveStorageConnectOrigin } from "./storage-connect-origin";

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
